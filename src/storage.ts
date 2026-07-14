import { homedir } from "os";
import { join, extname } from "path";
import { existsSync, readdirSync, statSync, readFileSync, mkdirSync, renameSync, rmSync, copyFileSync } from "fs";

let _storePath = join(homedir(), "personal-knowledge");

export function setStorePath(p: string): void {
  _storePath = p?.trim() || join(homedir(), "personal-knowledge");
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
  for (const proj of safeReadDir(base)) {
    const projDir = join(base, proj);
    if (!isDir(projDir)) continue;
    for (const task of safeReadDir(projDir)) {
      const taskDir = join(projDir, task);
      if (!isDir(taskDir)) continue;
      const versionDirs = safeReadDir(taskDir).filter(v => isDir(join(taskDir, v))).sort();
      if (!versionDirs.length) continue;
      const versions: PromptVersion[] = versionDirs.map(v => ({
        version: v,
        files: safeReadDir(join(taskDir, v))
          .filter(f => !isDir(join(taskDir, v, f)))
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

// ── Packages ──────────────────────────────────────────────────────────────
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
    return { name, description, lang };
  });
}

export function packageGet(name: string) {
  const dir = join(_storePath, 'packages', name);
  if (!existsSync(dir)) return null;
  const readmePath = ['README.md', 'README.rst', 'readme.md'].map(r => join(dir, r)).find(existsSync);
  const readme = readmePath ? readFileSync(readmePath, 'utf-8') : '*(No README found)*';
  return { name, readme, tree: walkFiles(dir) };
}

export function packageFileGet(name: string, relPath: string) {
  const full = join(_storePath, 'packages', name, relPath);
  if (!existsSync(full) || isDir(full)) return null;
  try { return { content: readFileSync(full, 'utf-8'), file: relPath }; }
  catch { return null; }
}

// ── Scripts ───────────────────────────────────────────────────────────────
export function scriptList() {
  const base = join(_storePath, 'scripts');
  const out: { category: string; file: string; path: string; lang: string; langs: string[] }[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of safeReadDir(dir)) {
      const full = join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (isDir(full)) { walk(full, childRel); continue; }
      const category = rel || "(root)";
      const langs = detectScriptLangs(full, name);
      out.push({ category, file: name, path: childRel, lang: langs.join(" + "), langs });
    }
  };
  walk(base, "");
  return out;
}

export function scriptGet(relPath: string, _legacy?: string) {
  // Backward compatible: (category, file) OR (relPath)
  const rel = _legacy ? `${relPath}/${_legacy}` : relPath;
  const full = join(_storePath, 'scripts', rel);
  if (!existsSync(full) || isDir(full)) return null;
  try {
    const name = rel.split('/').pop() ?? rel;
    const langs = detectScriptLangs(full, name);
    return {
      content: readFileSync(full, 'utf-8'),
      file: name,
      path: rel,
      lang: langs.join(" + "),
      langs,
    };
  } catch { return null; }
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
  mkdirSync(destDir, { recursive: true });
  try { renameSync(src, dest); }
  catch { try { copyFileSync(src, dest); rmSync(src, { force: true }); } catch { return false; } }
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

export function scriptExport(): { category: string; file: string; content: string }[] {
  const base = join(_storePath, 'scripts');
  const out: { category: string; file: string; content: string }[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of safeReadDir(dir)) {
      const full = join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (isDir(full)) { walk(full, childRel); continue; }
      const content = readTextSafe(full);
      if (content !== null) {
        const category = rel || "(root)";
        out.push({ category, file: name, content });
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

export function scriptImport(items: { category: string; file: string; content: string }[]): number {
  let count = 0;
  for (const item of items) {
    try {
      const dir = join(_storePath, 'scripts', item.category);
      if (!existsSync(dir)) { const { mkdirSync } = require('fs'); mkdirSync(dir, { recursive: true }); }
      const { writeFileSync } = require('fs');
      writeFileSync(join(dir, item.file), item.content, 'utf-8');
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
