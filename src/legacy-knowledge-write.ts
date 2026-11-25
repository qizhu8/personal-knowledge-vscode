import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "./contracts.js";
import type { Core } from "./core.js";
import type { Storage } from "./storage.js";
import { documentPath, knowledgeArea } from "./document-path.js";
import { scanMarkdown } from "./markdown.js";
import { knowledgeMutationScanRevision } from "./knowledge-mutations.js";
import { originalMcpPrivateTopLevels, readOriginalMcpJournal } from "./original-mcp-root-custody.js";
import { originalMcpPublicRequestActive } from "./original-mcp-native-host.js";
import { assertNoNewPrivateResourceReferences, documentHasLegacyAssetReferences } from "./document-legacy-assets.js";
import { withApprovedPrivateResourcesForMutation } from "./private-resource-publication-native.js";

const nullableText = z.string().nullable().optional();
const nullableTags = z.array(z.string()).nullable().optional();
const noteUpdate = { slug: z.string(), title: nullableText, content: nullableText, type: nullableText,
  category: nullableText, tags: nullableTags };
const skillExtra = { recipe_required: z.boolean().nullable().optional(), recipe_hint: nullableText,
  related_skills: nullableTags, priority: nullableText };
const paperExtra = { authors: nullableTags, year: z.number().int().nullable().optional(), topic: nullableText,
  publisher: nullableText, tags: nullableTags, url: nullableText, conclusions: nullableTags,
  cites: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).nullable().optional(),
  category: nullableText };
const safeName = (value: string) => value.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "").trim() || "untitled";
const safeCategory = (value: unknown) => String(value ?? "").split("/").map(part => part.trim()).filter(Boolean).map(safeName).join("/");
const schemas = {
  add_note: z.strictObject({ title: z.string(), content: z.string(), type: z.string().default("general"),
    tags: nullableTags, category: nullableText, slug: nullableText }),
  update_note: z.strictObject(noteUpdate),
  add_skill: z.strictObject({ name: z.string(), content: z.string(), description: z.string().default(""),
    category: z.string().default(""), tags: nullableTags, source_project: z.string().default(""),
    recipe_required: z.boolean().default(false), recipe_hint: z.string().default(""),
    related_skills: nullableTags, priority: z.string().default("normal") }),
  update_skill: z.strictObject({ name: z.string(), content: nullableText, description: nullableText,
    category: nullableText, tags: nullableTags, ...skillExtra }),
  add_paper: z.strictObject({ title: z.string(), ...paperExtra, content: z.string().default("") }),
  update_paper: z.strictObject({ slug: z.string(), title: nullableText, content: nullableText, ...paperExtra }),
};

export const legacyKnowledgeWriteRequest = z.strictObject({
  tool: z.enum(["add_note", "update_note", "add_skill", "update_skill", "add_paper", "update_paper"]),
  arguments: z.record(z.string(), z.unknown()),
});

export async function legacyKnowledgeWrite(core: Core, storage: Storage, actor: Actor,
  request: z.infer<typeof legacyKnowledgeWriteRequest>) {
  if (!actor.canWrite) throw new Error("ACCESS_DENIED: This isolated MCP process is read-only.");
  const parsed = schemas[request.tool].parse(request.arguments) as Record<string, unknown>;
  const kind = request.tool.endsWith("note") ? "note" : request.tool.endsWith("skill") ? "skill" : "research";
  const area = kind === "note" ? "notes" : kind === "skill" ? "skills" : "papers";
  const creating = request.tool.startsWith("add_");
  const original = readOriginalMcpJournal(storage.workspaceRoot());
  const denied = originalMcpPrivateTopLevels(storage.workspaceRoot(), area);
  const retainedPrivateClosure = original && knowledgeArea.options.some(area =>
    originalMcpPrivateTopLevels(storage.workspaceRoot(), area).size > 0);
  const assertDestination = (path: string) => {
    if (original && (path.split("/")[0] === ".trash" || denied.has(path.split("/")[0]!)))
      throw new Error("ACCESS_DENIED: Original private and Trash paths remain immutable archive-only content.");
  };
  const pinned = await storage.withWorkspaceExclusive(() => {
    storage.assertWorkspaceLease();
    const records = scanMarkdown(storage.workspaceRoot());
    const matches = records.filter(record => record.record.area === area && (kind === "skill"
      ? String(record.metadata.get("name") ?? record.record.path.split("/").at(-1)!.slice(0, -3)) === parsed.name
      : record.record.path === `${parsed.slug}.md`));
    if (matches.length > 1) throw new Error("CONFLICT: Skill name is ambiguous; no original-compatible mutation was applied.");
    let existing: (typeof matches)[number] | undefined = matches[0];
    if (creating && kind === "skill" && !existing) {
      const category = safeCategory(parsed.category);
      const destination = `${category ? `${category}/` : ""}${safeName(String(parsed.name))}.md`;
      assertDestination(destination);
      existing = records.find(record => record.record.area === area && record.record.path === destination);
    }
    if (creating && kind !== "skill") {
      const category = safeCategory(parsed.category);
      const key = `${category ? `${category}/` : ""}${String(parsed.title)}`;
      const exact = records.find(record => record.record.area === area && record.record.path === `${key}.md`);
      if (exact) return { error: `${kind === "note" ? "Note" : "Paper"} '${key}' already exists. Use update_${kind === "note" ? "note" : "paper"} instead.` };
      const path = `${category ? `${category}/` : ""}${safeName(String(parsed.title))}.md`;
      existing = records.find(record => record.record.area === area && record.record.path === path);
    }
    if (!creating && !existing) return { error: kind === "skill"
      ? `Skill '${parsed.name}' not found. Use add_skill to create it.` : `${kind === "note" ? "Note" : "Paper"} '${parsed.slug}' not found.` };
    const args = Object.fromEntries(Object.entries(parsed).filter(([key, value]) => value !== null && value !== undefined
      && !["slug"].includes(key)));
    const updating = !creating || !!existing;
    if (updating && existing) {
      const currentName = existing.metadata.get(kind === "skill" ? "name" : "title")
        ?? existing.record.path.split("/").at(-1)!.slice(0, -3);
      const currentCategory = existing.record.path.includes("/") ? existing.record.path.slice(0, existing.record.path.lastIndexOf("/")) : "";
      const desiredName = String(args[kind === "skill" ? "name" : "title"] ?? currentName);
      const category = safeCategory(args.category ?? currentCategory);
      const renamed = desiredName !== String(currentName) || category !== currentCategory;
      const target = original && !renamed ? existing.record.path
        : `${category ? `${category}/` : ""}${safeName(desiredName)}.md`;
      assertDestination(target);
      if (target !== existing.record.path) {
        if ((retainedPrivateClosure || documentHasLegacyAssetReferences(existing.raw)
          || typeof args.content === "string" && documentHasLegacyAssetReferences(args.content))
          && !originalMcpPublicRequestActive(storage, request.tool, request.arguments))
          throw new Error("NATIVE_AUTHORITY_REQUIRED: Moves with retained private or legacy asset sources require this request's fresh native public approval.");
        if (!documentPath.safeParse(target).success) throw new Error("INVALID_ARGUMENT: Original move destination is not portable.");
        args.moveTo = target;
        args.category = category;
        if (kind !== "skill" && args.title === undefined) args.title = currentName;
      }
      Object.assign(args, { id: existing.record.id, expectedRevision: existing.record.revision,
        expectedSha256: existing.record.sha256, preserveIdentity: true });
    } else {
      const name = String(kind === "skill" ? args.name : args.title);
      const category = safeCategory(args.category);
      args.category = category;
      const path = `${category ? `${category}/` : ""}${safeName(name)}.md`;
      assertDestination(path);
      if (!documentPath.safeParse(path).success)
        throw new Error("INVALID_ARGUMENT: Original destination is not portable.");
      const occupied = records.find(record => record.record.area === area && record.record.path === path);
      if (occupied && kind !== "skill") return { error: `${kind === "note" ? "Note" : "Paper"} '${path.slice(0, -3)}' already exists. Use update_${kind === "note" ? "note" : "paper"} instead.` };
      if (occupied) throw new Error("CONFLICT: Original destination identity changed; no files were changed.");
    }
    if (typeof args.content === "string") {
      const sourcePath = existing?.record.path
        ?? `${safeCategory(args.category) ? `${safeCategory(args.category)}/` : ""}${safeName(String(kind === "skill" ? args.name : args.title))}.md`;
      assertNoNewPrivateResourceReferences(storage.workspaceRoot(), area, sourcePath, existing?.raw, args.content);
    }
    return { operation: `knowledge.${kind}.${updating ? "update" : "create"}`,
      args: { ...args, operationId: randomUUID(), expectedScanRevision: knowledgeMutationScanRevision(records) } };
  });
  if ("error" in pinned) return { text: JSON.stringify({ error: pinned.error }) };
  const response = await withApprovedPrivateResourcesForMutation(storage, request, {
    operation: pinned.operation, actorId: actor.id, args: pinned.args,
  }, () => core.dispatch("capability_call", {
    operation: pinned.operation, version: 1, arguments: pinned.args,
  }, actor));
  if (response.error) throw new Error(`${response.error.code}: ${response.error.message}`);
  const result = response.result as { path: string };
  return { text: JSON.stringify(kind === "skill" ? { ok: true, name: parsed.name }
    : { ok: true, slug: result.path.replace(/\.md$/i, "") }) };
}
