import type { ChatMessage } from "../chat/api-chat-store";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function memoryReferences(operation: unknown, result: unknown) {
  if (typeof operation !== "string" || !operation.startsWith("memory.record.")) return undefined;
  const record = object(result);
  const candidates = operation === "memory.record.search" && Array.isArray(record.records) ? record.records.slice(0, 3) : [record];
  const records = candidates.map(object).filter(item => typeof item.id === "string" && /^explicit-[a-f0-9]{64}$/.test(item.id)
    && Number.isSafeInteger(item.revision) && Number(item.revision) > 0
    && ["pending", "confirmed", "superseded", "revoked"].includes(String(item.status)))
    .map(item => ({ id: item.id, revision: item.revision, status: item.status }));
  return { kind: operation === "memory.record.search" ? "retrieved" : operation === "memory.record.get" ? "read" : "lifecycle",
    records, application: "not-observed", note: "Record/version references only. Retrieval or lifecycle success does not establish application or user acceptance." };
}

export function capabilityObservations(message: ChatMessage) {
  return (message.toolCalls || []).filter(call => ["capability_call", "capability_read"].includes(call.name)
    || /^memory_record_(propose|get|search|confirm|revise|revoke|audit)$/.test(call.name)).slice(-50).map(call => {
    let input: Record<string, unknown> = {}, output: Record<string, unknown> = {};
    try { input = JSON.parse(call.arguments); } catch { /* Legacy malformed inputs remain visible as unknown. */ }
    try { output = JSON.parse(call.result || "{}"); } catch { /* Raw tool evidence remains in history. */ }
    const operation = call.name.startsWith("memory_record_") ? `memory.record.${call.name.slice(14)}` : input?.operation;
    return { callId: call.id, operation: typeof operation === "string" && /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2}$/.test(operation) && operation.length <= 100 ? operation : undefined,
      version: call.name.startsWith("memory_record_") || input?.version === 1 ? 1 : undefined, status: call.status,
      catalogRevision: typeof output?.catalogRevision === "string" && /^[a-f0-9]{64}$/.test(output.catalogRevision) ? output.catalogRevision : undefined,
      memory: call.status === "complete" ? memoryReferences(operation, call.name.startsWith("memory_record_") ? output : output?.result) : undefined,
      note: "Invocation evidence, not acceptance. Full arguments/results remain in the original tool receipt." };
  });
}
