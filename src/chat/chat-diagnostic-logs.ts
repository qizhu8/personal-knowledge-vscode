import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const logName = /^(?:(?:\d+-)?GitHub (?:Copilot(?: Chat)?|Authentication)|exthost|remoteagent|window|main|sharedprocess)\.log$/i;
const diagnosticLine = /\b(?:auth(?:entication|orization)?|oauth|token|session|identity|401|403|error|warn(?:ing)?|disconnect|reconnect|extension host|version|proxy|timeout|certificate|ECONN\w*|ENOTFOUND)\b/i;
const maxReadBytes = 256 * 1024;

export function hostDiagnosticRoots(): Record<string, string> {
  const home = os.homedir();
  const roots: Record<string, string> = {
    "vscode-server": path.join(home, ".vscode-server", "data", "logs"),
    "vscode-server-insiders": path.join(home, ".vscode-server-insiders", "data", "logs"),
  };
  if (process.platform === "linux") roots["vscode-client"] = path.join(home, ".config", "Code", "logs");
  else if (process.platform === "darwin") roots["vscode-client"] = path.join(home, "Library", "Application Support", "Code", "logs");
  else if (process.platform === "win32" && process.env.APPDATA) roots["vscode-client"] = path.join(process.env.APPDATA, "Code", "logs");
  return roots;
}

export function redactDiagnosticLine(text: string): string {
  return text
    .replace(/((?:Got Copilot token for|Logged in as)\s+)\S+/gi, "$1[ACCOUNT]")
    .replace(/((?:prompt|messages|requestBody|responseBody|payload|content)["']?\s*[:=]\s*).*/gi, "$1[CONTENT_REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[REDACTED_AUTH]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, "[REDACTED_TOKEN]")
    .replace(/((?:access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|client[_-]?secret|password|api[_-]?key|code)[\"']?\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]")
    .replace(/https?:\/\/[^ \t"'<>]+/gi, value => {
      try { const url = new URL(value); return `${url.protocol}//${url.hostname}/[PATH_REDACTED]`; } catch { return "[URL_REDACTED]"; }
    })
    .replace(/(?:[A-Z]:\\Users\\|\/(?:home|Users)\/)[^\\/\s"']+/gi, "[HOME]")
    .slice(0, 1000);
}

function diagnosticRoot(id: unknown, roots: Record<string, string>): string {
  if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(roots, id)) throw new Error("Choose a diagnostic root returned by discover.");
  const root = roots[id];
  if (!fs.existsSync(root)) throw new Error("This diagnostic log root is not present on the execution host.");
  if (!fs.statSync(root).isDirectory() || fs.realpathSync(root) !== path.resolve(root)) throw new Error("Diagnostic roots must be real directories, not redirected paths.");
  return root;
}

export function diagnosticLogs(args: Record<string, unknown>, signal: AbortSignal, roots = hostDiagnosticRoots()): unknown {
  const active = () => { if (signal.aborted) throw new Error("Request cancelled."); };
  active();
  if (args.operation === "discover") {
    let visited = 0, truncated = false;
    const files: Array<{ root: string; file: string; bytes: number; modifiedAt: string }> = [];
    for (const [id, directory] of Object.entries(roots)) {
      active();
      if (!fs.existsSync(directory)) continue;
      const root = diagnosticRoot(id, roots);
      const walk = (relative: string, depth: number) => {
        active();
        if (depth > 5) return;
        for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name))) {
          if (++visited > 4000 || files.length >= 100) { truncated = true; return; }
          const file = path.join(relative, entry.name);
          if (entry.isDirectory() && !entry.name.startsWith(".")) walk(file, depth + 1);
          else if (entry.isFile() && logName.test(entry.name)) {
            const stat = fs.statSync(path.join(root, file));
            files.push({ root: id, file: file.split(path.sep).join("/"), bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
          }
          if (truncated) return;
        }
      };
      walk("", 0);
      if (truncated) break;
    }
    return { roots: Object.keys(roots), files: files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)), truncated,
      scope: "Only host-local VS Code diagnostic logs; client-side logs on another machine are not visible. No credentials, settings or arbitrary hidden files." };
  }
  if (args.operation !== "read") throw new Error("Choose discover or read.");
  if (args.query !== undefined && (typeof args.query !== "string" || !args.query.trim() || args.query.length > 120)) throw new Error("Choose a non-empty literal diagnostic filter up to 120 characters.");
  const root = diagnosticRoot(args.root, roots);
  if (typeof args.file !== "string" || args.file.length > 1024 || args.file.includes("\\") || args.file.split("/").some(part => !part || part.startsWith("."))
    || path.isAbsolute(args.file) || !logName.test(path.basename(args.file))) throw new Error("Choose an allowlisted relative diagnostic log from discover.");
  if (args.beforeByte !== undefined && (!Number.isSafeInteger(args.beforeByte) || Number(args.beforeByte) < 1)) throw new Error("beforeByte must be a positive byte cursor returned by a prior read.");
  let filename = root;
  for (const part of args.file.split("/")) {
    filename = path.join(filename, part);
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error("Diagnostic paths cannot contain symbolic links.");
  }
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Choose a regular diagnostic log.");
    const end = Math.min(stat.size, Number(args.beforeByte ?? stat.size)), start = Math.max(0, end - maxReadBytes);
    const buffer = Buffer.alloc(end - start);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
    active();
    const data = buffer.subarray(0, bytes);
    const firstNewline = data.indexOf(10);
    const contentStart = start && firstNewline >= 0 ? firstNewline + 1 : start ? bytes : 0;
    const content = data.subarray(contentStart);
    const lines = content.toString("utf8").split(/\r?\n/);
    const trailingPartial = content.length > 0 && content[content.length - 1] !== 10;
    if (trailingPartial) lines.pop();
    const query = typeof args.query === "string" ? args.query.toLowerCase() : undefined;
    const matches = lines.filter(line => diagnosticLine.test(line) && (!query || line.toLowerCase().includes(query))).map(redactDiagnosticLine);
    const selected = matches.slice(-40);
    while (selected.join("\n").length > 12000) selected.shift();
    return { root: args.root, file: args.file, bytes: stat.size, startByte: start, endByte: start + bytes,
      beforeByte: start ? start + (contentStart < bytes ? contentStart : 0) : null,
      partialLinesOmitted: Number(start > 0) + Number(trailingPartial),
      matchedLines: matches.length, omittedLines: matches.length - selected.length,
      excerpts: selected, redacted: true, scope: "Bounded diagnostic lines only, not full log contents. Missing matches do not prove no authentication error occurred." };
  } finally { fs.closeSync(fd); }
}
