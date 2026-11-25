import { z } from "zod";
import { knowledgeArea, resourcePath } from "./document-path.js";

// Custody areas are deliberately distinct from the Markdown document domain.
export const opaqueTrashArea = z.enum(["scripts", "prompts"]);
export const trashCustodyArea = z.enum([...knowledgeArea.options, ...opaqueTrashArea.options]);
export type TrashCustodyArea = z.infer<typeof trashCustodyArea>;
export const opaqueTrashPath = resourcePath.refine(path =>
  !path.split("/").some(part => /\.assets$/i.test(part) || ["system", "_assets", ".trash"].includes(part.toLowerCase())),
"Opaque Trash selects a regular source, never a resource or reserved subtree.");
export const opaqueTrashFile = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative().max(16 * 1024 * 1024),
});
export function opaqueTrashPair(path: string): string | undefined {
  return /\.md$/i.test(path) ? path.replace(/\.md$/i, ".assets") : undefined;
}
