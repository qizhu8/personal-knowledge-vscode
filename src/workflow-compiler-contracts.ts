import { z } from "zod";

export const WORKFLOW_COMPILER_LIMITS = Object.freeze({
  inputBytes: 262_144, outputBytes: 1_048_576, jsonDepth: 32, jsonValues: 32_768,
  nodes: 128, edges: 512, dagDepth: 64, cycleSearchSteps: 16_384,
  recipeEntries: 4096, recipeDepth: 16, recipeBytes: 33_554_432,
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/);
export const workflowCompilerSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("inline"), definition: z.json() }),
  z.strictObject({
    kind: z.literal("recipe"), recipeId: identity,
    expectedRevision: z.number().int().safe().positive(), expectedExecutableDigest: digest,
    snapshotRevision: digest.optional(),
  }),
]);
const source = z.union([
  z.strictObject({ kind: z.literal("inline") }),
  z.strictObject({
    kind: z.literal("recipe"), recipeId: identity, revision: z.number().int().safe().positive(),
    executableDigest: digest, snapshotRevision: digest,
  }),
]);
const diagnostic = z.strictObject({
  phase: z.enum(["P3", "P5"]), code: z.string(), severity: z.literal("error"),
  pointer: z.string(), details: z.record(z.string(), z.json()),
  messageTemplateId: z.string(), remediationClass: z.enum(["author", "registry"]),
});
const availability = z.strictObject({
  kind: z.string(), runtimeAvailable: z.literal(false), reason: z.literal("execution-not-migrated"),
  adapterClass: z.string(), requiredCapabilities: z.array(z.string()), builtInOnly: z.boolean(),
});
const bindings = z.strictObject({
  status: z.enum(["none", "verified"]), nodes: z.number().int().nonnegative(),
  knowledge: z.number().int().nonnegative(),
});
const valid = {
  status: z.literal("valid"), source, diagnostics: z.tuple([]), executableDigest: digest,
  bindings, runtimeStatus: z.literal("not-runnable-here"), availability: z.array(availability),
};
const invalid = z.strictObject({
  status: z.literal("invalid"), source, diagnostics: z.array(diagnostic).min(1),
});
const edge = z.strictObject({
  from: identity, to: identity, accept: z.array(z.string()), required: z.literal(true),
  fromOutput: z.string().optional(), toInput: z.string().optional(),
  loop: z.strictObject({
    termination: z.strictObject({ condition: z.string(), maxIterations: z.number().int().positive() }),
  }).optional(),
});
const sourceMap = z.strictObject({
  nodeId: identity, sourcePointer: z.string(), canonicalPointer: z.string(),
  dependencies: z.array(z.strictObject({ sourcePointer: z.string(), canonicalPointer: z.string() })),
});
const plan = z.strictObject({
  schema: z.literal("pkm.workflow.plan/v1"), execution: z.literal("unavailable"),
  nodes: z.array(z.strictObject({ nodeId: identity, kind: z.string() })),
  edges: z.array(edge), order: z.array(identity), layers: z.array(z.array(identity)),
  depth: z.number().int().nonnegative(), requiredNodes: z.array(identity),
  traversalStrategy: z.enum(["breadth-first", "depth-first"]),
  sourceMap: z.array(sourceMap),
});
const input = z.strictObject({ source: workflowCompilerSource });
export const workflowCompilerDefinitions = [
  {
    id: "workflow.compiler.capabilities", readOnly: true,
    description: "Describe bounded deterministic definition compilation. No execution, model, provider, network, lifecycle mutations or native adapters are installed.",
    input: z.strictObject({}),
    output: z.strictObject({
      schema: z.literal("pkm.workflow.compiler.capabilities/v1"),
      definitionSchema: z.literal("pkm.workflow.definition/v1"), execution: z.literal("unavailable"),
      formats: z.tuple([z.literal("json-object")]),
      limits: z.strictObject(Object.fromEntries(
        Object.entries(WORKFLOW_COMPILER_LIMITS).map(([key, value]) => [key, z.literal(value)]),
      ) as { [K in keyof typeof WORKFLOW_COMPILER_LIMITS]: z.ZodLiteral<number> }),
      kinds: z.array(availability),
      unavailable: z.array(z.string()),
    }),
  },
  {
    id: "workflow.definition.validate", readOnly: true,
    description: "Validate an inline JSON definition or exact revision/digest-pinned isolated Recipe using the original compiler. Invalid definitions return original structured diagnostics, not a successful plan.",
    input, output: z.union([z.strictObject(valid), invalid]),
  },
  {
    id: "workflow.definition.compile", readOnly: true,
    description: "Compile a bounded definition into canonical JSON, original executable digest and a static dependency plan/source map. Terminating loop edges are retained, not unrolled. This does not create, accept or execute a run.",
    input, output: z.union([
      z.strictObject({ ...valid, definition: z.json(), canonicalJson: z.string(), plan }),
      invalid,
    ]),
  },
] as const;
export type WorkflowCompilerOperation = typeof workflowCompilerDefinitions[number]["id"];
export type WorkflowCompilerRequest = { operation: WorkflowCompilerOperation; args: unknown };
