import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { MCP_LIFECYCLE_SCHEMA, readManagedMcpManifest } from "./mcp-lifecycle";
import { verifyNextPayload } from "../runtime/next-payload-verifier";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const identity = (stat: fs.Stats) => `${stat.dev}:${stat.ino}`;
function pin(filename: string) {
  const resolved = fs.realpathSync(filename), stat = fs.lstatSync(resolved);
  if (!stat.isFile()) throw new Error("Compatibility runtime entry unavailable.");
  return { path: resolved, sha256: hash(fs.readFileSync(resolved)) };
}
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);

/** One cold selection, two stdio clients; Original remains the writer. */
export function createBundledCompatibilityRoute(options: {
  extensionPath: string; storage: string;
  root(): string; managed(): string; python(): string; assertAllowed(): void;
}) {
  let selected: ReturnType<typeof select> | undefined;
  let phase: "pending" | "selected" | "unavailable" = "pending";
  function select() {
    options.assertAllowed();
    const root = options.root(), managed = options.managed();
    const rootId = identity(fs.lstatSync(root));
    if (fs.realpathSync(root) !== root || fs.realpathSync(managed) !== managed)
      throw new Error("Compatibility selection requires canonical Original paths.");
    const original = readManagedMcpManifest(managed);
    if (!original) throw new Error("The Original managed generation is unavailable.");
    fs.mkdirSync(options.storage, { recursive: true, mode: 0o700 });
    const storage = fs.realpathSync(options.storage);
    const storageStat = fs.lstatSync(storage);
    if (!storageStat.isDirectory() || storageStat.uid !== process.getuid?.()
      || (storageStat.mode & 0o022) !== 0 || inside(root, storage) || inside(storage, root))
      throw new Error("Compatibility control must be separate from the Knowledge Root.");
    const payload = verifyNextPayload(options.extensionPath);
    const node = pin(process.execPath);
    const supervisor = pin(path.join(options.extensionPath, "resources/next_mcp_subreaper.py"));
    const entry = pin(path.join(payload.root, "server/dist/compatibility-mcp-cli.js"));
    const launcher = pin(path.join(managed, "server.py"));
    const python = options.python();
    const generation = randomUUID();
    const runtimeBuild = hash(JSON.stringify({ payload: payload.buildId, entry, node, supervisor,
      upstream: original.runtimeBuild, architecture: "v5-mcp-with-original-business-adapter", serverName: "pkm" }));
    const control = path.join(storage, `compatibility-${generation}`);
    fs.mkdirSync(control, { mode: 0o700 });
    const configPath = path.join(control, "adapter.json");
    const config = JSON.stringify({
      schema: "pkm.compatibility-mcp/v1", knowledgeRoot: root, managedRoot: control,
      node, supervisor, python,
      legacy: { launcher, generation: original.generation, runtimeBuild: original.runtimeBuild,
        version: original.version, components: original.components, compatibleUpdates: false },
      gateway: { generation, runtimeBuild }, serverName: "pkm", writable: true,
    });
    const active = JSON.stringify({ schema: MCP_LIFECYCLE_SCHEMA, generation });
    const digest = hash(config);
    fs.writeFileSync(configPath, config, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(control, "active-generation.json"), active, { flag: "wx", mode: 0o600 });
    const assertCurrent = () => {
      options.assertAllowed();
      const current = readManagedMcpManifest(managed);
      if (options.root() !== root || options.managed() !== managed || identity(fs.lstatSync(root)) !== rootId
        || current?.generation !== original.generation || current.runtimeBuild !== original.runtimeBuild
        || hash(fs.readFileSync(configPath)) !== digest || hash(fs.readFileSync(entry.path)) !== entry.sha256
        || fs.readFileSync(path.join(control, "active-generation.json"), "utf8") !== active)
        throw new Error("Bound compatibility gateway changed. No Original fallback; reload and verify explicitly.");
    };
    assertCurrent();
    return {
      command: node.path, args: [entry.path, configPath, digest], cwd: control,
      version: payload.version, generation, runtimeBuild, originalBuild: original.runtimeBuild,
      assertCurrent,
    };
  }
  return {
    launch() {
      try {
        selected ??= select();
        selected.assertCurrent();
        phase = "selected";
        return selected;
      } catch (error) {
        phase = "unavailable";
        throw error;
      }
    },
    status() {
      if (selected) {
        try { selected.assertCurrent(); }
        catch { phase = "unavailable"; }
      }
      return { phase, selected: selected ? { generation: selected.generation, runtimeBuild: selected.runtimeBuild,
        version: selected.version, originalBuild: selected.originalBuild } : null,
        compatibleCandidates: [], scope: "native-vscode-pkm-and-pkm-chat" as const,
        storageEngine: "original" as const, storageMigrated: false as const, cutoverAuthorized: false as const };
    },
  };
}
