import * as path from "path";

export const LF_TEXT_EXTENSIONS: readonly string[] = [
  ".md", ".markdown", ".rst", ".txt", ".json", ".jsonc", ".yaml", ".yml",
  ".toml", ".cfg", ".ini", ".conf", ".config", ".xml", ".html", ".htm",
  ".css", ".scss", ".less", ".svg", ".csv", ".tsv", ".jinja", ".jinja2",
  ".tmpl", ".template", ".script", ".scope", ".sql", ".usql", ".cs",
  ".py", ".pyi", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".ps1", ".psm1", ".psd1", ".sh", ".bash", ".zsh", ".fish", ".bat", ".cmd",
  ".c", ".cpp", ".cc", ".h", ".hpp", ".java", ".go", ".rs", ".r",
  ".rb", ".php", ".pl", ".lua", ".fs", ".fsx", ".vb", ".vue", ".svelte",
  ".ipynb", ".tex", ".log",
];

const lfExtensions = new Set(LF_TEXT_EXTENSIONS);

export function textNewlinePolicy(relative: string): "lf" | "preserve" {
  return lfExtensions.has(path.posix.extname(relative.replace(/\\/g, "/")).toLowerCase()) ? "lf" : "preserve";
}

export function convertTextNewlines(content: Buffer, target: "lf" | "crlf"): Buffer {
  if (target !== "lf" && target !== "crlf") throw new Error("Unsupported target newline format.");
  const text = content.toString("utf8");
  if (content.includes(0) || !Buffer.from(text, "utf8").equals(content)) {
    throw new Error("Newline conversion requires valid UTF-8 text without NUL bytes.");
  }
  const lf = text.replace(/\r\n/g, "\n");
  const converted = target === "lf" ? lf : lf.replace(/\n/g, "\r\n");
  return converted === text ? content : Buffer.from(converted, "utf8");
}

export function normalizeTextNewlines(relative: string, content: Buffer): Buffer {
  if (textNewlinePolicy(relative) !== "lf" || content.includes(0)) return content;
  const text = content.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(content) || !text.includes("\r\n")) return content;
  return convertTextNewlines(content, "lf");
}
