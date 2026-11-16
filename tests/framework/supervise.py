"""Reap only this run's descendants before crash cleanup; never inspect host processes."""
import ctypes
import json
import os
import select
import signal
import subprocess
import sys
import time


def main():
    metadata = json.loads(sys.argv[1])
    libc = ctypes.CDLL(None, use_errno=True)

    def checked(result):
        if result < 0:
            raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
        return result

    def pidfd(pid):
        return checked(libc.syscall(434, pid, 0))

    def send(descriptor, signum):
        result = libc.syscall(424, descriptor, signum, None, 0)
        if result < 0 and ctypes.get_errno() != 3:
            checked(result)

    if os.uname().machine not in ("x86_64", "aarch64") or os.getuid() == 0:
        raise SystemExit("Supervised tests require a non-admin Linux user and supported pidfd ABI.")
    if os.getppid() != metadata["coordinatorPid"]:
        recovery = {**metadata, "records": [metadata["workspace"]],
                    "cause": "Coordinator terminated before supervisor initialization."}
        subprocess.run([sys.argv[2], metadata["recovery"]], input=json.dumps(recovery), text=True, check=True)
        raise SystemExit(1)
    parent_fd = pidfd(metadata["coordinatorPid"])
    completed, retain, stopping = False, False, False
    cause, deadline = None, None

    def stop(signum, _frame):
        nonlocal stopping, cause
        stopping = True
        cause = f"Coordinator received signal {signum}."

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(json.dumps({"type": "ready"}), flush=True)
    checked(libc.prctl(36, 1, 0, 0, 0))
    reader, writer = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(reader)
        checked(libc.prctl(1, signal.SIGKILL, 0, 0, 0))
        if select.select([parent_fd], [], [], 0)[0]:
            os._exit(1)
        os.close(parent_fd)
        os.set_inheritable(writer, True)
        os.environ["PKM_TEST_SUPERVISOR_FD"] = str(writer)
        os.execv(sys.argv[2], sys.argv[2:])
    os.close(writer)
    child_fd = pidfd(child)
    records = {metadata["workspace"]["directory"]: metadata["workspace"]}
    buffer = b""
    status = None
    while status is None:
        descriptors = [child_fd, parent_fd]
        if reader is not None:
            descriptors.append(reader)
        ready = select.select(descriptors, [], [], 0.1)[0]
        if parent_fd in ready:
            stopping = True
            cause = "Coordinator terminated before its run completed."
        if stopping and deadline is None:
            send(child_fd, signal.SIGTERM)
            deadline = time.monotonic() + 5
        if deadline is not None and time.monotonic() >= deadline:
            send(child_fd, signal.SIGKILL)
        if reader is not None and reader in ready:
            data = os.read(reader, 65536)
            if not data:
                if buffer:
                    raise RuntimeError("Incomplete supervisor registry message.")
                os.close(reader)
                reader = None
            else:
                buffer += data
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    message = json.loads(line)
                    if message["type"] == "workspace":
                        record = message["record"]
                        previous = records.get(record["directory"])
                        if previous is not None and previous != record:
                            raise RuntimeError("Supervisor workspace identity changed.")
                        records[record["directory"]] = record
                    elif message["type"] == "complete":
                        completed, retain = True, message["retain"]
                    elif message["type"] == "event" and message["event"]["type"] == "complete":
                        retain = retain or not message["event"]["cleaned"]
                if len(buffer) > 65536:
                    raise RuntimeError("Supervisor registry message exceeds its size limit.")
        if child_fd in ready and reader is None:
            _, status = os.waitpid(child, 0)
    os.close(child_fd)
    os.close(parent_fd)
    while True:
        try:
            os.waitpid(-1, 0)
        except ChildProcessError:
            break
    if not completed and not retain:
        recovery = {**metadata, "records": list(records.values()),
                    "cause": cause or "Test worker terminated without a final result."}
        result = subprocess.run([sys.argv[2], metadata["recovery"]],
                                input=json.dumps(recovery), text=True, check=False,
                                env={**os.environ, "PKM_TEST_SUPERVISOR_FD": ""})
        if result.returncode:
            raise SystemExit(result.returncode)
    if not completed or stopping:
        raise SystemExit(1)
    raise SystemExit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))


if __name__ == "__main__":
    main()
