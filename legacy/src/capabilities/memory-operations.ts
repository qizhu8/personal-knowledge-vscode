import { MemoryEngineClient, MemoryEngineRequestError, type MemoryEngineClientOptions } from "../memory/memory-engine-client";
import { ExplicitMemoryService, ExplicitMemoryValidationError, type ExplicitMemoryHostAuthorizer, type ExplicitMemoryRecord } from "../memory/explicit-memory-service";
import { memoryCapabilities, repositoryMemoryScope } from "./memory-contract";
import { CapabilityError, validateCapabilityInput } from "./registry";

export function executeMemoryOperation(options: MemoryEngineClientOptions, root: string, operation: "memory_record_get",
  args: Record<string, unknown>, authorize?: ExplicitMemoryHostAuthorizer): Promise<ExplicitMemoryRecord & Record<string, unknown>>;
export function executeMemoryOperation(options: MemoryEngineClientOptions, root: string, operation: string,
  args: Record<string, unknown>, authorize?: ExplicitMemoryHostAuthorizer): Promise<Record<string, unknown>>;
export async function executeMemoryOperation(options: MemoryEngineClientOptions, root: string, operation: string,
  args: Record<string, unknown>, authorize: ExplicitMemoryHostAuthorizer = () => null): Promise<Record<string, unknown>> {
  const definition = memoryCapabilities.find(item => item.transportName === operation);
  if (!definition) throw new CapabilityError("NOT_AVAILABLE", "Unknown Memory operation.");
  validateCapabilityInput(args, definition.inputSchema);
  const engine = await MemoryEngineClient.open(options);
  try {
    const service = new ExplicitMemoryService(engine, repositoryMemoryScope(root), async request => {
      const decision = await authorize(request);
      if (!decision) throw new CapabilityError("ACCESS_DENIED", "Host did not authorize the explicit-memory decision.");
      return decision;
    });
    const mutation = { operationId: String(args.operation_id) };
    const input = { content: String(args.content), sources: Array.isArray(args.sources) ? args.sources.map(value => {
      if (!value || typeof value !== "object" || typeof value.id !== "string" || typeof value.chat !== "string"
        || typeof value.revision !== "string" || typeof value.locator !== "string") {
        throw new CapabilityError("INVALID_ARGUMENT", "Provide exact source references.");
      }
      return { id: value.id, chat: value.chat, revision: value.revision, locator: value.locator };
    }) : [] };
    if (operation === "memory_record_propose") return { ...await service.propose(input, mutation) };
    if (operation === "memory_record_get") return { ...await service.get(String(args.id), args.revision === undefined ? undefined : Number(args.revision)) };
    if (operation === "memory_record_search") return { records: (await service.search(String(args.query), Number(args.limit ?? 3))).map(record => ({
      id: record.id, revision: record.revision, status: record.status, updated_at: record.updated_at,
      preview: record.content.slice(0, 800), contentCharacters: record.content.length, truncated: record.content.length > 800,
      sourceCount: record.sources.length, readOperation: "memory.record.get",
    })) };
    if (operation === "memory_record_audit") return { ...await service.audit(String(args.id), Number(args.after ?? 0), Number(args.limit ?? 10)) };
    if (operation === "memory_record_confirm") return { ...await service.confirm(String(args.id), Number(args.expected_revision), mutation) };
    if (operation === "memory_record_revise") return { ...await service.revise(String(args.id), Number(args.expected_revision), input, mutation) };
    return { ...await service.revoke(String(args.id), Number(args.expected_revision), mutation) };
  } catch (error) {
    if (error instanceof MemoryEngineRequestError) throw new CapabilityError(error.code, error.message);
    if (error instanceof ExplicitMemoryValidationError) throw new CapabilityError("INVALID_ARGUMENT", error.message);
    throw error;
  } finally { await engine.close(); }
}
