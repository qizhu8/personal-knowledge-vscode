import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { installedNativeKnowledgeMoveUiProgram } from "./installed-native-knowledge-move-ui.mjs";
import { installedKnowledgeMoveFixtureUtilities as u } from "./installed-native-knowledge-move.mjs";

// Public dialogs only. Stored private link text is allowed; private bytes/referrer content are never public.
export const installedNativePrivateInplaceUiProgram = installedNativeKnowledgeMoveUiProgram
  .replaceAll("native-knowledge-move", "native-private-inplace")
  .replace('len(c["steps"])==6', 'len(c["steps"])==11')
  .replace("bounded six mutation dialogs", "bounded eleven public mutation dialogs")
  .replace('check("Private marker" not in text and "Private/Secret" not in text,"Private referrers leaked into public approval")',
    'check("SYNTHETIC_PRIVATE_RESOURCE_" not in text and "SYNTHETIC_PRIVATE_REFERRER" not in text and "PRIVATE_INPLACE_UNREVIEWED_BYTES" not in text,"Private plaintext leaked into public approval")')
  .replace("proof.update(passed=True,actualRenderedDom=True,attachmentRevoked=False)",
    "proof.update(passed=True,actualRenderedDom=True,attachmentRevoked=False,observedPrivateResourceDialogs=0)");

export async function startInstalledNativePrivateInplaceUi({ root, python, env, port, runId, timeoutMs = 120000 }) {
  await u.privateDirectory(root, "PRIVATE_INPLACE_PRIVATE_DRIVER_REQUIRED");
  if (!/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !isAbsolute(python ?? "")
    || !/^[a-f0-9-]{36}$/.test(runId) || !Number.isSafeInteger(port) || port < 1 || port > 65535
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw Object.assign(new Error("PRIVATE_INPLACE_UI_PROFILE_REQUIRED"), { code: "PRIVATE_INPLACE_UI_PROFILE_REQUIRED" });
  const child = spawn(python, ["-B", "-c", installedNativePrivateInplaceUiProgram, JSON.stringify({ root, port, runId, timeoutMs })], { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) =>
    code === 0 ? resolve() : reject(new Error(`Private in-place UI exited ${code}/${signal}`))); });
  void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (error) throw error;
      try {
        const value = JSON.parse(await readFile(join(root, "native-private-inplace-ui-ready.json")));
        if (value.ready !== true || value.actualRenderedDom !== true || value.runId !== runId) throw new Error("Wrong private in-place observer readiness");
        return value;
      } catch (value) { if (value.code !== "ENOENT" && !(value instanceof SyntaxError)) throw value; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Private in-place observer startup timed out");
  })();
  void ready.catch(() => {});
  return { ready, done, get error() { return error; }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  } };
}
