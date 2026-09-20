import * as fs from "fs";
import * as path from "path";

let icon: Buffer | undefined;
let favicon = "";

export function browserIconBuffer(): Buffer | undefined {
  if (!icon) {
    try { icon = fs.readFileSync(path.join(__dirname, "..", "resources", "icon.png")); }
    catch { return undefined; }
  }
  return icon;
}

export function browserFaviconTag(href = ""): string {
  if (href) return `<link rel="icon" type="image/png" href="${href}"><link rel="shortcut icon" href="${href}">`;
  if (!favicon) {
    const value = browserIconBuffer();
    if (value) favicon = `<link rel="icon" type="image/png" href="data:image/png;base64,${value.toString("base64")}">`;
  }
  return favicon;
}