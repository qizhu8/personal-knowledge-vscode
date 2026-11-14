import * as fs from "fs";
import * as path from "path";

export async function readHelpGuide(extensionPath: string, language: string): Promise<{ language: string; content: string }> {
  const locale = language === "zh-hans" ? "zh-hans" : "en";
  const content = await fs.promises.readFile(path.join(extensionPath, "resources", "help", `${locale}.md`), "utf8");
  if (!content.trim() || Buffer.byteLength(content, "utf8") > 128 * 1024) {
    throw new Error("The bundled PKM Help guide is empty or exceeds its size limit.");
  }
  return { language: locale, content };
}
