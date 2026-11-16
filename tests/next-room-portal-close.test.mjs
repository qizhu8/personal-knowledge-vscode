import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const project = path.resolve(new URL("..", import.meta.url).pathname);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 4000;
  while (Date.now() < end) { if (check()) return; await wait(25); }
  throw new Error("Portal cancellation was not observed.");
}

test("Portal owner shutdown covers admitted remote commands without a local Hub", async t => {
  const directory = path.join(project, ".migration-test-work", `portal-close-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
  fs.symlinkSync(path.join(project, "legacy/node_modules"), path.join(directory, "node_modules"), "dir");
  const bundle = path.join(directory, "native.mjs");
  require("esbuild").buildSync({ stdin: { contents: `
    export {createNextRoomUiHub} from "./src/next-room-ui-hub";`, resolveDir: project },
    bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle, logLevel: "silent" });
  const native = await import(pathToFileURL(bundle));
  let originalCommands;
  const loadOriginalCommands = () => {
    if (originalCommands) return originalCommands;
    const original = process.env.PKM_LEGACY_VSIX || path.join(project, "legacy/personal-knowledge-4.0.22.vsix");
    assert(fs.existsSync(original), "Set PKM_LEGACY_VSIX to the authorized original 4.0.22 VSIX (SHA-256 1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27).");
    assert.equal(createHash("sha256").update(fs.readFileSync(original)).digest("hex"),
      "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27");
    const unpack = path.join(directory, "original");
    execFileSync("unzip", ["-q", original, "extension/dist/*", "-d", unpack]);
    fs.writeFileSync(path.join(unpack, "package.json"), '{"type":"commonjs"}');
    return originalCommands = require(path.join(unpack, "extension/dist/chatroom/portal-command.js"));
  };
  const workspaceId = randomUUID();
  const storage = { workspaceRoot: () => directory, async workspaceId() { return workspaceId; }, assertWorkspaceLease() {} };
  const hub = (assertAuthority, executors) => native.createNextRoomUiHub({
    storage, workspaceId, qualification: "new-next-workspace", assertAuthority,
    credentials: {}, retained: {}, portal: executors,
  });
  const request = () => {
    const requestId = randomUUID();
    return { root: directory, contextId: randomUUID(), operation: "command", pairId: randomUUID(), peerId: randomUUID(),
      detail: { requestId, command: { program: process.execPath, arguments: [] }, defaultCwd: directory } };
  };
  for (const cause of ["owner-revoked", "owner-stop"]) {
    await t.test(`${cause} aborts the original supervised process and retains its receipt`, async () => {
      const commandModule = loadOriginalCommands();
      let live = true, executionSignal, processResult;
      const started = path.join(directory, `${cause}.started`), effect = path.join(directory, `${cause}.late-effect`);
      const current = hub(() => { if (!live) throw new Error("Owner revoked."); }, {
        async authorize() { return true; },
        async executeCommand(input) {
          executionSignal = input.signal;
          processResult = await commandModule.executePortalCommand(path.join(directory, "private-processes", input.contextId),
            `${input.pairId}:${input.requestId}`, input.command, input.defaultCwd, input.signal);
          return processResult;
        },
      });
      assert.equal(current.isRunning, false, "Accepting an external link need not start a local Hub.");
      const input = request();
      input.detail.command = commandModule.parsePortalCommand({ program: process.execPath, arguments: ["-e",
        `require('fs').writeFileSync(${JSON.stringify(started)},'started');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(effect)},'late'),30000);`],
        timeoutSeconds: 45 });
      const caller = new AbortController();
      let pending;
      try {
        await current.portalAuthority.authorize(input);
        pending = current.portalAuthority.executeCommand({ ...input, ...input.detail, signal: caller.signal });
        pending.catch(() => {});
        await until(() => fs.existsSync(started));
        if (cause === "owner-stop") await current.stop(); else live = false;
        await until(() => executionSignal.aborted);
        await assert.rejects(pending, /revoked|stopped|lifecycle/i);
        assert.equal(processResult.state, "cancelled");
        assert.equal(fs.existsSync(effect), false);
        const receipts = path.join(directory, "private-processes", input.contextId);
        assert(fs.existsSync(receipts), "Cancellation must preserve original supervisor receipts, not relaunch.");
      } finally {
        caller.abort();
        await pending?.catch(() => {});
        await current.stop();
      }
    });
  }
  await t.test("shutdown during owner approval cannot mint a grant for the prior lifecycle", async () => {
    let finishApproval;
    const current = hub(() => {}, { authorize: () => new Promise(resolve => { finishApproval = resolve; }),
      async executeCommand() { assert.fail("Stale approval must not execute."); } });
    const input = request(), pending = current.portalAuthority.authorize(input);
    pending.catch(() => {});
    await until(() => !!finishApproval);
    await current.stop();
    finishApproval(true);
    await assert.rejects(pending, /lifecycle|stopped/i);
  });
  await t.test("shutdown consumes unused one-use grants without permanently disabling a live owner", async () => {
    let runs = 0;
    const current = hub(() => {}, { async authorize() { return true; }, async executeCommand() { runs++; return "fresh"; } });
    const input = request();
    await current.portalAuthority.authorize(input);
    await current.stop();
    await assert.rejects(current.portalAuthority.executeCommand({ ...input, ...input.detail,
      signal: new AbortController().signal }), /one-use|stopped|lifecycle/i);
    assert.equal(runs, 0);
    const fresh = request();
    await current.portalAuthority.authorize(fresh);
    assert.equal(await current.portalAuthority.executeCommand({ ...fresh, ...fresh.detail,
      signal: new AbortController().signal }), "fresh");
    assert.equal(runs, 1);
    await current.stop();
  });
});
