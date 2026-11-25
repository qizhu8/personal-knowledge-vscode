import { z } from "zod";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export interface NativeBackendTool {
  description?: string;
  inputSchema: z.ZodType;
  annotations?: ToolAnnotations;
  invoke(arguments_: unknown): Promise<CallToolResult>;
}

/** Transport-independent registrations; callbacks retain their original authority closures. */
export class NativeMcpBackend {
  readonly tools = new Map<string, NativeBackendTool>();
  private readonly closing: (() => void | Promise<void>)[] = [];
  private closePromise?: Promise<void>;

  registerTool<S extends z.ZodType>(name: string, config: {
    description?: string; inputSchema: S; annotations?: ToolAnnotations;
  }, callback: (arguments_: z.output<S>) => CallToolResult | Promise<CallToolResult>) {
    if (this.tools.has(name)) throw new Error(`Duplicate backend tool: ${name}`);
    this.tools.set(name, { ...config,
      invoke: async arguments_ => callback(config.inputSchema.parse(arguments_)),
    });
  }

  onClose(close: () => void | Promise<void>) { this.closing.push(close); }

  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      try { for (const close of this.closing) await close(); }
      finally { this.tools.clear(); }
    })();
  }

  async invoke(name: string, arguments_: unknown): Promise<CallToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`NOT_AVAILABLE: Backend tool is not enabled: ${name}`);
    return tool.invoke(arguments_);
  }
}
