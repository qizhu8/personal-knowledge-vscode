import { z } from "zod";
import { documentPath, knowledgeArea } from "./document-path.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const operationId = z.string().uuid();
const documentId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const text = z.string().regex(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/);
const label = text.trim().min(1).max(500);
const body = text;
const tags = z.array(text.max(500)).max(500);
const link = z.strictObject({
  relation: text.regex(/^[a-z][a-z0-9.-]{0,63}$/),
  target: text.regex(/^pkm:\/\/(knowledge\/knowledge_[a-f0-9]{24}|script\/script_[A-Za-z0-9._-]+|project\/project_[A-Za-z0-9._-]+)$/),
  mode: z.enum(["floating", "pinned"]), required: z.boolean(), targetRevision: text.max(500).optional(),
}).refine(value => value.mode === "pinned" ? !!value.targetRevision : value.targetRevision === undefined,
  "Pinned links require a target revision; floating links cannot include one.");
const links = z.array(link).max(500);
const citation = z.union([
  text.max(2_048),
  z.strictObject({
    paper: text.max(2_048).optional(), key: text.max(2_048).optional(), target: text.max(2_048).optional(),
    note: text.max(10_000).optional(), comment: text.max(10_000).optional(),
  }).refine(value => !!(value.paper || value.key || value.target), "Citation references require a paper, key or target."),
]);
const cites = z.array(citation).max(5_000);
const category = z.string().max(2_048);
const commonCreate = {
  operationId, expectedScanRevision: digest, category: category.optional(), content: body.optional(),
  description: text.max(10_000).optional(), tags: tags.optional(), links: links.optional(),
};
const commonUpdate = {
  operationId, id: documentId, expectedScanRevision: digest, expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  expectedSha256: digest, category: category.optional(), content: body.optional(), description: text.max(10_000).optional(),
  tags: tags.optional(), links: links.optional(), moveTo: documentPath.optional(),
  preserveIdentity: z.literal(true).optional(),
};
const noteFields = {
  title: label, type: text.trim().min(1).max(200).optional(), pinned: z.boolean().optional(),
};
const skillFields = {
  name: label, source_project: text.max(2_048).optional(), recipe_required: z.boolean().optional(),
  recipe_hint: text.max(10_000).optional(), related_skills: z.array(label).max(500).optional(),
  priority: z.enum(["normal", "high", "highest"]).optional(), pinned: z.boolean().optional(),
};
const researchFields = {
  title: label, authors: z.array(text.max(500)).max(500).optional(),
  year: z.union([z.number().int().min(0).max(9999), text.max(16), z.null()]).optional(),
  topic: text.max(2_048).optional(), publisher: text.max(2_048).optional(),
  url: text.max(8_192).optional(), file: text.max(2_048).optional(),
  conclusions: z.array(text.max(10_000)).max(500).optional(),
  implementation: z.array(text.max(10_000)).max(500).optional(),
  assumptions: z.array(text.max(10_000)).max(500).optional(),
  cites: cites.optional(), kind: z.enum(["paper", "idea"]).optional(), group: text.max(500).optional(),
  pinned: z.boolean().optional(),
};

const receipt = z.strictObject({
  operationId, action: z.enum(["create", "update"]), area: knowledgeArea, path: documentPath,
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  knowledgeId: z.string().regex(/^knowledge_[a-f0-9]{24}$/), revision: z.number().int().min(1),
  sha256: digest, category: text.max(2_048), name: text.max(500),
});

export const knowledgeMutationDefinitions = [
  { id: "knowledge.note.create", readOnly: false, description: "Create a categorized Note Markdown file with stable Knowledge identity, bounded body, tags, pin state and typed links.", input: z.strictObject({ ...commonCreate, ...noteFields }), output: receipt },
  { id: "knowledge.note.update", readOnly: false, description: "CAS-update Note body/metadata and optional atomic moveTo with exclusive paired assets. Preserve IDs, aliases, links and untouched metadata; increment revision once. Explicit preserveIdentity pins a legacy/path-derived native ID as documentId and adds only missing canonical identity fields. Board and explicit-memory descriptors are guarded.", input: z.strictObject({ ...commonUpdate, title: label.optional(), type: noteFields.type, pinned: noteFields.pinned }), output: receipt },
  { id: "knowledge.skill.create", readOnly: false, description: "Create a categorized Skill with stable identity and unique case-insensitive Skill name.", input: z.strictObject({ ...commonCreate, ...skillFields }), output: receipt },
  { id: "knowledge.skill.update", readOnly: false, description: "CAS-update Skill body/metadata and optional atomic moveTo with exclusive paired assets. Duplicate names conflict. Preserve IDs and metadata; explicit preserveIdentity pins a legacy native ID as documentId and adds only missing canonical identity fields.", input: z.strictObject({
    ...commonUpdate, name: skillFields.name.optional(), source_project: skillFields.source_project,
    recipe_required: skillFields.recipe_required, recipe_hint: skillFields.recipe_hint,
    related_skills: skillFields.related_skills, priority: skillFields.priority, pinned: skillFields.pinned,
  }), output: receipt },
  { id: "knowledge.research.create", readOnly: false, description: "Create a categorized Paper/Idea Markdown file and canonicalize resolvable citations against the pinned source set.", input: z.strictObject({ ...commonCreate, ...researchFields }), output: receipt },
  { id: "knowledge.research.update", readOnly: false, description: "CAS-update Paper metadata/body/citations and optional atomic moveTo with exclusive paired assets. Preserve IDs, aliases, history and untouched references. Explicit preserveIdentity pins a legacy native ID as documentId and adds only missing canonical identity fields.", input: z.strictObject({
    ...commonUpdate, title: researchFields.title.optional(), authors: researchFields.authors,
    year: researchFields.year, topic: researchFields.topic, publisher: researchFields.publisher,
    url: researchFields.url, file: researchFields.file, conclusions: researchFields.conclusions,
    implementation: researchFields.implementation, assumptions: researchFields.assumptions,
    cites: researchFields.cites, kind: researchFields.kind, group: researchFields.group, pinned: researchFields.pinned,
  }), output: receipt },
] as const;

const transportActor = z.string().min(1).max(500);
export const knowledgeMutationTransport = z.union([
  z.strictObject({ operation: z.literal("knowledge.note.create"), actorId: transportActor, args: knowledgeMutationDefinitions[0].input }),
  z.strictObject({ operation: z.literal("knowledge.note.update"), actorId: transportActor, args: knowledgeMutationDefinitions[1].input }),
  z.strictObject({ operation: z.literal("knowledge.skill.create"), actorId: transportActor, args: knowledgeMutationDefinitions[2].input }),
  z.strictObject({ operation: z.literal("knowledge.skill.update"), actorId: transportActor, args: knowledgeMutationDefinitions[3].input }),
  z.strictObject({ operation: z.literal("knowledge.research.create"), actorId: transportActor, args: knowledgeMutationDefinitions[4].input }),
  z.strictObject({ operation: z.literal("knowledge.research.update"), actorId: transportActor, args: knowledgeMutationDefinitions[5].input }),
]);

export type KnowledgeMutationOperation = typeof knowledgeMutationDefinitions[number]["id"];
export interface KnowledgeMutationRequest {
  operation: KnowledgeMutationOperation;
  actorId: string;
  args: Record<string, unknown>;
}
