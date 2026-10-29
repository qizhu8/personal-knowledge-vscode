import { join, extname, resolve, relative, sep } from "path";
import { existsSync, readdirSync, statSync, realpathSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, copyFileSync, cpSync } from "fs";
import { createHash, randomBytes } from "crypto";
import { parsePkmLocator, PkmLocatorError } from "./knowledge-locator";

let _storePath = "";

export function setStorePath(p: string): void {
  _storePath = p?.trim() || "";
}

function safeReadDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => !n.startsWith('.'));
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// ── Prompts ───────────────────────────────────────────────────────────────
const PROMPT_METADATA = /^\s*\{#\s*PROMPT_METADATA\n(?<body>[\s\S]*?)\n\s*#\}\s*\n?/;
const TITLE_PAT = /^title:\s*(.*)$/m;
const NOTE_PAT  = /^note:\s*$/m;

export function parsePromptMetadata(content: string): { title: string; note: string; hasMetadata: boolean } {
  const m = PROMPT_METADATA.exec(content);
  if (!m) return { title: '', note: '', hasMetadata: false };
  const body  = m.groups!.body;
  const title = TITLE_PAT.exec(body)?.[1]?.trim() ?? '';
  const noteM = NOTE_PAT.exec(body);
  const note  = noteM ? body.slice(noteM.index + noteM[0].length).trim() : '';
  return { title, note, hasMetadata: true };
}

export function stripPromptMetadata(content: string): string {
  return content.replace(PROMPT_METADATA, '');
}

export interface PromptFile { name: string; size: number; }
export interface PromptVersion { version: string; files: PromptFile[]; }
export interface PromptTask {
  project: string;
  task:    string;
  versions: PromptVersion[];
  latest:  string;
}

export function promptList(): PromptTask[] {
  const base = join(_storePath, 'prompts');
  if (!existsSync(base)) return [];
  const out: PromptTask[] = [];
  for (const proj of safeReadDir(base).filter(name => !name.startsWith('.'))) {
    const projDir = join(base, proj);
    if (!isDir(projDir)) continue;
    for (const task of safeReadDir(projDir).filter(name => !name.startsWith('.'))) {
      const taskDir = join(projDir, task);
      if (!isDir(taskDir)) continue;
      const versionDirs = safeReadDir(taskDir).filter(v => !v.startsWith('.') && isDir(join(taskDir, v))).sort();
      if (!versionDirs.length) continue;
      const versions: PromptVersion[] = versionDirs.map(v => ({
        version: v,
        files: safeReadDir(join(taskDir, v))
          .filter(f => !f.startsWith('.') && !isDir(join(taskDir, v, f)))
          .map(f => ({ name: f, size: statSync(join(taskDir, v, f)).size }))
      }));
      out.push({ project: proj, task, versions, latest: versionDirs[versionDirs.length - 1] });
    }
  }
  return out;
}

export function promptGetFile(project: string, task: string, version: string, filename: string) {
  const filePath = join(_storePath, 'prompts', project, task, version, filename);
  if (!existsSync(filePath)) return null;
  const raw     = readFileSync(filePath, 'utf-8');
  const meta    = parsePromptMetadata(raw);
  const content = meta.hasMetadata ? stripPromptMetadata(raw).replace(/^\n/, '') : raw;
  return { content, raw, meta, file: filename, version, project, task };
}

export function promptGetAllVersionsOfFile(project: string, task: string, filename: string): { version: string; content: string }[] {
  const taskDir = join(_storePath, 'prompts', project, task);
  if (!existsSync(taskDir)) return [];
  return safeReadDir(taskDir)
    .filter(v => isDir(join(taskDir, v)) && existsSync(join(taskDir, v, filename)))
    .sort()
    .map(v => ({
      version: v,
      content: stripPromptMetadata(readFileSync(join(taskDir, v, filename), 'utf-8')).replace(/^\n/, '')
    }));
}

export function promptFilePath(project: string, task: string, version: string, filename = ""): string {
  const root = resolve(_storePath, "prompts");
  const target = resolve(root, project, task, version, filename);
  if (!target.startsWith(root + sep)) throw new Error("Prompt path escapes the Prompt library.");
  return target;
}

function promptMetadataBlock(title: string, note: string): string {
  if (title.includes("\n") || title.includes("\r") || note.includes("#}")) throw new Error("Prompt metadata contains an unsupported delimiter.");
  return `{# PROMPT_METADATA\ntitle: ${title.trim()}\nnote:\n${note.replace(/\s+$/, "")}\n#}\n`;
}

export function promptSaveVersionNote(
  project: string,
  task: string,
  version: string,
  filename: string,
  note: string,
  newVersion?: string,
): { version: string; file: string; meta: { title: string; note: string; hasMetadata: boolean } } {
  const sourceFile = promptFilePath(project, task, version, filename);
  if (!existsSync(sourceFile) || !statSync(sourceFile).isFile()) throw new Error("Prompt file was not found.");
  let targetVersion = version;
  if (newVersion) {
    if (!/^v\d+(?:\.\d+)*$/.test(newVersion)) throw new Error("Version must look like v10 or v9.2.");
    const sourceDir = promptFilePath(project, task, version);
    const targetDir = promptFilePath(project, task, newVersion);
    if (existsSync(targetDir)) throw new Error(`Prompt version already exists: ${newVersion}`);
    const temporaryDir = `${targetDir}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      cpSync(sourceDir, temporaryDir, { recursive: true, errorOnExist: true });
      renameSync(temporaryDir, targetDir);
    } catch (error) {
      rmSync(temporaryDir, { recursive: true, force: true });
      throw error;
    }
    targetVersion = newVersion;
  }
  const targetFile = promptFilePath(project, task, targetVersion, filename);
  const raw = readFileSync(targetFile, "utf8");
  const current = parsePromptMetadata(raw);
  const body = stripPromptMetadata(raw).replace(/^\r?\n/, "");
  const updated = promptMetadataBlock(current.title, note) + body;
  writeFileSync(targetFile, updated, "utf8");
  return { version: targetVersion, file: filename, meta: parsePromptMetadata(updated) };
}

// ── Packages ──────────────────────────────────────────────────────────────
export interface PackageSource {
  kind: "subscription-fork";
  originalName: string;
  brokerName: string;
  publisherUser: string;
  publisherHost: string;
}

function packageSource(dir: string): PackageSource | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dir, ".pkm-package.json"), "utf8"));
    if (value?.schema !== 1 || value?.kind !== "subscription-fork" || !value.originalName || !value.brokerName || !value.publisherUser || !value.publisherHost) return undefined;
    return { kind: value.kind, originalName: String(value.originalName), brokerName: String(value.brokerName), publisherUser: String(value.publisherUser), publisherHost: String(value.publisherHost) };
  } catch { return undefined; }
}

function walkFiles(dir: string, depth = 0): any[] {
  if (!existsSync(dir) || depth > 4) return [];
  return safeReadDir(dir).map(name => {
    const full = join(dir, name);
    if (isDir(full)) return { name, type: 'dir', children: walkFiles(full, depth + 1) };
    return { name, type: 'file', size: statSync(full).size };
  });
}

export function packageList() {
  const base = join(_storePath, 'packages');
  return safeReadDir(base).filter(n => isDir(join(base, n))).map(name => {
    const dir = join(base, name);
    const readmePath = ['README.md', 'README.rst', 'readme.md'].map(r => join(dir, r)).find(existsSync);
    let description = '';
    if (readmePath) {
      description = readFileSync(readmePath, 'utf-8').split('\n').slice(0, 5).join(' ')
        .replace(/[#*`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
    }
    const lang = existsSync(join(dir, 'pyproject.toml')) ? 'python'
      : existsSync(join(dir, 'package.json')) ? 'node' : 'unknown';
    return { name, description, lang, source: packageSource(dir), gitSource:existsSync(join(dir, ".pkm-git-source.json")) };
  });
}

export function packageGet(name: string) {
  const dir = join(_storePath, 'packages', name);
  if (!existsSync(dir)) return null;
  const readmePath = ['README.md', 'README.rst', 'readme.md'].map(r => join(dir, r)).find(existsSync);
  const readme = readmePath ? readFileSync(readmePath, 'utf-8') : '*(No README found)*';
  return { name, readme, tree: walkFiles(dir), source: packageSource(dir) };
}

export function packageFileGet(name: string, relPath: string) {
  if (!name || /[/\\:\0]/.test(name) || name === "." || name === ".."
    || !relPath || relPath.split(/[/\\]/).some(part => !part || part === "." || part === "..") || /[:\0]/.test(relPath)) return null;
  const root = resolve(_storePath, "packages");
  const packageRoot = resolve(root, name);
  const full = resolve(packageRoot, relPath);
  if (!full.startsWith(packageRoot + sep)) return null;
  if (!existsSync(full) || isDir(full)) return null;
  try {
    if (realpathSync(root) !== root || realpathSync(packageRoot) !== packageRoot
      || !realpathSync(full).startsWith(packageRoot + sep)) return null;
    return { content: readFileSync(full, 'utf-8'), file: relPath };
  }
  catch { return null; }
}

export function packageDelete(name: string): boolean {
  const base = join(_storePath, 'packages');
  const dir = join(base, name);
  // Guard against path traversal: resolved dir must stay inside packages/.
  const rel = require('path').relative(base, dir);
  if (!name || rel.startsWith('..') || require('path').isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) return false;
  if (!existsSync(dir) || !isDir(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

// ── Scripts ───────────────────────────────────────────────────────────────
interface ScriptIdentity {
  schema: "pkm.script/v1";
  knowledgeId: string;
  aliases: string[];
}

function validScriptIdentity(identity: ScriptIdentity): boolean {
  return identity?.schema === "pkm.script/v1" && /^script_[a-f0-9]{24}$/.test(identity.knowledgeId)
    && Array.isArray(identity.aliases) && identity.aliases.every(alias => typeof alias === "string");
}

function scriptIdentityPath(fullPath: string): string {
  return join(require("path").dirname(fullPath), `.${require("path").basename(fullPath)}.pkm.json`);
}

function scriptLegacyUris(relPath: string): string[] {
  const normalized = relPath.replace(/\\/g, "/");
  const encoded = normalized.split("/").map(encodeURIComponent).join("/");
  const legacyId = `script_${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
  return [`pkm://script/${legacyId}`, `pkm://scripts/${encoded}`];
}

function scriptReferenceOwnedElsewhere(relPath: string, references: string[]): boolean {
  return scriptList().some(row => {
    if (row.path === relPath || !existsSync(scriptIdentityFile(row.path))) return false;
    const identity = scriptIdentity(join(_storePath, "scripts", row.path), row.path);
    return references.includes(`pkm://script/${identity.knowledgeId}`)
      || identity.aliases.some(alias => references.includes(alias));
  });
}

function scriptIdentity(fullPath: string, relPath: string): ScriptIdentity {
  const sidecar = scriptIdentityPath(fullPath);
  if (existsSync(sidecar)) {
    const identity = JSON.parse(readFileSync(sidecar, "utf8")) as ScriptIdentity;
    if (!validScriptIdentity(identity)) {
      throw new Error(`Invalid Script identity: ${sidecar}`);
    }
    return identity;
  }
  const legacyUris = scriptLegacyUris(relPath);
  const reusedPath = scriptReferenceOwnedElsewhere(relPath, legacyUris);
  const identity: ScriptIdentity = {
    schema: "pkm.script/v1",
    knowledgeId: reusedPath ? `script_${randomBytes(12).toString("hex")}` : legacyUris[0].slice("pkm://script/".length),
    aliases: reusedPath ? [] : legacyUris,
  };
  writeFileSync(sidecar, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return identity;
}

function resolveScriptReference(reference: string): string | null {
  if (reference.startsWith("pkm://")) {
    const parsed = parsePkmLocator(reference);
    if (parsed.kind !== "script" && parsed.kind !== "script-path") {
      throw new PkmLocatorError("invalid", "Choose a PKM Script reference.");
    }
  }
  const isUri = reference.startsWith("pkm://script/") || reference.startsWith("pkm://scripts/");
  const legacyUri = `pkm://scripts/${reference.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
  const matches = scriptList().filter(row => {
    const sidecar = scriptIdentityFile(row.path);
    if (!existsSync(sidecar)) return false;
    const identity = scriptIdentity(join(_storePath, "scripts", row.path), row.path);
    return (isUri && reference === `pkm://script/${identity.knowledgeId}`)
      || identity.aliases.includes(isUri ? reference : legacyUri);
  });
  if (matches.length > 1) throw new PkmLocatorError("duplicate", `Script reference resolves to multiple files: ${reference}`);
  return matches.length === 1 ? matches[0].path : null;
}

export function scriptIdentityFile(relPath: string): string {
  return scriptIdentityPath(join(_storePath, "scripts", relPath));
}

export function scriptList() {
  const base = join(_storePath, 'scripts');
  const out: { category: string; file: string; path: string; lang: string; langs: string[] }[] = [];
  if (!existsSync(base)) return out;
  if (relative(join(realpathSync(_storePath), "scripts"), realpathSync(base))) throw new Error("Script root resolves outside the Knowledge Root scripts directory.");
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (name.startsWith(".") || entry.isSymbolicLink()) continue;
      const full = join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (entry.isDirectory()) { walk(full, childRel); continue; }
      if (!entry.isFile()) continue;
      const category = rel || "(root)";
      const langs = detectScriptLangs(full, name);
      out.push({ category, file: name, path: childRel, lang: langs.join(" + "), langs });
    }
  };
  walk(base, "");
  return out;
}

export function scriptSearch(q: string, options: { regex?: boolean; caseSensitive?: boolean } = {}) {
  const source = options.regex ? q : String(q || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let pattern: RegExp;
  try { pattern = new RegExp(source, options.caseSensitive ? '' : 'i'); } catch { return []; }
  return scriptList().filter(script => {
    if ([script.file, script.path, script.category, script.lang, ...script.langs]
      .some(value => pattern.test(String(value || '')))) return true;
    return pattern.test(scriptGet(script.path)?.content || '');
  });
}

export function scriptGet(relPath: string, _legacy?: string) {
  // Backward compatible: (category, file) OR (relPath)
  let rel = _legacy ? `${relPath}/${_legacy}` : relPath;
  if (rel.startsWith("pkm://") || !existsSync(join(_storePath, "scripts", rel))) {
    rel = resolveScriptReference(rel) || rel;
  }
  const full = join(_storePath, 'scripts', rel);
  if (!existsSync(full) || isDir(full)) return null;
  try {
    const name = rel.split('/').pop() ?? rel;
    const langs = detectScriptLangs(full, name);
    const identity = scriptIdentity(full, rel);
    return {
      content: readFileSync(full, 'utf-8'),
      file: name,
      path: rel,
      lang: langs.join(" + "),
      langs,
      knowledgeId: identity.knowledgeId,
      aliases: identity.aliases,
    };
  } catch (error) {
    if (existsSync(full)) throw error;
    return null;
  }
}

/** Detect the coding language(s) of a script — returns one tag per language. */
export function detectScriptLangs(fullPath: string, name: string): string[] {
  const ext = extname(name).toLowerCase();
  let sample = "";
  try { sample = readFileSync(fullPath, 'utf-8').slice(0, 20000); } catch { /* ignore */ }

  if (ext === '.cs')   return ['C#'];
  if (ext === '.py')   return ['Python'];
  if (ext === '.ps1')  return ['PowerShell'];
  if (ext === '.usql') return ['U-SQL'];
  if (ext === '.sql')  return ['SQL'];
  if (ext === '.sh')   return ['Shell'];

  if (ext === '.script') {
    const langs = ['Scope'];
    const hasCS = /#CS\b|#ENDCS\b|\bpublic\s+(class|static|struct)\b|\busing\s+System\b/.test(sample);
    const hasPy = /\bPython(Reducer|Processor|Combiner|Mapper)?\b|#PY\b|\.py"|\bimport\s+\w+/.test(sample);
    if (hasCS) langs.push('C#');
    if (hasPy) langs.push('Python');
    return langs;
  }
  return [ext ? ext.slice(1).toUpperCase() : 'text'];
}

/** Legacy single-string language (joined) for backward compatibility. */
export function detectScriptLang(fullPath: string, name: string): string {
  return detectScriptLangs(fullPath, name).join(" + ");
}

// ── Bulk export for sync ──────────────────────────────────────────────────
const TEXT_EXTS = new Set(['.jinja2','.jinja','.txt','.md','.json','.yaml','.yml','.py','.sh','.ts','.js','.toml','.cfg','.ini','.rst','.csv']);
const MAX_FILE_BYTES = 512 * 1024; // 512 KB cap per file

function isTextFile(name: string): boolean {
  return TEXT_EXTS.has(extname(name).toLowerCase());
}

function readTextSafe(path: string): string | null {
  try {
    const st = statSync(path);
    if (st.size > MAX_FILE_BYTES) return null;
    return readFileSync(path, 'utf-8');
  } catch { return null; }
}

export function promptExport(): { project: string; task: string; version: string; file: string; content: string }[] {
  const base = join(_storePath, 'prompts');
  const out: { project: string; task: string; version: string; file: string; content: string }[] = [];
  for (const proj of safeReadDir(base)) {
    const projDir = join(base, proj);
    if (!isDir(projDir)) continue;
    for (const task of safeReadDir(projDir)) {
      const taskDir = join(projDir, task);
      if (!isDir(taskDir)) continue;
      for (const ver of safeReadDir(taskDir).filter(v => isDir(join(taskDir, v)))) {
        for (const fname of safeReadDir(join(taskDir, ver)).filter(f => !isDir(join(taskDir, ver, f)))) {
          const content = readTextSafe(join(taskDir, ver, fname));
          if (content !== null) out.push({ project: proj, task, version: ver, file: fname, content });
        }
      }
    }
  }
  return out;
}

// ── Script move (raw files under scripts/<category>/<file>) ─────────────────
function safeScriptCat(cat: string): string {
  return (cat || "").split("/").map(s => s.trim().replace(/[<>:"\\|?*\u0000-\u001f]/g, "")).filter(Boolean).join("/");
}

/** Move a single script file to a different category folder (parents created). */
export function scriptMove(relPath: string, newCategory: string): boolean {
  const src = join(_storePath, 'scripts', relPath);
  if (!existsSync(src) || isDir(src)) return false;
  const name = relPath.split('/').pop()!;
  const cat = safeScriptCat(newCategory);
  const destDir = cat ? join(_storePath, 'scripts', ...cat.split('/')) : join(_storePath, 'scripts');
  const dest = join(destDir, name);
  if (dest === src) return false;
  if (existsSync(dest) || existsSync(scriptIdentityPath(dest))) return false;
  const identity = scriptIdentity(src, relPath);
  const destinationPath = cat ? `${cat}/${name}` : name;
  if (scriptReferenceOwnedElsewhere(relPath, scriptLegacyUris(destinationPath))) return false;
  const aliases = [...new Set([...identity.aliases, ...scriptLegacyUris(relPath), ...scriptLegacyUris(destinationPath)])].sort();
  mkdirSync(destDir, { recursive: true });
  try {
    renameSync(src, dest);
    renameSync(scriptIdentityPath(src), scriptIdentityPath(dest));
    writeFileSync(scriptIdentityPath(dest), `${JSON.stringify({ ...identity, aliases }, null, 2)}\n`, "utf8");
  } catch {
    if (existsSync(dest) && !existsSync(src)) renameSync(dest, src);
    if (existsSync(scriptIdentityPath(dest)) && !existsSync(scriptIdentityPath(src))) renameSync(scriptIdentityPath(dest), scriptIdentityPath(src));
    return false;
  }
  return true;
}

/** Move/rename a script category folder: re-path every script under `oldPrefix`. */
export function scriptMoveFolder(oldPrefix: string, newPrefix: string): number {
  const op = (oldPrefix || "").replace(/^\/+|\/+$/g, "");
  const np = safeScriptCat(newPrefix);
  if (!op || !np || op === np) return 0;
  let n = 0;
  for (const s of scriptList()) {
    const cat = s.category === "(root)" ? "" : s.category;
    if (cat === op || cat.startsWith(op + "/")) {
      const newCat = np + cat.slice(op.length);
      if (scriptMove(s.path, newCat)) n++;
    }
  }
  return n;
}

export function scriptExport(): { category: string; file: string; content: string; identity: ScriptIdentity }[] {
  const base = join(_storePath, 'scripts');
  const out: { category: string; file: string; content: string; identity: ScriptIdentity }[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of safeReadDir(dir)) {
      const full = join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (isDir(full)) { walk(full, childRel); continue; }
      const content = readTextSafe(full);
      if (content !== null) {
        const category = rel || "(root)";
        out.push({ category, file: name, content, identity: scriptIdentity(full, childRel) });
      }
    }
  };
  walk(base, "");
  return out;
}

export function packageExport(): { name: string; files: { path: string; content: string }[] }[] {
  const base = join(_storePath, 'packages');
  const out: { name: string; files: { path: string; content: string }[] }[] = [];
  for (const pkg of safeReadDir(base).filter(n => isDir(join(base, n)))) {
    const files: { path: string; content: string }[] = [];
    function collect(dir: string, rel: string): void {
      for (const name of safeReadDir(dir)) {
        const full = join(dir, name);
        const relPath = rel ? `${rel}/${name}` : name;
        if (isDir(full)) { collect(full, relPath); }
        else if (isTextFile(name)) {
          const content = readTextSafe(full);
          if (content !== null) files.push({ path: relPath, content });
        }
      }
    }
    collect(join(base, pkg), '');
    if (files.length) out.push({ name: pkg, files });
  }
  return out;
}

export function promptImport(items: { project: string; task: string; version: string; file: string; content: string }[]): number {
  let count = 0;
  for (const item of items) {
    try {
      const dir = join(_storePath, 'prompts', item.project, item.task, item.version);
      if (!existsSync(dir)) { const { mkdirSync } = require('fs'); mkdirSync(dir, { recursive: true }); }
      const { writeFileSync } = require('fs');
      writeFileSync(join(dir, item.file), item.content, 'utf-8');
      count++;
    } catch { /* skip */ }
  }
  return count;
}

export function scriptImport(items: { category: string; file: string; content: string; identity?: ScriptIdentity }[]): number {
  let count = 0;
  for (const item of items) {
    try {
      const dir = join(_storePath, 'scripts', item.category);
      const full = join(dir, item.file);
      const rel = item.category ? `${item.category}/${item.file}` : item.file;
      const sidecar = scriptIdentityPath(full);
      const incoming = item.identity;
      const existing = incoming && existsSync(sidecar) ? scriptIdentity(full, rel) : undefined;
      if (incoming && !validScriptIdentity(incoming)) continue;
      if (incoming) {
        if (existing && existing.knowledgeId !== incoming.knowledgeId) continue;
        if (!existing && existsSync(full) && scriptLegacyUris(rel)[0] !== `pkm://script/${incoming.knowledgeId}`) continue;
        if (scriptReferenceOwnedElsewhere(rel, [`pkm://script/${incoming.knowledgeId}`, ...incoming.aliases])) continue;
      }
      if (!existsSync(dir)) { const { mkdirSync } = require('fs'); mkdirSync(dir, { recursive: true }); }
      const { writeFileSync } = require('fs');
      if (incoming && !existsSync(sidecar)) {
        const aliases = [...new Set([...incoming.aliases,
          ...scriptLegacyUris(rel).filter(alias => !scriptReferenceOwnedElsewhere(rel, [alias]))])].sort();
        writeFileSync(sidecar, `${JSON.stringify({ ...incoming, aliases }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        try { writeFileSync(full, item.content, 'utf-8'); }
        catch (error) { rmSync(sidecar); throw error; }
      } else {
        writeFileSync(full, item.content, 'utf-8');
        if (incoming && existing) {
          const aliases = [...new Set([...existing.aliases, ...incoming.aliases])].sort();
          if (aliases.length !== existing.aliases.length) {
            writeFileSync(sidecar, `${JSON.stringify({ ...existing, aliases }, null, 2)}\n`, 'utf8');
          }
        }
      }
      count++;
    } catch { /* skip */ }
  }
  return count;
}

export function packageImport(pkgs: { name: string; files: { path: string; content: string }[] }[]): number {
  let count = 0;
  for (const pkg of pkgs) {
    for (const f of pkg.files) {
      try {
        const parts = f.path.replace(/\\/g, '/').split('/');
        const dir   = join(_storePath, 'packages', pkg.name, ...parts.slice(0, -1));
        const { mkdirSync, writeFileSync } = require('fs');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, parts[parts.length - 1]), f.content, 'utf-8');
        count++;
      } catch { /* skip */ }
    }
  }
  return count;
}
