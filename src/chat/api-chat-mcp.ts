import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport, StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ApiChatTool } from "./api-chat-client";
import { abortable } from "./api-chat-tools";
import { ToolSafetyHints } from "./permissions";
import { boundedLifecycleRead, handshakeManagedMcpConnection, managedMcpApiCompatible, ManagedMcpManifest,
  MCP_LIFECYCLE_SCHEMA, readManagedMcpGeneration, readManagedMcpManifest, waitForManagedMcpDrain } from "../mcp/mcp-lifecycle";

export interface ApiChatMcpServer { id: string; label: string; url: string; enabled: boolean; tools: string[] }

export interface ManagedChatMcp {
  generation: string;
  catalog: { name: string; description: string; inputSchema: object; managed: true; hints?: ToolSafetyHints }[];
  invoke(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

async function withMcpDiscoveryDeadline<T>(
  signal: AbortSignal, timeoutMs: number, discover: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("MCP discovery deadline must be positive.");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
  try {
    return await abortable(discover(controller.signal), controller.signal);
  } catch (error) {
    if (expired) throw new Error(`MCP discovery deadline exceeded (${timeoutMs} ms); no content tool was invoked.`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

/** This is the configured PKM service, not a name-based substitute for an arbitrary native tool. */
export async function connectManagedChatMcp(
  launch: StdioServerParameters, signal: AbortSignal, managedDirectory: string,
  options: { drainTimeoutMs?: number; discoveryTimeoutMs?: number } = {},
): Promise<ManagedChatMcp> {
  if (signal.aborted) throw new Error("Request cancelled.");
  const configured = readManagedMcpManifest(managedDirectory);
  if (!configured) throw new Error("Managed PKM lifecycle ownership is unavailable. Explicit reconnect/action required; legacy drain state is unknown.");
  let expected: ManagedMcpManifest = configured;
  const client = new Client({ name: "pkm-chat-managed", version: "1.0.0" });
  const transport = new StdioClientTransport({ ...launch, stderr: "inherit" });
  const drainTimeoutMs = Math.max(1, options.drainTimeoutMs ?? 30_000);
  let admissionClosed = false;
  let verified = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const invokeControl = async (name: string, arguments_: Record<string, never>): Promise<any> => {
    const result = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 10_000 });
    if (result.isError) throw new Error("Managed PKM lifecycle observation failed; drain state is unknown.");
    if (result.structuredContent) return result.structuredContent;
    const text = Array.isArray(result.content) ? result.content.map(part =>
      part.type === "text" && typeof part.text === "string" ? part.text : "").join("\n") : "";
    return JSON.parse(text);
  };
  const closeSafely = (): Promise<void> => {
    admissionClosed = true;
    if (closed) return Promise.resolve();
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (verified) {
        const deadline = Date.now() + drainTimeoutMs;
        const observe = async (name: string, arguments_: Record<string, never>) => {
          if (Date.now() >= deadline) throw new Error("Managed PKM drain observation expired.");
          const value = await boundedLifecycleRead(invokeControl(name, arguments_), deadline - Date.now());
          if (value?.schema !== MCP_LIFECYCLE_SCHEMA || value.generation !== expected.generation
            || value.runtimeBuild !== expected.runtimeBuild) {
            throw new Error("Managed PKM drain ownership is unknown; explicit action required.");
          }
          return value;
        };
        await observe("mcp_lifecycle_quiesce", {});
        const boundary = await waitForManagedMcpDrain(observe, Math.max(0, deadline - Date.now()));
        if (boundary.state !== "drained") throw new Error(boundary.reason);
      }
      // Before verification this child has received discovery/control reads only.
      signal.removeEventListener("abort", closeOnAbort);
      await client.close();
      closed = true;
    })().catch(error => {
      closePromise = undefined;
      throw new Error(`PKM MCP close is action-required; no uncertain call was replayed or forcibly terminated. ${error instanceof Error ? error.message : String(error)}`);
    });
    return closePromise;
  };
  const closeOnAbort = () => {
    void closeSafely().catch(error => console.error("PKM Chat MCP drain requires action:", error));
  };
  signal.addEventListener("abort", closeOnAbort, { once: true });
  try {
    const definitions: Awaited<ReturnType<typeof client.listTools>>["tools"] = [];
    const readiness = await withMcpDiscoveryDeadline(signal, options.discoveryTimeoutMs ?? 30_000, async discoverySignal => {
      await abortable(client.connect(transport, { signal: discoverySignal, timeout: 30_000 }), discoverySignal);
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await abortable(client.listTools(cursor ? { cursor } : undefined, { signal: discoverySignal, timeout: 30_000 }), discoverySignal);
        definitions.push(...page.tools);
        if (definitions.length > 512 || page.nextCursor && cursors.has(page.nextCursor)) throw new Error("Managed PKM discovery exceeded its bound or repeated a cursor.");
        cursor = page.nextCursor;
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return abortable(handshakeManagedMcpConnection(
        managedDirectory, invokeControl, definitions.map(tool => tool.name)), discoverySignal);
    });
    if (readiness.state !== "ready" || !readiness.generation) throw new Error(readiness.reason);
    const actual = readManagedMcpGeneration(managedDirectory, readiness.generation);
    if (!actual || !managedMcpApiCompatible(actual, configured)) throw new Error("Connected PKM API is not compatible with this Chat.");
    expected = actual;
    verified = true;
    if (signal.aborted || admissionClosed) throw new Error("PKM connection was cancelled during verification.");
    const catalog: ManagedChatMcp["catalog"] = definitions.filter(tool => tool.name !== "mcp_lifecycle_quiesce").map(tool => {
      if (!/^[a-zA-Z0-9_]+$/.test(tool.name) || JSON.stringify(tool.inputSchema).length > 16_000) throw new Error("Invalid managed PKM tool definition.");
      return { name: `mcp_pkm_${tool.name}`, description: tool.description || "", inputSchema: tool.inputSchema, managed: true, hints: tool.annotations };
    });
    return { catalog, generation: readiness.generation,
      invoke: async (name, input, requestSignal) => {
        const current = readManagedMcpManifest(managedDirectory);
        if (admissionClosed || !current || !managedMcpApiCompatible(expected, current)) {
          throw new Error("PKM API is incompatible or is closing; explicit reconnect required. No call was sent; do not replay uncertain writes.");
        }
        if (!catalog.some(tool => tool.name === name)) throw new Error("Tool is not in the configured PKM catalog.");
        if (signal.aborted || requestSignal.aborted) throw new Error("Request cancelled.");
        try {
          const result = await abortable(client.callTool({ name: name.slice("mcp_pkm_".length), arguments: input },
            undefined, { signal: requestSignal, timeout: 60_000 }), requestSignal);
          if (result.isError) throw new Error(JSON.stringify(result.content).slice(0, 1000));
          return JSON.stringify(result);
        } catch (error) {
          throw new Error(`PKM tool ${name} failed; execution may already have occurred. Do not retry automatically. ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      close: closeSafely,
    };
  } catch (error) {
    await closeSafely().catch(failure => console.error("PKM Chat MCP discovery cleanup requires action:", failure));
    throw error;
  }
}

const PKM_TOOL_GROUPS = [
  { id: "skills", label: "PKM Skills", icon: "sparkle" },
  { id: "notes", label: "PKM Notes", icon: "notebook" },
  { id: "papers", label: "PKM Papers", icon: "book" },
  { id: "chatroom", label: "PKM Chatroom", icon: "comment-discussion" },
  { id: "recipe", label: "PKM Recipe", icon: "list-tree" },
  { id: "sessions", label: "PKM Agent Sessions", icon: "hubot" },
  { id: "subscriptions", label: "PKM Subscriptions", icon: "broadcast" },
  { id: "retrieval", label: "PKM Retrieval", icon: "search" },
  { id: "runtime", label: "PKM Runtime", icon: "server" },
  { id: "other", label: "Other VS Code / MCP", icon: "tools" },
] as const;

export function pkmToolGroup(name: string): typeof PKM_TOOL_GROUPS[number]["id"] {
  const match = /^(?:mcp_)?pkm[_/.]([a-z][a-z0-9_]*)$/i.exec(name);
  if (!match) return "other";
  const tool = match[1].toLowerCase();
  if (tool.startsWith("agent_session_")) return "sessions";
  if (tool.startsWith("recipe_")) return "recipe";
  if (tool.startsWith("chat_") || tool === "check_chat_version") return "chatroom";
  if (/(?:^|_)(?:subscription|subscriptions|subscribed)(?:_|$)/.test(tool)) return "subscriptions";
  if (/(?:^|_)(?:skill|skills)(?:_|$)/.test(tool)) return "skills";
  if (/(?:^|_)(?:note|notes)(?:_|$)/.test(tool)) return "notes";
  if (/(?:^|_)(?:paper|papers)(?:_|$)/.test(tool)) return "papers";
  if (tool === "search_knowledge" || tool.startsWith("retrieval_")) return "retrieval";
  return "runtime";
}

export function groupVscodeTools<T extends { name: string }>(tools: readonly T[]) {
  return PKM_TOOL_GROUPS.map(group => ({ ...group,
    tools: tools.filter(tool => pkmToolGroup(tool.name) === group.id).sort((left, right) => left.name.localeCompare(right.name)),
  })).filter(group => group.tools.length > 0);
}

export function pkmToolSets(tools: readonly { name: string }[]) {
  return Object.fromEntries(groupVscodeTools(tools).filter(group => group.id !== "other").map(group => [
    `pkm-${group.id}`, { tools: [...new Set(group.tools.map(tool => tool.name.replace(/^(?:mcp_)?pkm[_/.]/i, "pkm/")))], description: group.label, icon: group.icon },
  ]));
}

type VscodeToolHost = typeof import("vscode") & {
  LanguageModelTextPart?: new (value: string) => { value: string };
  lm: { tools?: readonly { name: string; description: string; inputSchema?: object }[];
    invokeTool?: (name: string, options: { input: Record<string, unknown>; toolInvocationToken: undefined }, token: import("vscode").CancellationToken) => Thenable<{ content: readonly unknown[] }> };
};

const PKM_TOOL_NAME = /^(?:mcp_)?pkm[_/.]/i;
const NATIVE_START_TIMEOUT_MS = 15_000;

function nativeTools(host: typeof import("vscode")): { name: string; description: string; inputSchema?: object }[] | undefined {
  const native = host as VscodeToolHost;
  if (!native.lm?.tools || !native.lm.invokeTool || !native.LanguageModelTextPart) return undefined;
  return [...native.lm.tools];
}

export function vscodeToolCatalog(host: typeof import("vscode")) {
  const native = nativeTools(host);
  if (!native) throw new Error("This host does not expose registered VS Code/MCP tools.");
  return native;
}

/**
 * Start the registered server, or offer explicit scoped configuration when tools remain unavailable.
 * A missing registration must not silently launch an independent server.
 */
export async function ensurePkmMcpTools(host: typeof import("vscode")): Promise<void> {
  if (host.workspace.isTrusted === false) return;
  const hasPkm = () => (nativeTools(host) || []).some(tool => PKM_TOOL_NAME.test(tool.name));
  if (hasPkm()) return;
  let nativeError = "";
  if (nativeTools(host) && host.commands?.executeCommand) {
    try {
      await Promise.race([
        Promise.resolve(host.commands.executeCommand("personalKnowledge.startPkmMcp")),
        new Promise<void>(resolve => setTimeout(resolve, NATIVE_START_TIMEOUT_MS)),
      ]);
      const deadline = Date.now() + 3_000;
      while (!hasPkm() && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 100));
      if (hasPkm()) return;
      nativeError = "VS Code did not publish pkm tools";
    } catch (error) {
      nativeError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!host.commands?.executeCommand) return;
  await host.commands.executeCommand("personalKnowledge.offerPkmMcpConfiguration", nativeError || "VS Code did not publish pkm tools");
}

export function createVscodeTools(names: string[], host: typeof import("vscode"),
  approve: (name: string, arguments_: Record<string, unknown>, signal: AbortSignal, hints?: ToolSafetyHints) => Promise<void>,
  prepare?: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>,
  managed?: ManagedChatMcp): ApiChatTool[] {
  if (!names.length) return [];
  const native = host as VscodeToolHost;
  const catalog = [
    ...(managed ? (nativeTools(host) || []).filter(tool => !/^mcp_pkm_/.test(tool.name)) : vscodeToolCatalog(host)),
    ...(managed?.catalog || []),
  ].filter(tool => names.includes(tool.name));
  if (names.some(name => !catalog.some(tool => tool.name === name))) throw new Error("A selected VS Code/MCP tool is unavailable. Review Tools; no substitute was used.");
  const discovered = new Set<string>();
  const attempted = new Set<string>();
  return [{
    name: "find_vscode_tools", description: "Find enabled VS Code and MCP tools by name/description. Returns exact registered names and input schemas. Search before invoking; paginate with offset. Does not execute tools.",
    parameters: { type: "object", properties: { query: { type: "string", maxLength: 200 }, offset: { type: "integer", minimum: 0 } }, required: ["query"], additionalProperties: false },
    execute: async (args, signal) => {
      if (signal.aborted) throw new Error("Request cancelled.");
      if (typeof args.query !== "string" || args.query.length > 200 || args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0)) throw new Error("Provide a bounded query and non-negative offset.");
      const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = catalog.filter(tool => words.every(word => `${tool.name} ${tool.description}`.toLowerCase().includes(word)));
      const offset = Number(args.offset || 0);
      const results = [];
      for (const tool of matches.slice(offset, offset + 6)) {
        const entry = { name: tool.name, description: tool.description.slice(0, 600), inputSchema: tool.inputSchema || { type: "object", properties: {} } };
        if (JSON.stringify(entry).length > 15_000) throw new Error(`Tool schema for ${tool.name} exceeds the local result limit.`);
        if (JSON.stringify([...results, entry]).length > 15_000) break;
        results.push(entry);
        discovered.add(tool.name);
      }
      return JSON.stringify({ tools: results, total: matches.length, nextOffset: offset + results.length < matches.length ? offset + results.length : null });
    },
  }, {
    name: "invoke_vscode_tool", description: "Invoke an enabled VS Code/MCP tool by its exact name and input schema returned by find_vscode_tools. Chat permissions are enforced and VS Code's own confirmations remain enabled. Do not automatically retry uncertain side effects.",
    parameters: { type: "object", properties: { name: { type: "string", maxLength: 200 }, input: { type: "object", additionalProperties: true } }, required: ["name", "input"], additionalProperties: false },
    execute: async (args, signal) => {
      if (signal.aborted) throw new Error("Request cancelled.");
      if (host.workspace.isTrusted === false) throw new Error("VS Code/MCP tools require a trusted workspace.");
      if (typeof args.name !== "string" || !catalog.some(tool => tool.name === args.name) || !discovered.has(args.name)) throw new Error("Find an enabled tool and its schema before invoking it.");
      if (!args.input || typeof args.input !== "object" || Array.isArray(args.input) || JSON.stringify(args.input).length > 32_000) throw new Error("Provide bounded object input matching the discovered schema.");
      let input = args.input as Record<string, unknown>;
      const attempt = `${args.name}:${JSON.stringify(input)}`;
      if (attempted.has(attempt)) throw new Error("Duplicate VS Code/MCP execution blocked. Retry explicitly in a new request.");
      if (prepare) input = await prepare(args.name, input, signal);
      const managedTool = managed?.catalog.find(tool => tool.name === args.name);
      await approve(args.name, input, signal, managedTool?.hints);
      if (signal.aborted) throw new Error("Request cancelled.");
      attempted.add(attempt);
      if (managedTool && managed) {
        const text = await managed.invoke(args.name, input, signal);
        const output = { tool: args.name, content: text.slice(0, 12_000), truncated: text.length > 12_000 };
        while (JSON.stringify(output).length > 16_000) { output.content = output.content.slice(0, Math.floor(output.content.length * 0.8)); output.truncated = true; }
        return JSON.stringify(output);
      }
      const cancellation = new host.CancellationTokenSource();
      const cancel = () => cancellation.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await abortable(native.lm.invokeTool!(args.name, { input, toolInvocationToken: undefined }, cancellation.token), signal);
        const text = result.content.map(part => {
          if (!(part instanceof native.LanguageModelTextPart!)) throw new Error("Non-text tool results are not supported by this Chat transport.");
          return part.value;
        }).join("\n");
        const output = { tool: args.name, content: text.slice(0, 12_000), truncated: text.length > 12_000 };
        while (JSON.stringify(output).length > 16_000) { output.content = output.content.slice(0, Math.floor(output.content.length * 0.8)); output.truncated = true; }
        return JSON.stringify(output);
      } catch (error) {
        throw new Error(`VS Code/MCP tool ${args.name} failed; execution may already have occurred. Do not retry automatically. ${error instanceof Error ? error.message.slice(0, 300) : ""}`);
      } finally {
        signal.removeEventListener("abort", cancel); cancellation.cancel(); cancellation.dispose();
      }
    },
  }];
}

export function mcpUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error("MCP URL must not contain credentials, query parameters or fragments.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Use HTTPS, or HTTP on localhost only.");
  return url;
}

export async function connectApiChatMcp(server: ApiChatMcpServer, index: number, token: string | undefined, signal: AbortSignal,
  approve: (name: string, arguments_: Record<string, unknown>, signal: AbortSignal, hints?: ToolSafetyHints) => Promise<void>,
  prepare?: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>,
  options: { discoveryTimeoutMs?: number } = {}) {
  if (signal.aborted) throw new Error("Request cancelled.");
  const client = new Client({ name: "pkm-native-api-chat", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(mcpUrl(server.url), {
    requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: "error" },
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  const close = () => { void client.close().catch(() => undefined); };
  signal.addEventListener("abort", close, { once: true });
  try {
    const catalogTools: Awaited<ReturnType<typeof client.listTools>>["tools"] = [];
    await withMcpDiscoveryDeadline(signal, options.discoveryTimeoutMs ?? 30_000, async discoverySignal => {
      await abortable(client.connect(transport, { signal: discoverySignal, timeout: 30_000 }), discoverySignal);
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await abortable(client.listTools(cursor ? { cursor } : undefined, { signal: discoverySignal, timeout: 30_000 }), discoverySignal);
        catalogTools.push(...page.tools);
        if (catalogTools.length > 512 || page.nextCursor && cursors.has(page.nextCursor)) throw new Error("MCP discovery exceeded its bound or repeated a cursor.");
        cursor = page.nextCursor;
        if (cursor) cursors.add(cursor);
      } while (cursor);
    });
    const attempted = new Set<string>();
    const tools = catalogTools.map((tool, position) => {
      if (JSON.stringify(tool.inputSchema).length > 16_000) throw new Error("MCP tool schema is too large.");
      const definition: ApiChatTool & { remoteName: string } = {
        name: `mcp_${index}_${position}`, remoteName: tool.name, label: `${server.label}: ${tool.name}`,
        description: `${server.label}: ${tool.name}. ${tool.description || ""}`.slice(0, 600),
        parameters: tool.inputSchema,
        execute: async (arguments_, requestSignal) => {
          const attempt = `${tool.name}:${JSON.stringify(arguments_)}`;
          if (attempted.has(attempt)) throw new Error("Duplicate MCP execution blocked. Start a new request to retry explicitly.");
          if (prepare) arguments_ = await prepare(tool.name, arguments_, requestSignal);
          await approve(`${server.label}: ${tool.name}`, arguments_, requestSignal, tool.annotations);
          if (requestSignal.aborted) throw new Error("Request cancelled.");
          attempted.add(attempt);
          try {
            const result = await abortable(client.callTool({ name: tool.name, arguments: arguments_ }, undefined, { signal: requestSignal, timeout: 30_000 }), requestSignal);
            if (result.isError) throw new Error("Remote tool returned an error.");
            const text = JSON.stringify(result);
            if (text.length > 16_000) throw new Error("Remote tool result exceeded the limit.");
            return token ? text.split(token).join("[redacted]") : text;
          } catch { throw new Error(`MCP tool ${tool.name} failed; execution may already have occurred. Do not retry automatically.`); }
        },
      };
      return definition;
    });
    return { tools, truncated: false, close: async () => { signal.removeEventListener("abort", close); await client.close(); } };
  } catch (error) {
    signal.removeEventListener("abort", close); await client.close().catch(() => undefined);
    if (error instanceof Error && error.message.startsWith("MCP discovery deadline exceeded")) throw error;
    throw new Error(`MCP connection ${server.label} failed. Check the endpoint and credentials.`);
  }
}