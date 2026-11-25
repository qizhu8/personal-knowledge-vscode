import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { installedNativeKnowledgeMoveUiProgram } from "./installed-native-knowledge-move-ui.mjs";

export const installedNativeSharedLegacyAssetsMoveUiProgram = installedNativeKnowledgeMoveUiProgram
  .replaceAll("native-knowledge-move", "native-shared-legacy-assets-move")
  .replace('len(c["steps"])==6', 'len(c["steps"])==8').replace("bounded six mutation dialogs", "bounded eight mutation dialogs");
export async function startInstalledNativeSharedLegacyAssetsMoveUi({ root, python, env, port, runId, timeoutMs = 120000 }) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root))
    || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077
    || typeof python !== "string" || !isAbsolute(python) || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !/^[a-f0-9-]{36}$/.test(runId))
    throw Object.assign(new Error("INSTALLED_SHARED_LEGACY_PRIVATE_UI_REQUIRED"), { code: "INSTALLED_SHARED_LEGACY_PRIVATE_UI_REQUIRED" });
  const child = spawn(python, ["-B", "-c", installedNativeSharedLegacyAssetsMoveUiProgram, JSON.stringify({ root, port, runId, timeoutMs })],
    { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Shared legacy UI exited ${code}/${signal}`)));
  });
  void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (error) throw error;
      try {
        const value = JSON.parse(await readFile(join(root, "native-shared-legacy-assets-move-ui-ready.json")));
        if (value.ready !== true || value.runId !== runId || value.actualRenderedDom !== true) throw new Error("Wrong shared legacy observer readiness.");
        return value;
      } catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Shared legacy observer readiness timed out.");
  })();
  void ready.catch(() => {});
  return { done, ready, get error() { return error; }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  } };
}
