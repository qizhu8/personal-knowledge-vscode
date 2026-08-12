import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomBytes } from "crypto";
import * as vscode from "vscode";
import { getStorePath } from "./filestore";

export const PKM_SKILL_ROUTER_VERSION = "1.0.0";
export const PKM_SKILL_MIN_MCP_VERSION = "2.1.0";
export const PKM_SKILL_SOURCE_RELATIVE = path.join("System", "PKM", "PKM Skills.md");

const CUSTOM_TARGETS_KEY = "pkm.skillProjection.customTargets.v1";
const MARKER_PREFIX = "<!-- pkm-managed ";
const MARKER_SUFFIX = " -->";

export type PkmSkillTargetKind = "copilot" | "agents" | "claude" | "custom";
export type PkmSkillTargetState = "missing" | "current" | "outdated" | "content-outdated" | "modified" | "conflict" | "unavailable";

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
  if (fs.existsSync(target)) return target;
  const bundled = bundledSourcePath(context);
  if (!fs.existsSync(bundled)) throw new Error("The bundled PKM Skill Router source is missing.");
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
  const home = os.homedir();
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
}

function findTarget(context: vscode.ExtensionContext, id: string): PkmSkillTarget {
  const target = pkmSkillTargets(context).find(item => item.id === id);
  if (!target) throw new Error(`Unknown Agent Skill target: ${id}`);
  return target;
}

export function pkmSkillProjectionStatus(context: vscode.ExtensionContext): { routerVersion: string; minimumMcpSchema: string; sourcePath: string; sourceExists: boolean; targets: PkmSkillTargetStatus[] } {
  const source = readSource(context, false);
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
              state = "outdated";
              detail = `Router ${installedVersion} -> ${PKM_SKILL_ROUTER_VERSION}`;
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
