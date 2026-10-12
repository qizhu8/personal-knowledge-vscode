const { randomUUID } = require("crypto");

const namespace = "0123456789abcdef";
const evidence = {
  alpha: "docker-alpha version=v1 concurrency=16 QPS=700 p99=95ms",
  beta: "docker-beta version=v2 concurrency=32 QPS=1250 p99=80ms",
};

function message(role, content, extra = {}) {
  return { id: randomUUID(), role, content, status: "complete", ...extra };
}

function conversation(extra = {}) {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    version: 1, id: randomUUID(), workspaceNamespace: namespace,
    title: "Synthetic context fixture", createdAt: now, updatedAt: now,
    includeHistory: true, permissionMode: "read-only", context: [], images: [],
    messages: [], ...extra,
  };
}

function recentMessages(count = 20) {
  return Array.from({ length: count }, (_, index) =>
    message(index % 2 ? "assistant" : "user", `Unrelated exchange ${index}`));
}

function largeToolHistory() {
  const tools = Array.from({ length: 17 }, (_, index) => ({
    id: `synthetic-call-${index}`, name: "read_file", status: "complete",
    arguments: JSON.stringify({ path: `synthetic-report-${index}.txt` }),
    result: JSON.stringify({
      title: `Synthetic report ${index}`,
      metadata: { version: index === 8 ? "v2" : "v1", concurrency: index === 8 ? 32 : 16 },
      content: index === 8 ? evidence.beta : `unrelated-result-${index} `.repeat(400),
    }),
  }));
  return conversation({
    messages: [
      ...recentMessages(26),
      message("user", "Inspect the synthetic performance reports"),
      message("assistant", "Performance reports collected", { toolCalls: tools }),
    ],
  });
}

function failedToolHistory(status = "failed") {
  return conversation({
    messages: [
      message("assistant", "", {
        status,
        toolCalls: [
          { id: "completed-before-failure", name: "read_file", arguments: "{}", status: "complete", result: evidence.beta },
          { id: "failed-operation", name: "save_file", arguments: "{}", status: "failed", result: "NOT_SAVED: disk full" },
        ],
      }),
      ...recentMessages(),
    ],
  });
}

function olderEvidence() {
  return conversation({
    messages: [
      message("assistant", evidence.alpha),
      message("assistant", evidence.beta),
      ...recentMessages(),
    ],
  });
}

module.exports = { namespace, evidence, message, conversation, recentMessages, largeToolHistory, failedToolHistory, olderEvidence };
