import { connect } from "node:net";

const name = process.env.PKM_NEXT_MCP_BROKER, token = process.env.PKM_NEXT_MCP_BROKER_TOKEN;
if (process.platform !== "linux" || !name || !/^pkm-next-[a-f0-9]{48}$/.test(name)
  || !token || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Missing private Next MCP broker binding.");
delete process.env.PKM_NEXT_MCP_BROKER;
delete process.env.PKM_NEXT_MCP_BROKER_TOKEN;

const socket = connect(`\0${name}`);
let reply = Buffer.alloc(0), ready = false;
socket.setTimeout(5000, () => socket.destroy(new Error("Next MCP broker handshake timed out.")));
socket.on("connect", () => { socket.write(`${token}\n`); });
socket.on("data", bytes => {
  if (ready) return;
  reply = Buffer.concat([reply, typeof bytes === "string" ? Buffer.from(bytes) : bytes]);
  const end = reply.indexOf(10);
  if (end < 0 && reply.length <= 16) return;
  if (end < 0 || reply.subarray(0, end).toString() !== "OK") return socket.destroy(new Error("Next MCP broker refused admission."));
  ready = true;
  socket.setTimeout(0);
  const rest = reply.subarray(end + 1);
  if (rest.length) process.stdout.write(rest);
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
});
socket.on("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
socket.on("close", hadError => {
  if (hadError || !ready) process.exitCode = 1;
  process.stdin.unpipe(socket);
  process.stdin.pause();
});
