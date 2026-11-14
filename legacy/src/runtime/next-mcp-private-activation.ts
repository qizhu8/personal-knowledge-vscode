import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { captureRecipeWorkspace, assertRecipeWorkspace } from "./next-recipe-workspace";
import { createNextMcpOwnerBroker } from "./next-mcp-owner-broker";
import { createNextMcpBrokerProvider } from "./next-mcp-broker-provider";
import { createNextMcpProviderRoute } from "./next-mcp-provider-route";
import { verifyNextPayload } from "./next-payload-verifier";
import { acquirePrivateNextMcpLease } from "./next-mcp-private-lease";

/** Explicit private experiment only; never authorizes or alters legacy-root adoption. */
export async function registerPrivateNextMcp(context: vscode.ExtensionContext, legacyRoot: () => string,
  python: () => string): Promise<void> {
  const root = process.env.PKM_EXPERIMENTAL_NEXT_MCP_WORKSPACE;
  if (root === undefined) return;
  if (process.platform !== "linux" || !path.isAbsolute(root) || path.basename(root) !== "workspace"
    || fs.realpathSync(root) !== root) throw new Error("Private Next MCP workspace is not canonical.");
  const original = legacyRoot();
  if (!original || fs.realpathSync(original) !== original) throw new Error("Original root identity is unavailable.");
  const originalStat = fs.lstatSync(original);
  if (!originalStat.isDirectory()) throw new Error("Original root identity is unavailable.");
  const overlaps = (a: string, b: string) => a === b || b.startsWith(a + path.sep);
  if (overlaps(root, original) || overlaps(original, root))
    throw new Error("Private Next MCP workspace must be separate from the original root.");
  const marker = JSON.parse(fs.readFileSync(path.join(root, ".pkm-next-workspace"), "utf8"));
  const pin = captureRecipeWorkspace(path.dirname(root), marker.id);
  let disposed = false;
  const assertCurrent = () => {
    const currentOriginal = fs.lstatSync(original);
    if (disposed || process.env.PKM_EXPERIMENTAL_NEXT_MCP_WORKSPACE !== root || legacyRoot() !== original
      || fs.realpathSync(original) !== original || !currentOriginal.isDirectory()
      || currentOriginal.dev !== originalStat.dev || currentOriginal.ino !== originalStat.ino)
      throw new Error("Private Next MCP binding changed.");
    assertRecipeWorkspace(pin);
  };
  const route = createNextMcpProviderRoute({
    authority: { root, assertCurrent }, extensionPath: context.extensionPath,
    executable: process.execPath, profile: "legacy-compact-experimental", compatibilityPython: python(),
    createDefinition: (label, command, args, env, version) => ({ label, command, args, env, version }),
  });
  const payload = verifyNextPayload(context.extensionPath), payloadVersion = payload.buildId;
  const supervisor = path.join(payload.root, "resources", "next_mcp_subreaper.py");
  if (!fs.lstatSync(supervisor).isFile()) throw new Error("Private Next MCP supervisor is unavailable.");
  const createBroker = () => createNextMcpOwnerBroker({
    assertCurrent,
    launch: () => {
      const definition = route.resolveMcpServerDefinition(route.provideMcpServerDefinitions()[0]);
      return { ...definition, args: ["-B", supervisor, definition.command, ...definition.args] };
    },
    async verifyOwnedDescendantsExited(child) {
      assertCurrent();
      if (child.exitCode !== 0 || verifyNextPayload(context.extensionPath).buildId !== payloadVersion)
        throw new Error("Private Next supervised process tree exit is unknown.");
    },
  });
  let lease: ReturnType<typeof acquirePrivateNextMcpLease> | undefined = acquirePrivateNextMcpLease(pin.parent);
  let broker: Awaited<ReturnType<typeof createBroker>>;
  try { broker = await createBroker(); }
  catch (error) { lease.release(); route.dispose(); throw error; }
  let restarting = false;
  const api = vscode as any;
  try {
    const provider = createNextMcpBrokerProvider({
      bridge: path.join(context.extensionPath, "dist/runtime/next-mcp-stdio-bridge.js"),
      executable: process.execPath, payloadVersion,
      label: "pkm-next-private", assertCurrent, environment: () => broker.definitionEnvironment(),
      createDefinition: (label, command, args, env, version) =>
        new api.McpStdioServerDefinition(label, command, args, env, version),
    });
    const changed = new vscode.EventEmitter<void>();
    const publicProvider = { ...provider, onDidChangeMcpServerDefinitions: changed.event };
    context.subscriptions.push(provider, changed, { dispose() { disposed = true; broker.dispose(); route.dispose(); } },
      api.lm.registerMcpServerDefinitionProvider("personalKnowledge.nextPrivate", publicProvider),
      vscode.commands.registerCommand("_personalKnowledge.privateNextMcpStatus", () =>
        ({ ...broker.status(), scope: "private-owned-process-tree", cutoverAuthorized: false })),
      vscode.commands.registerCommand("_personalKnowledge.privateNextMcpDrain", async () => {
        assertCurrent();
        const result = await broker.drainAndClose();
        assertCurrent();
        if (!lease) throw new Error("Private Next MCP lease is missing.");
        lease.release();
        lease = undefined;
        return result;
      }),
      vscode.commands.registerCommand("_personalKnowledge.privateNextMcpRestart", async () => {
        assertCurrent();
        if (restarting || lease || broker.status().state !== "stopped")
          throw new Error("Private Next MCP restart requires a verified owned-tree exit.");
        restarting = true;
        try {
          const nextLease = acquirePrivateNextMcpLease(pin.parent);
          let next: Awaited<ReturnType<typeof createBroker>> | undefined;
          try { next = await createBroker(); assertCurrent(); }
          catch (error) { next?.dispose(); nextLease.release(); throw error; }
          lease = nextLease;
          broker = next;
          changed.fire();
          return { state: "accepting", cutoverAuthorized: false };
        } finally { restarting = false; }
      }));
  } catch (error) {
    broker.dispose();
    route.dispose();
    throw error;
  }
}
