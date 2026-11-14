import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const knowledgeArea = z.enum(["notes", "skills", "papers"]);
export type KnowledgeArea = z.infer<typeof knowledgeArea>;
const portableUnicode = z.string().regex(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/, "Paths must contain well-formed Unicode.");
const portableLength = (path: string) => Buffer.byteLength(path, "utf8") <= 2048 && path.split("/").every(part => Buffer.byteLength(part, "utf8") <= 255);

export const resourcePath = portableUnicode.min(1).max(2048).regex(
  /^(?!\/)(?!.*\\)(?!.*[\u0000-\u001f\u007f:*?"<>|])(?!.*(?:^|\/)\.)(?!.*(?:^|\/)(?:[cC][oO][nN]|[pP][rR][nN]|[aA][uU][xX]|[nN][uU][lL]|[cC][oO][mM][1-9]|[lL][pP][tT][1-9])(?:\.|\/|$))(?!.*[. ]\/)(?!.*\/\/).*[^. /]$/,
  "Use a portable relative resource path without hidden segments, traversal or reserved names.",
).refine(portableLength, "Paths are limited to 2048 UTF-8 bytes and 255 bytes per component.");

export const documentPath = portableUnicode.min(4).max(2048).regex(
  /^(?!\/)(?!.*\\)(?!.*[\u0000-\u001f\u007f:*?"<>|])(?!.*(?:^|\/)\.)(?!.*(?:^|\/)(?:[cC][oO][nN]|[pP][rR][nN]|[aA][uU][xX]|[nN][uU][lL]|[cC][oO][mM][1-9]|[lL][pP][tT][1-9])(?:\.|\/|$))(?!.*[. ]\/)(?!.*\/\/)(?!.*\.[aA][sS][sS][eE][tT][sS]\/).+\.[mM][dD]$/,
  "Use a portable relative Markdown path; hidden/resource paths, traversal and reserved names are forbidden.",
).refine(portableLength, "Paths are limited to 2048 UTF-8 bytes and 255 bytes per component.");

function checkedPath(root: string, relative: string, createParents: boolean, area: KnowledgeArea, schema: z.ZodType<string>) {
  const parsed = schema.safeParse(relative);
  if (!parsed.success) throw new Error("Invalid relative knowledge path.");
  if (!knowledgeArea.safeParse(area).success) throw new Error("Invalid knowledge storage area.");
  const notes = join(root, area);
  let directory = notes;
  for (const part of ["", ...relative.split("/").slice(0, -1)]) {
    directory = part ? join(directory, part) : directory;
    let stat;
    try { stat = lstatSync(directory); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || !createParents) throw error;
      mkdirSync(directory, { mode: 0o700 });
      if (process.platform !== "win32") {
        const descriptor = openSync(dirname(directory), "r");
        try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      }
      stat = lstatSync(directory);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Markdown parents must be real directories, not links.");
  }
  const destination = join(notes, relative);
  if (dirname(destination) !== directory) throw new Error("Markdown path escaped its checked parent.");
  return destination;
}

export function checkedDocumentPath(root: string, relative: string, createParents: boolean, area: KnowledgeArea = "notes") {
  return checkedPath(root, relative, createParents, area, documentPath);
}

export function checkedResourcePath(root: string, relative: string, createParents: boolean, area: KnowledgeArea) {
  return checkedPath(root, relative, createParents, area, resourcePath);
}
