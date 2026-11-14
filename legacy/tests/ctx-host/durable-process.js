const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function checkDurableProcess(extension, root, restart) {
  const runtime = require(path.join(extension.extensionPath, "dist/chat/chat-process-runtime"));
  const evidence = path.join(root, "durable-evidence");
  const workspace = path.join(root, "workspace");
  const release = path.join(workspace, "durable-release");
  const effect = path.join(workspace, "durable-effect");
  const savedFile = path.join(root, "durable-process.json");
  const spec = { program:process.env.PKM_CTX_NODE, arguments:["-e", `
    const fs = require("node:fs");
    fs.appendFileSync(${JSON.stringify(effect)}, "started\\n");
    console.log("DURABLE_READY");
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(release)})) return;
      clearInterval(timer);
      console.log("DURABLE_HOST_RESTART_OK");
    }, 100);
  `], cwd:workspace, timeoutSeconds:120 };
  fs.mkdirSync(evidence, { recursive:true });
  let record = await runtime.launchChatProcess(evidence, "installed-host-durable", spec);
  const waitFor = async predicate => {
    const deadline = Date.now() + 15000;
    do {
      record = runtime.getChatProcess(evidence, record.handle);
      if (predicate(record)) return record;
      assert(["launching", "running"].includes(record.state), JSON.stringify(record));
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(`Installed supervisor failed to reach expected state: ${JSON.stringify(record)}`);
  };
  try {
    if (!restart) {
      await waitFor(value => value.state === "running" && value.stdoutBytes > 0);
      assert.equal(fs.readFileSync(effect, "utf8"), "started\n");
      const saved = { hostPid:process.pid, handle:record.handle, runnerPid:record.runnerPid, childPid:record.childPid };
      fs.writeFileSync(savedFile, JSON.stringify(saved));
      return { ...saved, state:record.state };
    }
    const saved = JSON.parse(fs.readFileSync(savedFile, "utf8"));
    assert.notEqual(process.pid, saved.hostPid);
    assert.equal(record.handle, saved.handle);
    assert.equal(record.runnerPid, saved.runnerPid);
    assert.equal(record.childPid, saved.childPid);
    assert.equal(record.state, "running");
    assert.equal(fs.readFileSync(effect, "utf8"), "started\n", "restart must not repeat the side effect");
    fs.writeFileSync(release, "release original invocation");
    await waitFor(value => value.state === "complete");
    const output = runtime.readChatProcessOutput(evidence, record.handle, "stdout", 0, 12000);
    assert.match(output.text, /DURABLE_HOST_RESTART_OK/);
    assert.equal(record.exitCode, 0);
    return { ...saved, state:record.state, recovered:true };
  } catch (error) {
    runtime.cancelChatProcess(evidence, record.handle);
    throw error;
  }
}

module.exports = { checkDurableProcess };
