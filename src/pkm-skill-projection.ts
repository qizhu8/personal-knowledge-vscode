import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomBytes } from "crypto";
import * as vscode from "vscode";
import { getStorePath } from "./filestore";
import { compareVersionOrder } from "./version-order";

export const PKM_SKILL_ROUTER_VERSION = "1.5.0";
export const PKM_SKILL_MIN_MCP_VERSION = "2.8.0";
export const PKM_SKILL_SOURCE_RELATIVE = path.join("System", "PKM", "PKM Skills.md");

const LEGACY_BUNDLED_SOURCE_HASHES = new Set([
  "a7698a2b99e23f88aa9fd84d8d01cb9984e843e1b46fda426d349d95bdfeaa74", // Router 1.0.0
  "90e969afbde64e489d6856a6df078d2e6da4a847c961496960d6e7d6d0e41588", // Router 1.1.0
  "2da9ae268a9f6c828d466650fb2db1b812a00aeb30c6b25862ca24346bacbef9", // Router 1.1.1
  "e200f9d3967f4e0f0779f59ae6ecdde4afac834b6c3b18fe7be557daf242265a", // Router 1.1.2
  "6e4d01d6b905b96879225119a8c76597984abe3b8ef1d84858c8cea5e064da5d", // Router 1.1.3
  "763311e1c6e8d7c3b9807914b81453b0da45c00ba7c47d2054719b3f179bb371", // Router 1.1.4
  "614f9aec0acd2f90d4072d83649b7cfc1b0625723ede396505c82c11a86e49aa", // Router 1.1.5
  "346a18db7462d92957e820f5c49b6e528de123071db49733ba1a1069cc990eb8", // Router 1.1.6
  "0cae8cda7b1aad7f3f5ac8b18acd4ac903cad815e5a91cfd571faaaf1a0b3943", // Router 1.2.0 bundled
  "bd3dc30cc22c6814ef518bfcabbe844440ed8de8ca6c439c2c6a56b8fd3d0b3e", // Router 1.2.0 canonical
  "b3644f21b8cf5f6f6a533088b40b60c364ee0b10ec333cc294eb6e4be379a17f", // Router 1.3.0 canonical
  "c0c2e516dfa19aaf8510dd847ed0318f997c1a7e5b90d50c869e15be54e7c3d2", // Router 1.3.1 bundled
  "87d95455175f8c1ca694ed1fae924b3fd96f5dab3f43723a0a3f1db7abc6a7ac", // Router 1.4.0 bundled
  "443d25a7a2c34350475d2008b612060e8aaf303a8fe06c5c10f6f92c2e231c5b", // Router 1.4.0 canonical
]);

const CUSTOM_TARGETS_KEY = "pkm.skillProjection.customTargets.v1";
const CONNECTED_TARGETS_KEY = "pkm.skillProjection.connectedTargets.v1";
const MARKER_PREFIX = "<!-- pkm-managed ";
const MARKER_SUFFIX = " -->";

export type PkmSkillTargetKind = "copilot" | "agents" | "claude" | "custom";
export type PkmSkillTargetState = "missing" | "current" | "outdated" | "newer" | "content-outdated" | "modified" | "conflict" | "unavailable";

export interface PkmSkillTarget {
  id: string;
  kind: PkmSkillTargetKind;
  label: string;
  root: string;
}

export function resolvePkmSkillTargetPath(
  input: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  let value = String(input || "").trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!value) throw new Error("Enter an Agent Skills root directory.");
  value = value.replace(/^~(?=$|[\\/])/, home);
  value = value.replace(/%([^%]+)%/g, (match, name) => environment[name] ?? environment[name.toUpperCase()] ?? match);
  value = value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, plain) => environment[braced || plain] ?? match);
  if (/%[^%]+%|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(value)) {
    throw new Error(`The path contains an unknown environment variable: ${value}`);
  }
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
  if (platform === "win32") {
    if (!windowsAbsolute) throw new Error("Enter an absolute Windows path, such as %USERPROFILE%\\.copilot\\skills or C:\\AgentSkills.");
    return path.win32.normalize(value);
  }
  if (windowsAbsolute) {
    throw new Error("This is a Windows path, but the Extension Host is running on Linux/macOS. Configure it in the local Windows window, or enter a path on this host.");
  }
  if (!path.posix.isAbsolute(value)) throw new Error("Enter an absolute path, such as ~/.copilot/skills or /home/me/agent-skills.");
  return path.posix.normalize(value);
}

export interface PkmSkillTargetStatus extends PkmSkillTarget {
  skillPath: string;
  state: PkmSkillTargetState;
  installedVersion: string;
  expectedVersion: string;
  installedSourceHash: string;
  expectedSourceHash: string;
  detail: string;
  managed: boolean;
  connected: boolean;
}

interface ProjectionMarker {
  schema: 1;
  routerVersion: string;
  minimumMcpSchema: string;
  source: string;
  sourceHash: string;
  extensionVersion: string;
  target: PkmSkillTargetKind;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalSourcePath(): string {
  return path.join(getStorePath(), "skills", PKM_SKILL_SOURCE_RELATIVE);
}

function bundledSourcePath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, "resources", "pkm-skills-router.md");
}

function ensureCanonicalSource(context: vscode.ExtensionContext): string {
  const target = canonicalSourcePath();
  const bundled = bundledSourcePath(context);
  if (!fs.existsSync(bundled)) throw new Error("The bundled PKM Skill Router source is missing.");
  if (fs.existsSync(target)) {
    const current = fs.readFileSync(target, "utf8");
    if (!LEGACY_BUNDLED_SOURCE_HASHES.has(sha256(current))) return target;
    const temp = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    fs.copyFileSync(bundled, temp);
    fs.renameSync(temp, target);
    return target;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(bundled, target);
  return target;
}

function readSource(context: vscode.ExtensionContext, create: boolean): { path: string; raw: string; body: string; description: string; hash: string } {
  const sourcePath = create ? ensureCanonicalSource(context) : canonicalSourcePath();
  const actualPath = fs.existsSync(sourcePath) ? sourcePath : bundledSourcePath(context);
  const raw = fs.readFileSync(actualPath, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/m.exec(raw);
  const frontmatter = match?.[1] || "";
  const body = (match?.[2] || raw).trim() + "\n";
  const descriptionMatch = /^description:\s*["']?(.+?)["']?\s*$/m.exec(frontmatter);
  const description = descriptionMatch?.[1] || "Discover, apply, and maintain personal PKM skills through the pkm MCP server.";
  return { path: sourcePath, raw, body, description, hash: sha256(raw) };
}

function markerLine(marker: ProjectionMarker): string {
  return `${MARKER_PREFIX}${JSON.stringify(marker)}${MARKER_SUFFIX}`;
}

function parseMarker(text: string): ProjectionMarker | undefined {
  const start = text.indexOf(MARKER_PREFIX);
  if (start < 0) return undefined;
  const end = text.indexOf(MARKER_SUFFIX, start);
  if (end < 0) return undefined;
  try {
    const marker = JSON.parse(text.slice(start + MARKER_PREFIX.length, end));
    return marker?.schema === 1 ? marker : undefined;
  } catch {
    return undefined;
  }
}

function renderProjection(context: vscode.ExtensionContext, target: PkmSkillTarget, createSource: boolean): { content: string; sourceHash: string; sourcePath: string } {
  const source = readSource(context, createSource);
  const marker: ProjectionMarker = {
    schema: 1,
    routerVersion: PKM_SKILL_ROUTER_VERSION,
    minimumMcpSchema: PKM_SKILL_MIN_MCP_VERSION,
    source: PKM_SKILL_SOURCE_RELATIVE.replace(/\\/g, "/"),
    sourceHash: source.hash,
    extensionVersion: String(context.extension?.packageJSON?.version || "unknown"),
    target: target.kind,
  };
  const description = source.description.replace(/'/g, "''");
  const content = [
    "---",
    "name: pkm-skills",
    `description: '${description}'`,
    "user-invocable: false",
    "disable-model-invocation: false",
    "---",
    "",
    markerLine(marker),
    "",
    source.body.trimEnd(),
    "",
  ].join("\n");
  return { content, sourceHash: source.hash, sourcePath: source.path };
}

function skillPath(target: PkmSkillTarget): string {
  return path.join(target.root, "pkm-skills", "SKILL.md");
}

function presetTargets(): PkmSkillTarget[] {
  const home = process.platform === "win32"
    ? process.env.USERPROFILE || os.homedir()
    : process.env.HOME || os.homedir();
  return [
    { id: "copilot", kind: "copilot", label: "GitHub Copilot", root: path.join(home, ".copilot", "skills") },
    { id: "agents", kind: "agents", label: "Generic Agents", root: path.join(home, ".agents", "skills") },
    { id: "claude", kind: "claude", label: "Claude", root: path.join(home, ".claude", "skills") },
  ];
}

export function pkmSkillTargets(context: vscode.ExtensionContext): PkmSkillTarget[] {
  const custom = context.globalState.get<PkmSkillTarget[]>(CUSTOM_TARGETS_KEY, [])
    .filter(target => target?.id && target?.root && path.isAbsolute(target.root));
  return [...presetTargets(), ...custom];
}

export async function addPkmSkillCustomTarget(context: vscode.ExtensionContext, root: string, label?: string): Promise<PkmSkillTarget> {
  const resolved = resolvePkmSkillTargetPath(root);
  const custom = context.globalState.get<PkmSkillTarget[]>(CUSTOM_TARGETS_KEY, []);
  const existing = custom.find(target => path.resolve(target.root) === resolved);
  if (existing) return existing;
  const target: PkmSkillTarget = {
    id: `custom-${sha256(resolved).slice(0, 12)}`,
    kind: "custom",
    label: String(label || path.basename(resolved) || "Custom Agent").trim(),
    root: resolved,
  };
  await context.globalState.update(CUSTOM_TARGETS_KEY, [...custom, target]);
  return target;
}

export async function removePkmSkillCustomTarget(context: vscode.ExtensionContext, id: string): Promise<void> {
  const custom = context.globalState.get<PkmSkillTarget[]>(CUSTOM_TARGETS_KEY, []);
  await context.globalState.update(CUSTOM_TARGETS_KEY, custom.filter(target => target.id !== id));
  const connected = context.globalState.get<string[]>(CONNECTED_TARGETS_KEY, []);
  if (connected.includes(id)) {
    await context.globalState.update(CONNECTED_TARGETS_KEY, connected.filter(targetId => targetId !== id));
  }
}

function findTarget(context: vscode.ExtensionContext, id: string): PkmSkillTarget {
  const target = pkmSkillTargets(context).find(item => item.id === id);
  if (!target) throw new Error(`Unknown Agent Skill target: ${id}`);
  return target;
}

export function pkmSkillProjectionStatus(context: vscode.ExtensionContext): { routerVersion: string; minimumMcpSchema: string; sourcePath: string; sourceExists: boolean; targets: PkmSkillTargetStatus[] } {
  const source = readSource(context, false);
  const connectedIds = new Set(context.globalState.get<string[]>(CONNECTED_TARGETS_KEY, []));
  const targets = pkmSkillTargets(context).map(target => {
    const projected = renderProjection(context, target, false);
    const file = skillPath(target);
    let state: PkmSkillTargetState = "missing";
    let detail = "Not injected.";
    let installedVersion = "";
    let installedSourceHash = "";
    let managed = false;
    try {
      if (fs.existsSync(file)) {
        const current = fs.readFileSync(file, "utf8");
        const marker = parseMarker(current);
        if (!marker) {
          state = "conflict";
          detail = "A non-PKM Skill already exists at this path.";
        } else {
          managed = true;
          installedVersion = marker.routerVersion || "legacy";
          installedSourceHash = marker.sourceHash || "";
          if (current !== projected.content) {
            if (installedVersion !== PKM_SKILL_ROUTER_VERSION) {
              const order = compareVersionOrder(installedVersion, PKM_SKILL_ROUTER_VERSION);
              state = order !== undefined && order > 0 ? "newer" : "outdated";
              detail = state === "newer"
                ? `Newer Router ${installedVersion} is already installed. Reload this VS Code window.`
                : `Router ${installedVersion} -> ${PKM_SKILL_ROUTER_VERSION}`;
            } else if (installedSourceHash !== source.hash) {
              state = "content-outdated";
              detail = "The canonical PKM Skill changed.";
            } else {
              state = "modified";
              detail = "The generated Skill was modified outside PKM.";
            }
          } else {
            state = "current";
            detail = "Injected Skill is current.";
          }
        }
      }
    } catch (error) {
      state = "unavailable";
      detail = (error as Error).message;
    }
    return {
      ...target,
      skillPath: file,
      state,
      installedVersion,
      expectedVersion: PKM_SKILL_ROUTER_VERSION,
      installedSourceHash,
      expectedSourceHash: source.hash,
      detail,
      managed,
      connected: connectedIds.has(target.id) || managed,
    };
  });
  return {
    routerVersion: PKM_SKILL_ROUTER_VERSION,
    minimumMcpSchema: PKM_SKILL_MIN_MCP_VERSION,
    sourcePath: source.path,
    sourceExists: fs.existsSync(source.path),
    targets,
  };
}

export function injectPkmSkill(context: vscode.ExtensionContext, id: string): PkmSkillTargetStatus {
  const target = findTarget(context, id);
  const file = skillPath(target);
  if (fs.existsSync(file) && !parseMarker(fs.readFileSync(file, "utf8"))) {
    throw new Error(`Refusing to overwrite a non-PKM Skill at ${file}`);
  }
  if (fs.existsSync(file)) {
    const marker = parseMarker(fs.readFileSync(file, "utf8"));
    if (marker && (compareVersionOrder(marker.routerVersion, PKM_SKILL_ROUTER_VERSION) || 0) > 0) {
      throw new Error(`Refusing to replace newer PKM Skill Router v${marker.routerVersion} with v${PKM_SKILL_ROUTER_VERSION}. Reload this VS Code window.`);
    }
  }
  const projected = renderProjection(context, target, true);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, projected.content, { encoding: "utf8", mode: 0o644 });
  fs.renameSync(temp, file);
  return pkmSkillProjectionStatus(context).targets.find(item => item.id === id)!;
}

export function removeInjectedPkmSkill(context: vscode.ExtensionContext, id: string): void {
  const target = findTarget(context, id);
  const file = skillPath(target);
  if (!fs.existsSync(file)) return;
  const current = fs.readFileSync(file, "utf8");
  if (!parseMarker(current)) throw new Error(`Refusing to remove a non-PKM Skill at ${file}`);
  fs.rmSync(file, { force: true });
  try { fs.rmdirSync(path.dirname(file)); } catch { /* target contains other files */ }
}

async function updateConnectedTargets(context: vscode.ExtensionContext, ids: Iterable<string>): Promise<void> {
  const next = [...new Set(ids)].sort();
  const current = [...new Set(context.globalState.get<string[]>(CONNECTED_TARGETS_KEY, []))].sort();
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    await context.globalState.update(CONNECTED_TARGETS_KEY, next);
  }
}

export async function connectPkmSkill(context: vscode.ExtensionContext, id: string): Promise<PkmSkillTargetStatus> {
  const target = injectPkmSkill(context, id);
  const connected = new Set(context.globalState.get<string[]>(CONNECTED_TARGETS_KEY, []));
  connected.add(id);
  await updateConnectedTargets(context, connected);
  return { ...target, connected: true };
}

export async function disconnectPkmSkill(context: vscode.ExtensionContext, id: string): Promise<void> {
  removeInjectedPkmSkill(context, id);
  const connected = new Set(context.globalState.get<string[]>(CONNECTED_TARGETS_KEY, []));
  connected.delete(id);
  await updateConnectedTargets(context, connected);
}

export async function reconcilePkmSkillProjections(
  context: vscode.ExtensionContext,
): Promise<{ updated: PkmSkillTargetStatus[]; actionRequired: PkmSkillTargetStatus[] }> {
  const before = pkmSkillProjectionStatus(context);
  const connected = new Set(context.globalState.get<string[]>(CONNECTED_TARGETS_KEY, []));
  for (const target of before.targets) {
    if (target.managed) connected.add(target.id);
  }
  await updateConnectedTargets(context, connected);

  const repairable = new Set<PkmSkillTargetState>(["missing", "outdated", "content-outdated", "modified"]);
  const updated: PkmSkillTargetStatus[] = [];
  for (const target of before.targets) {
    if (connected.has(target.id) && repairable.has(target.state)) {
      updated.push(injectPkmSkill(context, target.id));
    }
  }
  const after = pkmSkillProjectionStatus(context);
  return {
    updated,
    actionRequired: after.targets.filter(target => target.connected
      && (target.state === "newer" || target.state === "conflict" || target.state === "unavailable")),
  };
}
