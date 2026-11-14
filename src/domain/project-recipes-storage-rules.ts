import { compileWorkflowDefinitionV1 } from "./project-recipes-workflow-contracts.js";
import { compileRecipeMethodologyV1 } from "./project-recipes-methodology-model.js";
import type { RecipeRecord } from "../project-recipes.js";
import * as path from "node:path";

export class CapturedRecipeValidationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function fail(code: string, message: string): never { throw new CapturedRecipeValidationError(code, message); }
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const UNCATEGORIZED_RECIPE_DIRECTORY = "Uncategorized";

export function validateRecipeRecord(value: RecipeRecord): void {
  if (!isRecord(value) || !validRecipeId(value.recipeId) || typeof value.name !== "string" || !value.name.trim()
    || value.scope !== "global" || value.projectId !== undefined
    || typeof value.description !== "string" || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    fail("recipe-invalid", "Recipe metadata is invalid.");
  }
  const compiled = compileWorkflowDefinitionV1(value.definition);
  if (!compiled.ok) fail("definition-invalid", "Recipe workflow definition is invalid.");
  if (compiled.executableDigest !== value.executableDigest) fail("digest-mismatch", "Recipe executable digest does not match its definition.");
  if (value.methodology) {
    const methodology = compileRecipeMethodologyV1(value.methodology);
    if (!methodology.ok) fail("methodology-invalid", "Recipe Methodology Manifest is invalid.");
    if (methodology.methodologyDigest !== value.methodologyDigest) fail("methodology-digest-mismatch", "Recipe methodology digest is invalid.");
  } else if (value.methodologyDigest) {
    fail("methodology-digest-mismatch", "Recipe methodology digest exists without a Methodology Manifest.");
  }
}

export function normalizeRecipeCategory(value: unknown): string {
  const raw = String(value || "").trim().normalize("NFC").replace(/\\/g, "/");
  if (!raw) return "";
  if (raw.startsWith("/") || raw.endsWith("/") || raw.includes("//")) fail("category-invalid", "Recipe category is not portable.");
  const segments = raw.split("/");
  if (segments[0] === "Project" && segments.length < 2) {
    fail("category-invalid", "Recipes under the reserved Project category require a Project subcategory.");
  }
  if (segments.some(segment => !segment || segment === "." || segment === ".." || segment === ".trash"
    || segment === UNCATEGORIZED_RECIPE_DIRECTORY || /[<>:"\\|?*\u0000-\u001f\u007f]/.test(segment)
    || /[ .]$/.test(segment) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment))) {
    fail("category-invalid", "Recipe category contains a reserved or non-portable segment.");
  }
  return segments.join("/");
}

export function safeRecipeCategorySegment(value: string): string {
  let safe = String(value || "").trim().normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, " ").replace(/^[ .]+|[ .]+$/g, "");
  if (!safe) safe = "Project";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(safe)) safe = `${safe}-Project`;
  return safe.slice(0, 120).replace(/[ .]+$/g, "") || "Project";
}

export function safeRecipeFileName(name: string, recipeId: string): string {
  if (!validRecipeId(recipeId)) fail("recipe-id-invalid", "Recipe identity is not portable.");
  let safe = String(name || "").normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[ .-]+|[ .-]+$/g, "");
  if (!safe) safe = "Recipe";
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(safe)) safe = `${safe}-Recipe`;
  safe = safe.slice(0, Math.max(1, 180 - recipeId.length)).replace(/[ .]+$/g, "") || "Recipe";
  return `${safe}.${recipeId}.json`;
}

export function recipeIdFromFile(file: string): string {
  return /\.([A-Za-z][A-Za-z0-9._-]{0,127})\.json$/i.exec(path.basename(file))?.[1] || "";
}

export function validRecipeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(value);
}
