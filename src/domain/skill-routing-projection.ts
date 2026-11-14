import { createHash } from "node:crypto";
export const PKM_SKILL_ROUTER_VERSION = "2.0.0";

export const PKM_SKILL_MIN_MCP_VERSION = "2.8.0";

export const PKM_SKILL_SOURCE_RELATIVE = "System/PKM/PKM Skills.md";

const MARKER_PREFIX = "<!-- pkm-managed ";

const MARKER_SUFFIX = " -->";

export type PkmSkillTargetKind = "copilot" | "agents" | "claude" | "custom";

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

function markerLine(marker: ProjectionMarker): string {
  return `${MARKER_PREFIX}${JSON.stringify(marker)}${MARKER_SUFFIX}`;
}

export function parseMarker(text: string): ProjectionMarker | undefined {
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

export function readProjectionSource(raw: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/m.exec(raw);
  const frontmatter = match?.[1] || "";
  const body = (match?.[2] || raw).trim() + "\n";
  const descriptionMatch = /^description:\s*["']?(.+?)["']?\s*$/m.exec(frontmatter);
  const description = descriptionMatch?.[1] || "Discover, apply, and maintain personal PKM skills through the pkm MCP server.";
  return { raw, body, description, hash: sha256(raw) };
}

export function renderProjection(raw: string, target: { kind: PkmSkillTargetKind }, extensionVersion: string): { content: string; sourceHash: string } {
  const source = readProjectionSource(raw);
  const marker: ProjectionMarker = {
    schema: 1,
    routerVersion: PKM_SKILL_ROUTER_VERSION,
    minimumMcpSchema: PKM_SKILL_MIN_MCP_VERSION,
    source: PKM_SKILL_SOURCE_RELATIVE.replace(/\\/g, "/"),
    sourceHash: source.hash,
    extensionVersion: String(extensionVersion || "unknown"),
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
  return { content, sourceHash: source.hash,  };
}
