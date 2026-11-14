"use strict";
const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");

function create({ inputPath, inputBytes }) {
  const marker = "LEGACY_CHAT_CONTINUITY", observed = [];
  const digest = value => createHash("sha256").update(value).digest("hex");
  function handle(body, response) {
    const user = body.messages.filter(message => message.role === "user").map(message =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
    if (!user.includes(marker)) return false;
    const child = user.includes(`${marker}_CHILD`) && !user.includes(`${marker}_MANAGER`);
    const role = child ? "child" : "manager";
    const results = body.messages.filter(message => message.role === "tool" && message.tool_call_id?.startsWith(`continuity_${role}_`));
    const byName = name => results.find(message => message.tool_call_id.startsWith(`continuity_${role}_${name}_`));
    const read = byName("read_file");
    if (read) {
      const result = JSON.parse(read.content);
      assert.equal(result.content, inputBytes.toString("utf8"), "The real read_file tool must return the actual synthetic file bytes.");
      if (!observed.some(item => item.callId === read.tool_call_id))
        observed.push({ role, name: "read_file", callId: read.tool_call_id, sha256: digest(result.content) });
    }
    const completedChild = observed.find(item => item.role === "child" && item.name === "provider-final");
    const managerRead = observed.find(item => item.role === "manager" && item.name === "read_file");
    const woke = !child && completedChild && managerRead;
    let name, args, label;
    if (woke) {
      assert.equal(completedChild.sha256, managerRead.sha256, "The manager may finalize only after the actual independent worker read.");
    } else if (!child && !byName("session_info")) { name = "session_info"; args = {}; }
    else if (!child && !byName("record_harness")) {
      const info = JSON.parse(byName("session_info").content);
      assert.match(info.sessionId, /^agent_session_[a-f0-9]{32}$/);
      assert.equal(typeof info.inputId, "string");
      name = "record_harness";
      args = { kind: "task", goal: "Read the synthetic file in this managed Task and delegate one independent read.",
        sourceInputIds: [info.inputId], acceptance: ["Actual file bytes returned by manager and child tools"] };
    } else if (!read) { name = "read_file"; args = { path: inputPath, startLine: 1, endLine: 1 }; }
    else if (!child && !byName("spawn_workers")) {
      assert.equal(JSON.parse(byName("record_harness").content).ok, true);
      const spawn = { tasks: [{ title: "Synthetic original Chat worker",
        question: `${marker}_CHILD: Read ${inputPath} using read_file. Report the SHA256 of the actual returned content. Do not write, spawn, or retry.`,
        writeScope: [], resources: [] }] };
      if (body.tools.some(tool => tool.function?.name === "spawn_workers")) { name = "spawn_workers"; args = spawn; }
      else if (!byName("capabilities_search")) { name = "capabilities_search"; args = { query: "spawn_workers", limit: 3 }; }
      else {
        const found = JSON.parse(byName("capabilities_search").content).operations
          .find(operation => operation.id === "native.tool.spawn_workers" && operation.version === 1);
        assert(found, "The original enabled capability catalog must actually expose spawn_workers.");
        name = "capability_call"; label = "spawn_workers";
        args = { operation: found.id, version: found.version, arguments: spawn };
      }
    }
    let delta, finish;
    if (name) {
      assert(body.tools.some(tool => tool.function?.name === name), `Original UI did not advertise required ${name}.`);
      delta = { tool_calls: [{ index: 0, id: `continuity_${role}_${label || name}_${randomUUID()}`, type: "function",
        function: { name, arguments: JSON.stringify(args) } }] };
      finish = "tool_calls";
    } else {
      if (!child) assert(observed.some(item => item.role === "child"), "Do not fabricate a child result before its real tool call.");
      const actualSha256 = woke ? managerRead.sha256 : digest(JSON.parse(read.content).content);
      delta = { content: `${marker}_${child ? "CHILD" : "MANAGER"}_RESULT sha256:${actualSha256}` };
      finish = "stop";
      observed.push({ role, name: "provider-final", sha256: actualSha256 });
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
    return true;
  }
  return { handle, observed, marker, inputSha256: digest(inputBytes) };
}
module.exports = { create };
