import type { ApiChatTool } from "./api-chat-client";
import type { ExplicitMemoryHostAuthorizer } from "../memory/explicit-memory-service";
import type { MemoryEngineClientOptions } from "../memory/memory-engine-client";
import { memoryCapabilities } from "../capabilities/memory-contract";
import { executeMemoryOperation } from "../capabilities/memory-operations";

export function createExplicitMemoryTools(options: {
  enabled: string[];
  context: () => { options: MemoryEngineClientOptions; root: string };
  assertActive: () => void;
  approve: (write: boolean, detail: string, signal: AbortSignal) => Promise<boolean>;
  authorize: (request: Parameters<ExplicitMemoryHostAuthorizer>[0], signal: AbortSignal) => ReturnType<ExplicitMemoryHostAuthorizer>;
}): ApiChatTool[] {
  return memoryCapabilities.filter(operation => options.enabled.includes(operation.transportName)).map(operation => ({
    name: operation.transportName, description: operation.description, parameters: operation.inputSchema,
    execute: async (args, signal) => {
      options.assertActive();
      if (signal.aborted) throw new Error("Request cancelled.");
      if (!await options.approve(!operation.readOnly, `${operation.id}\n${JSON.stringify(args)}`, signal)) throw new Error("Memory access declined.");
      options.assertActive();
      if (signal.aborted) throw new Error("Request cancelled.");
      const context = options.context();
      const result = await executeMemoryOperation(context.options, context.root, operation.transportName, args, async request => {
        const decision = await options.authorize(request, signal);
        options.assertActive();
        if (signal.aborted) throw new Error("Memory decision cancelled; no mutation was authorized.");
        return decision;
      });
      return JSON.stringify(result);
    },
  }));
}
