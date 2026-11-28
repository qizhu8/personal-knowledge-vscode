import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as vscode from "vscode";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SelectedChatGateway } from "../chat/api-chat-mcp";
import type { registerApiChatShell } from "../chat/api-chat-shell";
import type { BrowserChatGrant } from "../chat/browser-chat-transcript";
import { MCP_ATTRIBUTION_ENV } from "../mcp/mcp-attribution";
import { MCP_LIFECYCLE_SCHEMA, waitForManagedMcpDrain } from "../mcp/mcp-lifecycle";
import { verifyNextPayload } from "./next-payload-verifier";
import { registerBrowserHttpsActivation } from "./pkm-browser-https-activation";

type Route = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
type Read = (input: {operation: string; version: 1; arguments: Record<string, unknown>}) => Promise<unknown>;
type Shell = ReturnType<typeof registerApiChatShell>;
const reads = new Set(["list_notes", "search_notes", "get_note", "api_chat_capabilities",
  "api_chat_list", "api_chat_get", "api_chat_request_get"].map(name => `mcp.tool.${name}`));

async function openGateway(gateway: SelectedChatGateway) {
  const client = new Client({ name: "pkm-original-browser-read", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: gateway.command, args: gateway.args, cwd: gateway.cwd,
    env: { ELECTRON_RUN_AS_NODE: "1", [MCP_ATTRIBUTION_ENV]: "" }, stderr: "ignore" });
  let live = false, instance: string | undefined, closeWork: Promise<void> | undefined;
  client.onclose = client.onerror = () => { live = false; };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }, undefined,
      { timeout: name === "capability_read" ? 60_000 : 10_000 });
    if (result.isError) throw new Error("Original browser gateway rejected the request.");
    if (result.structuredContent !== undefined) return result.structuredContent;
    const content = result.content;
    // FastMCP's unstructured encoding of an empty legacy list has no blocks.
    if (name === "capability_read" && args.operation === "mcp.tool.search_notes" &&
        Array.isArray(content) && content.length === 0) return [];
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text" ||
        typeof content[0].text !== "string" || content[0].text.length > 2_000_000)
      throw new Error("Unexpected Original browser gateway response.");
    return JSON.parse(content[0].text);
  };
  const verify = (state: any) => {
    if (state?.schema !== MCP_LIFECYCLE_SCHEMA || state.generation !== gateway.generation
      || state.runtimeBuild !== gateway.runtimeBuild || typeof state.instanceId !== "string"
      || instance && instance !== state.instanceId) throw new Error("Original browser gateway identity changed.");
  };
  const close = () => closeWork ??= (async () => {
    live = false;
    if (instance) {
      const observe = async (name: string) => { const state = await call(name, {}); verify(state); return state; };
      await observe("mcp_lifecycle_quiesce");
      if ((await waitForManagedMcpDrain(observe, 30_000)).state !== "drained")
        throw new Error("Original browser gateway drain was not confirmed.");
    }
    // EOF lets the verified gateway drain its Original child before exit.
    const child = (transport as unknown as { _process?: import("node:child_process").ChildProcess })._process;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Original browser gateway exit was not confirmed.")), 30_000);
        child.once("close", code => {
          clearTimeout(timer);
          if (code === 0) resolve(); else reject(new Error("Original browser gateway exited unexpectedly."));
        });
        child.stdin?.end();
      });
    }
    await client.close();
  })();
  const assertCurrent = () => { gateway.assertCurrent(); if (!live) throw new Error("Original browser gateway is offline."); };
  try {
    gateway.assertCurrent();
    await client.connect(transport, { timeout: 30_000 });
    const version = await call("check_version", {});
    verify(version.runtime);
    instance = version.runtime.instanceId;
    if (version.version !== gateway.version || version.backend?.architecture !== "v5-mcp-with-original-business-adapter"
        || version.backend.storageEngine !== "original" || version.backend.storageMigrated !== false
        || version.backend.runtimeBuild !== gateway.originalBuild || version.backend.health?.phase !== "accepting"
        || version.backend.health.uncertainCalls !== 0 || version.runtime.acceptingNewCalls !== true)
      throw new Error("Original browser gateway is not serving the selected owner.");
    const enabled = new Set<string>();
    for (const operation of reads) {
      try {
        const contract = await call("capabilities_describe", { operation });
        if (contract.id === operation && contract.version === 1 && contract.readOnly === true) enabled.add(operation);
      } catch { /* Missing read lanes remain unavailable. */ }
    }
    if (["list_notes", "search_notes", "get_note"].some(name => !enabled.has(`mcp.tool.${name}`)))
      throw new Error("The selected Original gateway does not support verified Note reads.");
    live = true;
    assertCurrent();
    const read: Read = async input => {
      assertCurrent();
      if (input.version !== 1 || !enabled.has(input.operation)) throw new Error("Original browser read is unavailable.");
      try {
        const value = await call("capability_read", input);
        assertCurrent();
        return value;
      } catch {
        // A failed read must never surface Original response bodies or source paths.
        throw new Error("Original browser gateway could not complete its read.");
      }
    };
    return { generation: gateway.generation, read, assertCurrent, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

let closeActiveBrowser: (() => Promise<void>) | undefined;
export async function closeOriginalBrowserActivation() {
  await closeActiveBrowser?.();
}

export function registerOriginalBrowserActivation(context: vscode.ExtensionContext, options: {
  root(): string; select(): Promise<SelectedChatGateway & { liveRelay: boolean }>; chat: Shell;
  bindBrowserReads(): Promise<Awaited<ReturnType<typeof openGateway>> | undefined>;
}) {
  registerBrowserHttpsActivation(context, options);
  if (vscode.env.remoteName || vscode.env.uiKind !== vscode.UIKind.Desktop) return;
  let disposed = false, epoch = 0, opening = false;
  let active: { url: string; token: string; current(): void; verify(): Promise<void>; close(): Promise<void> } | undefined;
  let draining: Promise<void> | undefined, drainFailed = false;
  const invalidate = () => {
    epoch++;
    const old = active;
    active = undefined;
    if (old) draining = old.close().catch(() => {
      drainFailed = true;
      void vscode.window.showWarningMessage("PKM Browser stopped accepting requests, but its gateway exit could not be verified. Reload VS Code before reconnecting.");
    });
  };
  const badge = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -50);
  badge.text = "$(browser) PKM Browser";
  badge.tooltip = "Open or revoke local PKM Browser access";
  badge.command = "personalKnowledge.openOriginalBrowser";
  badge.show();
  const start = async () => {
    if (active) {
      const existing = active;
      try { await existing.verify(); return existing; }
      catch { invalidate(); }
    }
    if (opening || disposed) throw new Error("PKM Browser is unavailable.");
    opening = true;
    const captured = epoch;
    let gateway: Awaited<ReturnType<typeof openGateway>> | undefined;
    try {
      await draining;
      const root = options.root();
      if (drainFailed || disposed || captured !== epoch || !vscode.workspace.isTrusted ||
          !root || realpathSync(root) !== root) throw new Error("A trusted, canonical Original Knowledge Root is required.");
      const pin = lstatSync(root);
      if (!pin.isDirectory()) throw new Error("Original Knowledge Root is unavailable.");
      const folders = () => JSON.stringify(vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()) ?? []);
      const pinnedFolders = folders();
      const payload = verifyNextPayload(context.extensionPath);
      const runtime = require(join(payload.root, "server/dist/browser-original-owner.js")) as {
        createOriginalBrowserRoute(input: object): Promise<Route>;
      };
      const bound = await options.bindBrowserReads() ?? await (async () => {
        const selected = await options.select();
        if (selected.liveRelay) throw new Error("The live PKM browser binding is unavailable.");
        return openGateway(selected);
      })();
      gateway = bound;
      let revoked = false;
      const current = () => {
        try {
          if (revoked || disposed || captured !== epoch || !vscode.workspace.isTrusted
              || folders() !== pinnedFolders || options.root() !== root) throw Error();
          const stat = lstatSync(root);
          if (stat.dev !== pin.dev || stat.ino !== pin.ino || !stat.isDirectory()) throw Error();
          bound.assertCurrent();
        } catch { revoked = true; throw new Error("Original browser binding was revoked."); }
      };
      const observedChatHost = async () => {
        const info = await bound.read({ operation: "mcp.tool.api_chat_capabilities", version: 1, arguments: {} }) as any;
        const hosts = info?.ok === true && info.truncated === false && Array.isArray(info.hosts)
          ? info.hosts.filter((host: any) => typeof host.host_id === "string" &&
            Array.isArray(host.workspace_paths) && host.workspace_paths.includes(root) &&
            Array.isArray(host.operations) && host.operations.includes("list") && host.operations.includes("get")) : [];
        return hosts.length === 1 ? hosts[0].host_id as string : undefined;
      };
      let chatHostId: string | undefined;
      if (vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === "file" && folder.uri.fsPath === root)) {
        try { chatHostId = await observedChatHost(); }
        catch { /* Notes can be bound without a discoverable Chat owner. */ }
      }
      let grant = Object.freeze({ actorId: `local-browser:${randomUUID()}`, workspaceRoot: root,
        generation: bound.generation, chatHostId });
      const assertCurrent = (supplied: BrowserChatGrant) => {
        current();
        if (supplied.actorId !== grant.actorId || supplied.workspaceRoot !== grant.workspaceRoot
            || supplied.generation !== grant.generation || supplied.chatHostId !== grant.chatHostId) throw Error();
      };
      let readChatTranscript, chatTurns;
      if (chatHostId) {
        try {
          readChatTranscript = options.chat.bindBrowserChatTranscript(grant, assertCurrent);
          chatTurns = options.chat.bindBrowserChatTurns(grant, assertCurrent);
        } catch {
          // Do not fall back to mailbox replies if native owner binding fails.
          grant = Object.freeze({ ...grant, chatHostId: undefined });
          readChatTranscript = undefined;
        }
      }
      const token = randomBytes(32).toString("base64url");
      const route = await runtime.createOriginalBrowserRoute({ token, grant, assertCurrent, readChatTranscript, chatTurns,
        capabilityRead(supplied: BrowserChatGrant, input: Parameters<Read>[0]) {
          assertCurrent(supplied);
          return bound.read(input);
        },
      });
      current();
      const server = createServer((req, res) => void route(req, res).then(handled => {
        if (!handled) res.writeHead(404, { "Cache-Control": "no-store" }).end();
      }).catch(() => { if (!res.headersSent) res.writeHead(503); res.end(); }));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const close = async () => {
        revoked = true;
        clearInterval(watch);
        server.close();
        server.closeAllConnections();
        await bound.close();
      };
      let checking = false, cycles = 0;
      const watch = setInterval(() => {
        try { current(); } catch { invalidate(); return; }
        if (++cycles % 5 || checking || !grant.chatHostId) return;
        checking = true;
        void observedChatHost().then(id => {
          if (id !== grant.chatHostId && !revoked && captured === epoch) invalidate();
        }).catch(() => {
          if (!revoked && captured === epoch) invalidate();
        }).finally(() => { checking = false; });
      }, 1000);
      watch.unref();
      active = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/webview/`, token, current, close,
        async verify() {
          current();
          const id = await observedChatHost();
          current();
          if (id !== grant.chatHostId) throw new Error("The browser Chat host changed.");
        },
      };
      try { current(); } catch (error) { invalidate(); gateway = undefined; throw error; }
      return active;
    } catch (error) {
      await gateway?.close().catch(() => { drainFailed = true; });
      throw error;
    } finally { opening = false; }
  };
  let presenting = false;
  const shutdown = async () => { disposed = true; invalidate(); await draining; };
  closeActiveBrowser = shutdown;
  context.subscriptions.push(badge, { dispose() { void shutdown(); } },
    vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
    vscode.workspace.onDidGrantWorkspaceTrust(invalidate),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("personalKnowledge")) invalidate();
    }),
    vscode.commands.registerCommand("personalKnowledge.openOriginalBrowser", async () => {
      if (presenting || disposed || !vscode.workspace.isTrusted) return;
      presenting = true;
      try {
        const action = await vscode.window.showQuickPick(active ? ["Copy sign-in token and open", "Revoke browser access"]
          : ["Copy sign-in token and open"], { title: "PKM Browser · local access only" });
        if (action === "Revoke browser access") invalidate();
        if (action === "Copy sign-in token and open") {
          const binding = await start();
          if (!binding) return;
          binding.current();
          await vscode.env.clipboard.writeText(binding.token);
          binding.current();
          await vscode.env.openExternal(vscode.Uri.parse(binding.url));
          return binding.url;
        }
      } catch (error) {
        void vscode.window.showWarningMessage(`PKM Browser unavailable. ${error instanceof Error ? error.message : "Verify the trusted Original Knowledge Root and selected gateway."}`);
        throw error;
      }
      finally { presenting = false; }
    }));
}
