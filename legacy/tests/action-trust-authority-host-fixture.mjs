import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { AutomaticActionTrustAuthority } from "../src/runtime/action-trust-authority.ts";

const storePath = resolve(process.argv[2]);
const python = process.env.PYTHON_EXECUTABLE;
const modulesPath = resolve(import.meta.dirname, "../resources/action_modules.py");
if (!python) throw new Error("PYTHON_EXECUTABLE is required.");
let trusted = true;
let effectConsentAllowed = false;

async function moduleRequest(method, params) {
  const child = spawn(python, [modulesPath, "--api", storePath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { if (stdout.length < 2 * 1024 * 1024) stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { if (stderr.length < 65536) stderr += chunk; });
  child.stdin.end(JSON.stringify({ method, params }));
  const [code] = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Action module request timed out.")); }, 60000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (exitCode, signal) => { clearTimeout(timer); resolve([exitCode, signal]); });
  });
  if (code !== 0) throw new Error(`Action module request failed (${code}): ${stderr}`);
  return JSON.parse(stdout);
}

const authority = new AutomaticActionTrustAuthority({
  storePath: () => storePath,
  isTrusted: () => trusted,
  enabled: () => true,
  async prepare(actionId, contentHash, proposalId, trustEpoch) {
    const prepared = await moduleRequest("qualification_prepare", {
      action_id: actionId, content_hash: contentHash, proposal_id: proposalId,
    });
    if (prepared.ok !== true || typeof prepared.attempt_id !== "string") {
      return { ok: false, state: "blocked", reason: prepared.error ?? "READINESS_FAILED" };
    }
    return moduleRequest("qualification_admit", { attempt_id: prepared.attempt_id, trust_epoch: trustEpoch });
  },
  async authorizeEffects() { return effectConsentAllowed; },
});
await authority.start();
console.log(JSON.stringify({ ready: authority.status().trusted, trustEpoch: authority.status().trustEpoch }));
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  for (const command of String(chunk).split(/\r?\n/)) {
    if (command.trim() === "revoke") trusted = false;
    if (command.trim() === "allow-effects") effectConsentAllowed = true;
    if (command.trim() === "deny-effects") effectConsentAllowed = false;
  }
});
process.once("SIGTERM", () => { void authority.dispose().then(() => process.exit(0)); });
