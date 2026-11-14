const { test } = require("node:test");
const assert = require("node:assert/strict");
const { retrieveChatMemory, chatMemoryQuery } = require("../dist/chat/chat-memory");
const message = (id, content, role = "assistant") => ({ id, content, role, status:"complete", taskId:"task" });
const chat = messages => ({ id:"chat", sessionId:"task", includeHistory:true, createdAt:new Date().toISOString(), messages });

test("repeated older positive reports cannot crowd out the latest negative user constraint", () => {
  const history = chat([
    ...Array.from({ length:30 }, (_, index) => message(`old-${index}`, "Deployment approved: research AML GPU latency benchmark.")),
    message("correction", "Do NOT deploy AML.", "user"),
    message("other-evidence", "Retention verification remains open."),
  ]);
  const query = "research AML GPU latency benchmark deployment retention verification";
  const result = retrieveChatMemory(history, query);
  assert(result.some(item => item.messageId === "correction"));
  assert.equal(result.filter(item => item.messageId.startsWith("old-")).length, 1);
  assert(result.some(item => item.messageId === "other-evidence"));
  assert.equal(result.find(item => item.messageId.startsWith("old-")).messageId, "old-29");
  const terms = query.toLowerCase().split(" ");
  const oldRecall = history.messages.slice(0, 4);
  const coverage = items => terms.filter(term => items.some(item => item.content.toLowerCase().includes(term))).length;
  assert(coverage(result) > coverage(oldRecall), "Coverage must improve over repeated lexical top-k.");
});

test("deduplication does not merge failed outcomes with success or differently scoped tool arguments", () => {
  const toolMessage = (id, status, args) => ({ ...message(id, ""), toolCalls:[
    { id:`call-${id}`, name:"inspect", status, arguments:args, result:"AML result" },
  ] });
  const result = retrieveChatMemory(chat([
    toolMessage("old", "complete", '{"scope":"a"}'),
    toolMessage("new", "complete", '{"scope":"a"}'),
    toolMessage("failed", "failed", '{"scope":"a"}'),
    toolMessage("different", "complete", '{"scope":"b"}'),
  ]), "AML");
  assert.equal(result.length, 3);
  assert(result.some(item => item.messageId === "failed" && item.content.includes("status=failed")));
  assert(result.some(item => item.messageId === "different"));
  assert(result.some(item => item.messageId === "new"));
  assert(!result.some(item => item.messageId === "old"));
});

test("history exclusion is absolute and worker events do not become pinned user instructions", () => {
  const history = chat([
    message("instruction", "Do not deploy AML.", "user"),
    { ...message("worker", "AML worker event", "user"), workerEventIds:["event"] },
  ]);
  assert.equal(retrieveChatMemory(history, "AML")[0].messageId, "instruction");
  assert.deepEqual(retrieveChatMemory({ ...history, includeHistory:false }, "AML"), []);
});

test("current task acceptance and open verification participate in recall and remain task scoped", () => {
  const task = { schema:"pkm.chat.harness-report/v1", kind:"task", source:"agent-report", taskId:"task",
    goal:"Restore research", constraints:["Do not deploy"], acceptance:["checksum parity"], openQuestions:["retention verification"] };
  const history = chat([
    message("evidence", "checksum parity; retention verification pending"),
    { ...message("report", ""), harnessReports:[task] },
    { ...message("other-task", ""), taskId:"unrelated", harnessReports:[{ ...task, taskId:"unrelated", goal:"OTHER_TASK_SECRET" }] },
  ]);
  const query = chatMemoryQuery(history, "continue");
  assert(query.includes("checksum parity"));
  assert(query.includes("retention verification"));
  assert(!query.includes("OTHER_TASK_SECRET"));
  assert(retrieveChatMemory(history, "continue").some(item => item.messageId === "evidence"));
});

test("active subgoals and failed verification guide recall; closed Steps and rejected plans do not", () => {
  const base = { schema:"pkm.chat.harness-report/v1", source:"agent-report", taskId:"task" };
  const history = chat([
    message("evidence", "active-subgoal retention checksum"),
    { ...message("older-report", ""), harnessReports:[
      { ...base, kind:"step", status:"start", binding:{ stepId:"closed" }, goal:"OLD_CLOSED_SUBGOAL" },
    ] },
    { ...message("newer-report", ""), harnessReports:[
      { ...base, kind:"step", status:"complete", binding:{ stepId:"closed" } },
      { ...base, kind:"step", status:"start", binding:{ stepId:"active" }, goal:"active-subgoal" },
      { ...base, kind:"validation", status:"failed", binding:{ stepId:"active" }, openQuestions:["retention checksum"] },
      { ...base, kind:"planning", planning:{ possibilities:[
        { id:"a", status:"selected", label:"ACTIVE_PLAN" },
        { id:"b", status:"rejected", label:"REJECTED_PLAN" },
      ] } },
    ] },
  ]);
  const query = chatMemoryQuery(history, "continue");
  assert(query.includes("active-subgoal") && query.includes("retention checksum") && query.includes("ACTIVE_PLAN"));
  assert(!query.includes("OLD_CLOSED_SUBGOAL") && !query.includes("REJECTED_PLAN"));
  assert(retrieveChatMemory(history, "continue").some(item => item.messageId === "evidence"));
});
