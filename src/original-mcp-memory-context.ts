import { CoreError } from "./contracts.js";
import { sha256 } from "./file-write.js";
import { memoryDefinitions, memoryRecord, type MemoryRecord } from "./memory-contracts.js";
import { readActiveMemoryScopeSession } from "./memory-scope-continuity.js";
import { assertOriginalMcpDomainSession } from "./original-mcp-domains.js";
import { scanOriginalMemoryDocuments } from "./original-mcp-memory-store.js";
import type { OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertRootOwner, type RootOwner } from "./root-owner.js";

export interface OriginalMcpMemoryContextSnapshot {
  readonly scope: string;
  readonly memoryRevision: string;
  readonly records: readonly MemoryRecord[];
  assertCurrent(): void;
}

/** Same-owner canonical recall; no archived Engine, second workspace, provider or synthetic approval. */
export async function readOriginalMcpMemoryContext(owner: RootOwner, host: OriginalMcpNativeHost,
  input: { query: string; limit?: number; signal?: AbortSignal }): Promise<OriginalMcpMemoryContextSnapshot> {
  assertRootOwner(owner);
  const args = memoryDefinitions[2].input.parse({ query: input.query, limit: input.limit });
  const signal = input.signal;
  return owner.withReadScope(async scope => {
    const { storage, runtime } = await owner.ensureFull();
    scope.assertHeld();
    const root = owner.workspaceRoot(), lease = owner.workspaceLease(), actor = { id: "mcp:external", canWrite: false };
    const current = () => {
      owner.assertWorkspaceLease();
      if (signal?.aborted) throw new CoreError("NOT_AVAILABLE", "Native Memory context was cancelled.");
      assertOriginalMcpDomainSession(storage, host, "memory");
      const session = readActiveMemoryScopeSession(root, actor.id);
      const documents = scanOriginalMemoryDocuments(root);
      return { scope: session.scope, revision: sha256(JSON.stringify({
        lease: owner.workspaceLease(), session,
        documents: documents.map(document => [document.record.id, document.record.sha256]),
      })) };
    };
    const initial = current();
    const read = async (operation: string, arguments_: Record<string, unknown>) => {
      const response = await runtime.core.dispatch("capability_read", { operation, version: 1, arguments: arguments_ }, actor);
      if (response.error) throw new CoreError(response.error.code, response.error.message);
      return response.result;
    };
    const selected = memoryDefinitions[2].output.parse(await read("memory.record.search", args));
    const records: MemoryRecord[] = [];
    for (const preview of selected.records) {
      const record = memoryRecord.parse(await read("memory.record.get", { id: preview.id }));
      if (record.scope !== initial.scope || record.status !== "confirmed" || record.current_status !== "confirmed"
        || record.revision !== record.current_revision || record.revision !== preview.revision)
        throw new CoreError("NOT_AVAILABLE", "Native Memory changed during canonical context recall.");
      records.push(record);
    }
    const sealed = structuredClone(records), recordsSha256 = sha256(JSON.stringify(sealed));
    const assertCurrent = () => {
      const observed = current();
      if (observed.scope !== initial.scope || observed.revision !== initial.revision
        || JSON.stringify(owner.workspaceLease()) !== JSON.stringify(lease)
        || sha256(JSON.stringify(sealed)) !== recordsSha256)
        throw new CoreError("NOT_AVAILABLE", "Native Memory source, consent or recalled content changed; rebuild context.");
    };
    assertCurrent();
    scope.assertHeld();
    return Object.freeze({ scope: initial.scope, memoryRevision: initial.revision,
      records: Object.freeze(sealed), assertCurrent });
  });
}
