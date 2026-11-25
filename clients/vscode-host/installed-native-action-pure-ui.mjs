import { spawn } from "node:child_process";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { installedNativeNotePaperBasicUiProgram } from "./installed-native-note-paper-basic-ui.mjs";

const prefix = "native-action-pure";
const fail = code => Object.assign(new Error(code), { code });
export const installedNativeActionPureUiProgram = installedNativeNotePaperBasicUiProgram
  .replaceAll("native-note-paper-basic", prefix)
  .replaceAll("Note/Paper basic", "Action pure")
  .replace("import hashlib,json,re,sys,time", "import hashlib,json,os,re,sys,time\nos.umask(0o077)")
  .replace(/allowed=\{[^\n]+\}/, `allowed={"action_templates","action_definition_check","action_graph_check","action_capabilities"}
 check(len(c["publicContracts"])==4 and all(item["readOnly"] is True for item in c["publicContracts"]),"Exact readonly Original catalogue required")
 check(all(step.get("noReview") is True and not step.get("publicChoice") for step in c["stages"]),"Every Action pure stage must be no-review")`);

async function driver(root, runId, timeoutMs) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !/^[a-f0-9-]{36}$/.test(runId)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw fail("INSTALLED_ACTION_PURE_PRIVATE_DRIVER_REQUIRED");
}
async function publish(root, name, value) {
  await writeFile(join(root, `${name}.next`), JSON.stringify(value), { mode: 0o600 });
  await rename(join(root, `${name}.next`), join(root, name));
}
export async function readInstalledNativeActionPureObserverStatus(root, runId) {
  try {
    const value = JSON.parse(await readFile(join(root, `${prefix}-ui-status.json`)));
    if (value.schema !== "pkm.installed-native-action-pure-ui-status/v1" || value.runId !== runId)
      throw fail("INSTALLED_ACTION_PURE_OBSERVER_BINDING_REQUIRED");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { runId, phase: "not-recorded", failed: false };
    throw error;
  }
}
export async function createInstalledNativeActionPureStageProtocol({ root, runId, timeoutMs, stages, check = () => {} }) {
  await driver(root, runId, timeoutMs);
  if (!Array.isArray(stages) || !stages.length || new Set(stages).size !== stages.length
    || stages.some(stage => !/^native-action-pure-[a-z-]+$/.test(stage) || stage === `${prefix}-complete`))
    throw fail("INSTALLED_ACTION_PURE_STAGE_PROTOCOL_REQUIRED");
  let active, index = 0, failed = false;
  const failure = async error => {
    failed = true;
    await publish(root, `${prefix}-failure.json`, {
      schema: "pkm.installed-native-action-pure-failure/v1", runId, stage: active ?? null,
      error: String(error), code: error.code ?? null,
      observer: await readInstalledNativeActionPureObserverStatus(root, runId).catch(error => ({ error: String(error) })),
    });
  };
  return {
    async begin(stage) {
      if (failed || active || stage !== stages[index]) throw fail("INSTALLED_ACTION_PURE_STAGE_PENDING_ACK");
      await check(); active = stage;
      await publish(root, `${prefix}-ui-phase.json`, { runId, stage, phase: "work-started" });
      await publish(root, `${prefix}-ui-next.json`, { runId, stage });
      await publish(root, "progress.json", { runId, stage });
    },
    async complete(stage) {
      if (failed || stage !== active) throw fail("INSTALLED_ACTION_PURE_STAGE_BINDING_REQUIRED");
      try {
        await check();
        await publish(root, `${prefix}-ui-phase.json`, { runId, stage, phase: "work-complete" });
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
          await check();
          if ((await readInstalledNativeActionPureObserverStatus(root, runId)).failed)
            throw fail("INSTALLED_ACTION_PURE_OBSERVER_FAILED");
          try {
            const ack = JSON.parse(await readFile(join(root, `${prefix}-ui-ack-${stage}.json`)));
            if (ack.schema !== "pkm.installed-native-action-pure-ui-ack/v1" || ack.runId !== runId
              || ack.stage !== stage || ack.phase !== "complete" || ack.noUnexpectedModal !== true)
              throw fail("INSTALLED_ACTION_PURE_ACK_BINDING_MISMATCH");
            active = undefined; index++; return ack;
          } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw fail("INSTALLED_ACTION_PURE_ACK_TIMEOUT");
      } catch (error) { await failure(error); throw error; }
    },
    async finish() {
      if (failed || active || index !== stages.length) throw fail("INSTALLED_ACTION_PURE_STAGE_PENDING_ACK");
      const stage = `${prefix}-complete`;
      await publish(root, `${prefix}-ui-next.json`, { runId, stage });
      await publish(root, "progress.json", { runId, stage });
    },
    fail: failure,
  };
}
export async function startInstalledNativeActionPureUi({ root, runId, python, env, port, timeoutMs = 120000 }) {
  await driver(root, runId, timeoutMs);
  if (!isAbsolute(python ?? "") || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw fail("INSTALLED_ACTION_PURE_PRIVATE_UI_REQUIRED");
  const child = spawn(python, ["-B", "-c", installedNativeActionPureUiProgram, JSON.stringify({ root, runId, port, timeoutMs })],
    { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Action pure observer exited ${code}/${signal}`)));
  });
  void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (error) throw error;
      try {
        const value = JSON.parse(await readFile(join(root, `${prefix}-ui-ready.json`)));
        if (value.runId !== runId || value.ready !== true || value.actualRenderedDom !== true)
          throw fail("INSTALLED_ACTION_PURE_READY_BINDING_REQUIRED");
        return value;
      } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw fail("INSTALLED_ACTION_PURE_UI_READY_TIMEOUT");
  })();
  void ready.catch(() => {});
  return { ready, done, get error() { return error; }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  } };
}
