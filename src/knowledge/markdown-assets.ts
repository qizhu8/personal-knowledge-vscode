import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

export type MarkdownAssetArea = "skills" | "notes" | "papers";

export interface MarkdownAsset {
  area: MarkdownAssetArea;
  path: string;
  fullPath: string;
  content: Buffer;
  digest: string;
}

function outsideCode(markdown: string): string {
  return String(markdown || "")
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .filter((_part, index) => index % 2 === 0)
    .join("\n");
}

function referencedPaths(markdown: string): string[] {
  const source = outsideCode(markdown);
  const values: string[] = [];
  for (const match of source.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g)) {
    values.push(String(match[1] || match[2] || ""));
  }
  for (const match of source.matchAll(/<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)) {
    values.push(String(match[2] || ""));
  }
  return values;
}

function localAssetReference(value: string): string | undefined {
  let reference = value.trim().replace(/&amp;/g, "&").replace(/[?#].*$/, "");
  if (!reference || reference.startsWith("/") || reference.startsWith("\\")
    || reference.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(reference)) return undefined;
  try { reference = decodeURIComponent(reference); } catch { return undefined; }
  return reference.replace(/\\/g, "/");
}

export function referencedMarkdownAssets(
  knowledgeRoot: string,
  area: MarkdownAssetArea,
  documentPath: string,
  markdown: string,
): MarkdownAsset[] {
  const areaRoot = path.resolve(knowledgeRoot, area);
  const realAreaRoot = fs.existsSync(areaRoot) ? fs.realpathSync(areaRoot) : areaRoot;
  const documentDirectory = path.dirname(path.resolve(areaRoot, documentPath));
  const assets = new Map<string, MarkdownAsset>();
  for (const rawReference of referencedPaths(markdown)) {
    const reference = localAssetReference(rawReference);
    if (!reference) continue;
    const fullPath = path.resolve(documentDirectory, reference);
    const relativePath = path.relative(areaRoot, fullPath).replace(/\\/g, "/");
    if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)
      || !relativePath.split("/").includes("_assets")) continue;
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) continue;
    const realPath = fs.realpathSync(fullPath);
    if (realPath !== realAreaRoot && !realPath.startsWith(`${realAreaRoot}${path.sep}`)) continue;
    const content = fs.readFileSync(realPath);
    assets.set(relativePath, {
      area,
      path: relativePath,
      fullPath: realPath,
      content,
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    });
  }
  return [...assets.values()].sort((left, right) => left.path.localeCompare(right.path));
}
