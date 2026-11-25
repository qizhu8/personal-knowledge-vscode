import { spawn } from "node:child_process";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { installedNativeNotePaperBasicUiProgram } from "./installed-native-note-paper-basic-ui.mjs";

const prefix = "native-research-basic";
const fail = code => Object.assign(new Error(code), { code });
// Reuse the rendered descriptor/ACK mechanics, not any Note/Paper stages or evidence.
export const installedNativeResearchBasicUiProgram = installedNativeNotePaperBasicUiProgram
  .replaceAll("native-note-paper-basic", prefix)
  .replaceAll("Note/Paper basic", "Research basic")
  .replaceAll("basicprivatesentinel", "researchprivatesentinel")
  .replace(/allowed=\{[^\n]+\}/, 'allowed={"get_research","list_research","search_research","paper_graph"}');

async function driver(root, runId, timeoutMs) {
  const stat = await lstat(root);
  if (!isAbsolute(root) || resolve(root) !== root || await realpath(root) !== root
    || !/^\.installed-host-[a-f0-9-]{36}$/.test(basename(root)) || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.uid !== process.getuid() || stat.mode & 0o077 || !/^[a-f0-9-]{36}$/.test(runId)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw fail("INSTALLED_RESEARCH_PRIVATE_DRIVER_REQUIRED");
}
async function publish(root, name, value) {
  await writeFile(join(root, `${name}.next`), JSON.stringify(value), { mode: 0o600 });
  await rename(join(root, `${name}.next`), join(root, name));
}
export async function readInstalledNativeResearchBasicObserverStatus(root, runId) {
  try {
    const value = JSON.parse(await readFile(join(root, `${prefix}-ui-status.json`)));
    if (value.schema !== "pkm.installed-native-research-basic-ui-status/v1" || value.runId !== runId)
      throw fail("INSTALLED_RESEARCH_OBSERVER_BINDING_REQUIRED");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { runId, phase: "not-recorded", failed: false };
    throw error;
  }
}
export async function createInstalledNativeResearchBasicStageProtocol({ root, runId, timeoutMs, stages, check = () => {} }) {
  await driver(root, runId, timeoutMs);
  if (!Array.isArray(stages) || !stages.length || new Set(stages).size !== stages.length
    || stages.some(stage => !/^native-research-basic-[a-z-]+$/.test(stage) || stage === `${prefix}-complete`))
    throw fail("INSTALLED_RESEARCH_STAGE_PROTOCOL_REQUIRED");
  let active, index = 0, failed = false;
  const failure = async error => {
    failed = true;
    await publish(root, `${prefix}-failure.json`, {
      schema: "pkm.installed-native-research-basic-failure/v1", runId, stage: active ?? null,
      error: String(error), code: error.code ?? null,
      observer: await readInstalledNativeResearchBasicObserverStatus(root, runId).catch(error => ({ error: String(error) })),
    });
  };
  return {
    async begin(stage) {
      if (failed || active || stage !== stages[index]) throw fail("INSTALLED_RESEARCH_STAGE_PENDING_ACK");
      await check(); active = stage;
      await publish(root, `${prefix}-ui-phase.json`, { runId, stage, phase: "work-started" });
      await publish(root, `${prefix}-ui-next.json`, { runId, stage });
      await publish(root, "progress.json", { runId, stage });
    },
    async complete(stage) {
      if (failed || stage !== active) throw fail("INSTALLED_RESEARCH_STAGE_BINDING_REQUIRED");
      try {
        await check();
        await publish(root, `${prefix}-ui-phase.json`, { runId, stage, phase: "work-complete" });
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
          await check();
          if ((await readInstalledNativeResearchBasicObserverStatus(root, runId)).failed)
            throw fail("INSTALLED_RESEARCH_OBSERVER_FAILED");
          try {
            const ack = JSON.parse(await readFile(join(root, `${prefix}-ui-ack-${stage}.json`)));
            if (ack.schema !== "pkm.installed-native-research-basic-ui-ack/v1" || ack.runId !== runId
              || ack.stage !== stage || ack.phase !== "complete" || ack.noUnexpectedModal !== true)
              throw fail("INSTALLED_RESEARCH_ACK_BINDING_MISMATCH");
            active = undefined; index++; return ack;
          } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw fail("INSTALLED_RESEARCH_ACK_TIMEOUT");
      } catch (error) { await failure(error); throw error; }
    },
    async finish() {
      if (failed || active || index !== stages.length) throw fail("INSTALLED_RESEARCH_STAGE_PENDING_ACK");
      const stage = `${prefix}-complete`;
      await publish(root, `${prefix}-ui-next.json`, { runId, stage });
      await publish(root, "progress.json", { runId, stage });
    },
    fail: failure,
  };
}
export async function startInstalledNativeResearchBasicUi({ root, runId, python, env, port, timeoutMs = 120000 }) {
  await driver(root, runId, timeoutMs);
  if (!isAbsolute(python ?? "") || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw fail("INSTALLED_RESEARCH_PRIVATE_UI_REQUIRED");
  const child = spawn(python, ["-B", "-c", installedNativeResearchBasicUiProgram, JSON.stringify({ root, runId, port, timeoutMs })],
    { env, stdio: "inherit" });
  let error;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Research observer exited ${code}/${signal}`)));
  });
  void done.catch(value => { error = value; });
  const ready = (async () => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (error) throw error;
      try {
        const value = JSON.parse(await readFile(join(root, `${prefix}-ui-ready.json`)));
        if (value.runId !== runId || value.ready !== true || value.actualRenderedDom !== true)
          throw fail("INSTALLED_RESEARCH_READY_BINDING_REQUIRED");
        return value;
      } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw fail("INSTALLED_RESEARCH_UI_READY_TIMEOUT");
  })();
  void ready.catch(() => {});
  return { ready, done, get error() { return error; }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await ended; } finally { clearTimeout(timer); }
  } };
}
