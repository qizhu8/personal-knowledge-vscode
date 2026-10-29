#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn, execFile } = require("child_process");
const { ProjectStore } = require("../dist/workflows/project-store");
const { projectCockpit, projectCockpits } = require("../dist/workflows/project-cockpit");
const { promoteChatProject, handleProjectCockpitRequest } = require("../dist/workflows/project-cockpit-host");

const repository = path.resolve(__dirname, "..");
const python = require("./dev-paths").testPython;
const directory = path.join(__dirname, ".project-python-work", crypto.randomUUID());
const root = path.join(directory, "store");
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
fs.mkdirSync(directory, { recursive: true });
const environment = { ...process.env, TMPDIR: directory, TEMP: directory, TMP: directory };
let fixtureProcess, stderr = "";

function api(method, params = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(python, [path.join(repository, "resources", "action_modules.py"), "--api", root],
      { timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: environment, windowsHide: true }, (error, stdout, errorOutput) => {
        if (error) return reject(Error(`Real Python ${method} failed: ${error.message}\n${errorOutput}`));
        try {
          const result = JSON.parse(stdout);
          assert.notStrictEqual(result.ok, false, result.error || `Python ${method} returned failure`);
          resolve(result);
        } catch (failure) { reject(failure); }
      });
    child.stdin.end(JSON.stringify({ method, params }));
  });
}

async function awaitState(runId, expected) {
  const deadline = Date.now() + 15000;
  let run;
  do {
    run = await api("run", { run_id: runId });
    if (run.state === expected && !(expected === "succeeded" && run.gc_state === "pending")) return run;
    if (["failed", "outcome_unknown", "cancelled"].includes(run.state)) throw Error(JSON.stringify(run));
    await sleep(50);
  } while (Date.now() < deadline);
  throw Error(`Real Run did not become ${expected}: ${JSON.stringify(run)}`);
}

(async () => {
  try {
    // Reuse only the existing isolated qualified core.checkpoint fixture, not its test suite.
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    fixtureProcess = spawn(python, [path.join(repository, "tests", "test-action-recovery-e2e.py"), "--serve", root, String(port)],
      { stdio: ["ignore", "ignore", "pipe"], env: environment, windowsHide: true });
    fixtureProcess.stderr.on("data", value => { stderr = (stderr + value).slice(-8000); });
    let spawnError;
    fixtureProcess.on("error", error => { spawnError = error; });
    const fixtureFile = path.join(directory, "fixture.json");
    const startupDeadline = Date.now() + 20000;
    while (!fs.existsSync(fixtureFile)) {
      if (spawnError || fixtureProcess.exitCode !== null) throw Error(`Fixture startup failed: ${spawnError || stderr}`);
      if (Date.now() >= startupDeadline) throw Error(`Fixture startup timed out: ${stderr}`);
      await sleep(50);
    }
    const definition = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
    assert.strictEqual(definition.implementations[0].steps[0].component, "core.checkpoint");
    const launched = await api("call", { action_id: definition.action_id, inputs: {},
      key: "project-original-run", content_hash: definition.content_hash });
    const runId = launched.run_id;
    assert(/^action_run_[0-9a-f]{32}$/.test(runId));
    const waiting = await awaitState(runId, "waiting");
    assert.strictEqual(waiting.userState, "Waiting");
    assert.strictEqual(waiting.execution.workerPid, null, "Checkpoint releases its real Python worker");
    assert.strictEqual(waiting.checkpoint.presentation, "json", "Generic checkpoint uses explicit JSON presentation");

    const store = new ProjectStore(path.join(root, ".pkm", "state"));
    const command = (operation, input) => ({ commandId: crypto.randomUUID(),
      fingerprint: JSON.stringify({ operation, input }), expectedStoreVersion: store.list().storeVersion });
    let confirmations = 0;
    const projectId = await promoteChatProject(store, { chatId: "chat_real_project_checkpoint", title: "Isolated recovery Chat" },
      async () => { confirmations++; return "Isolated recovery Chat"; }, command);
    const replies = [], actionCalls = [];
    const snapshot = async () => {
      const value = store.list();
      return { ...value, cockpits: projectCockpits(root, value.projects, value.collaborationTasks) };
    };
    const host = { store, root, command, snapshot, respond: message => replies.push(message),
      action: async (method, params) => { actionCalls.push({ method, params }); return api(method, params); },
      openSource() { throw Error("No external navigation in isolated cooperation case"); } };
    assert(await handleProjectCockpitRequest(host, { command: "projectLink", projectId, kind: "action-run", id: runId,
      expectedStoreVersion: store.list().storeVersion }));
    const project = () => store.list().projects.find(value => value.projectId === projectId);
    let cockpit = projectCockpit(root, project());
    assert.strictEqual(confirmations, 1);
    assert(project().links.some(link => link.kind === "chat" && link.id === "chat_real_project_checkpoint"));
    assert(cockpit.now.waiting.some(item => item.sourceId === runId && item.projection.state === "Waiting"));
    assert.strictEqual(cockpit.reviewInbox.length, 1);
    const item = cockpit.reviewInbox[0];
    assert.strictEqual(item.checkpoint.presentation, "json");
    assert.strictEqual(item.checkpoint.checkpoint_id, waiting.checkpoint.checkpoint_id);
    assert.deepStrictEqual(item.checkpoint.proposal, waiting.checkpoint.proposal);
    assert(cockpit.hasActiveRuns);
    assert(!JSON.stringify(cockpit).includes(waiting.checkpoint.resume_token), "Resume authority never enters Project snapshots");

    assert(await handleProjectCockpitRequest(host, { command: "projectCheckpoint", projectId, id: runId,
      checkpointId: item.checkpoint.checkpoint_id, proposalDigest: item.checkpoint.proposal_digest,
      eventKey: item.checkpoint.checkpoint_id, action: "answer", answer: '{"approved":true}' }));
    assert.deepStrictEqual(actionCalls.map(call => call.method), ["checkpoints", "respond_checkpoint"]);
    assert.strictEqual(actionCalls[1].params.resume_token, waiting.checkpoint.resume_token);
    assert.deepStrictEqual(actionCalls[1].params.answer, { approved: true });
    assert(replies.some(reply => reply.command === "projectCheckpointResult"));
    const completed = await awaitState(runId, "succeeded");
    assert.strictEqual(completed.run_id, runId, "Continuation finishes the original Run");
    assert.deepStrictEqual(completed.output, { value: { approved: true } });
    assert.strictEqual(completed.checkpoint.checkpoint_id, waiting.checkpoint.checkpoint_id);
    assert.strictEqual(completed.checkpoint.state, "resolved");
    assert.strictEqual(completed.execution.receipts.filter(receipt => receipt.operation === "dispatched").length, 2);
    cockpit = projectCockpit(root, project());
    assert(cockpit.items.some(value => value.sourceId === runId && value.kind === "action-run" && value.projection.state === "Completed"));
    assert.strictEqual(cockpit.now.waiting.length, 0);
    assert.strictEqual(cockpit.reviewInbox.length, 0);
    assert.strictEqual(cockpit.hasActiveRuns, false);
    assert(cockpit.decisions.some(value => value.checkpointId === completed.checkpoint.checkpoint_id && value.answer.approved));
    assert(!JSON.stringify(project()).includes(waiting.checkpoint.resume_token), "Project persistence contains links, not executor authority");
    assert.strictEqual(new ProjectStore(path.join(root, ".pkm", "state")).list().projects.find(value => value.projectId === projectId).links.length, 2);
    console.log("P2 real-Python cooperation passed: qualified core.checkpoint → original Run Waiting → production Chat promotion/Project link → exact production host answer through Python --api → same Run Completed in fresh Cockpit; explicit JSON presentation, private token and durable links verified.");
  } finally {
    if (fixtureProcess?.pid && fixtureProcess.exitCode === null) {
      fixtureProcess.kill("SIGTERM");
      await Promise.race([new Promise(resolve => fixtureProcess.once("exit", resolve)), sleep(5000)]);
      if (fixtureProcess.exitCode === null && fixtureProcess.signalCode === null) {
        fixtureProcess.kill("SIGKILL");
        await new Promise(resolve => fixtureProcess.once("exit", resolve));
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
    try { fs.rmdirSync(path.dirname(directory)); } catch {}
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
