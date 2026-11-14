import { z } from "zod";
import { CoreError } from "./contracts.js";

export const legacyTodoBoardCreateArguments = z.strictObject({
  title: z.string(), category: z.string().default(""),
});
const safeName = (value: string) => (value || "untitled").replace(/[/\\:*?"<>|\u0000-\u001f]/g, "").trim() || "untitled";
const safeCategory = (value: string) => !value.trim() ? ""
  : value.split("/").map(part => part.trim()).filter(Boolean).map(safeName).filter(Boolean).join("/");

export function legacyTodoBoardCreateSlug(input: unknown) {
  const parsed = legacyTodoBoardCreateArguments.safeParse(input);
  if (!parsed.success) throw new CoreError("INVALID_ARGUMENT", "Invalid original Todo Board creation arguments.");
  const { title, category } = parsed.data;
  if (!title.trim()) throw new CoreError("INVALID_ARGUMENT", "Todo Board title is required.");
  const slug = category ? `${category}/${title}` : title;
  const split = slug.lastIndexOf("/");
  if ((split < 0 ? "" : slug.slice(0, split)) !== safeCategory(category)
    || slug.slice(split + 1) !== safeName(title)) {
    throw new CoreError("INVALID_ARGUMENT", "Choose a valid Board title and category matching its path.");
  }
  return slug;
}
