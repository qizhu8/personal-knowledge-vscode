import { parentPort, workerData } from "worker_threads";
import * as fs from "fs";
import * as path from "path";

interface PreviousEntry { fingerprint: string; [key: string]: unknown; }
interface WorkerInput { root: string; previous: Record<string, PreviousEntry>; }

const { root, previous } = workerData as WorkerInput;
const areas = ["skills", "notes", "papers", "prompts", "scripts", "packages", "servers"];
const ignoredDirectories = new Set([".git", ".trash", "_assets", "node_modules", "dist", "artifacts", ".vscode-test", "__pycache__", ".pytest_cache", ".venv", "venv", "env"]);
const entries: Record<string, any> = {};
let scanned = 0;
let reused = 0;
let parsed = 0;
let batch: Record<string, any> = {};

function frontmatter(text: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return {};
  const result: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (!key || !raw) continue;
    try { result[key] = JSON.parse(raw); }
    catch { result[key] = raw.replace(/^["']|["']$/g, ""); }
  }
  return result;
}

function metadata(area: string, relativePath: string, fullPath: string, stat: fs.Stats, fingerprint: string): any {
  const extension = path.extname(relativePath).toLowerCase();
  const withoutExtension = relativePath.slice(0, relativePath.length - extension.length).replace(/\\/g, "/");
  const category = path.posix.dirname(withoutExtension) === "." ? "" : path.posix.dirname(withoutExtension);
  const basename = path.posix.basename(withoutExtension);
  let fields: Record<string, unknown> = {};
  if (["skills", "notes", "papers"].includes(area) && extension === ".md") {
    try { fields = frontmatter(fs.readFileSync(fullPath, "utf8")); } catch { /* unreadable file remains discoverable */ }
  }
  const title = String(fields.title || fields.name || basename);
  return {
    area, relativePath: relativePath.replace(/\\/g, "/"), fullPath, fingerprint,
    mtimeMs: stat.mtimeMs, size: stat.size, category, title,
    slug: withoutExtension, name: String(fields.name || title), description: String(fields.description || ""),
    type: String(fields.type || "general"), tags: JSON.stringify(Array.isArray(fields.tags) ? fields.tags : []),
    source_project: String(fields.source_project || ""), pinned: fields.pinned === true, extension,
  };
}

function walk(area: string, directory: string, relative = ""): void {
  let children: fs.Dirent[];
  try { children = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const child of children) {
    if (child.name.startsWith(".") || ignoredDirectories.has(child.name)) continue;
    const childRelative = relative ? `${relative}/${child.name}` : child.name;
    const fullPath = path.join(directory, child.name);
    if (child.isDirectory()) { walk(area, fullPath, childRelative); continue; }
    if (!child.isFile()) continue;
    let stat: fs.Stats;
    try { stat = fs.statSync(fullPath); } catch { continue; }
    scanned++;
    const key = `${area}/${childRelative.replace(/\\/g, "/")}`;
    const fingerprint = `${stat.mtimeMs}:${stat.size}`;
    if (previous[key]?.fingerprint === fingerprint) { entries[key] = previous[key]; reused++; }
    else { entries[key] = metadata(area, childRelative, fullPath, stat, fingerprint); batch[key] = entries[key]; parsed++; }
    if (scanned % 100 === 0) { parentPort?.postMessage({ event: "progress", scanned, reused, parsed, batch }); batch = {}; }
  }
}

for (const area of areas) walk(area, path.join(root, area));
if (Object.keys(batch).length) parentPort?.postMessage({ event: "progress", scanned, reused, parsed, batch });
parentPort?.postMessage({ event: "complete", entries, scanned, reused, parsed, removed: Object.keys(previous).filter(key => !entries[key]).length });
