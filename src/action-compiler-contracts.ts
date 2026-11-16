import { z } from "zod";

export const ACTION_COMPILER_LIMITS = Object.freeze({
  inputBytes: 67_108_864,
  outputBytes: 1_048_576,
  jsonDepth: 32,
  jsonValues: 32_768,
  definitionBytes: 16_777_216,
  moduleFiles: 500,
  moduleActions: 100,
  moduleBytes: 33_554_432,
  moduleFileBytes: 16_777_216,
  graphNodes: 100,
  graphEdges: 500,
  pipelineSteps: 500,
  pipelineDepth: 12,
  dependencyDepth: 16,
  dependencyCount: 500,
});

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const moduleSource = z.strictObject({
  kind: z.literal("moduleSet"),
  manifest: z.json(),
  files: z.record(z.string(), z.string()),
  enabled: z.boolean().optional(),
});
const source = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("inline"), definition: z.json() }),
  moduleSource,
]);
const diagnostic = z.strictObject({
  path: z.string(),
  code: z.string(),
  message: z.string(),
  allowed_values: z.array(z.string()).optional(),
  missing_field: z.string().optional(),
});
const sourceDescriptor = z.union([
  z.strictObject({ kind: z.literal("inline"), action_id: z.string().optional() }),
  z.strictObject({
    kind: z.literal("moduleSet"), module_set_id: z.string(), version: z.number().int().positive(),
    action_id: z.string().optional(),
  }),
]);
const checkResult = z.strictObject({
  schema: z.literal("pkm.action.definition-check/v1"),
  ok: z.boolean(),
  diagnostics: z.array(diagnostic),
  persisted: z.literal(false),
  executed: z.literal(false),
  readiness_checked: z.literal(false),
  next_action: z.enum(["action_register", "fix_definition"]),
});
const checkInput = z.strictObject({ source, actionId: z.string().optional() });

const plan = z.strictObject({
  action_id: z.string(),
  action_version: z.number().int(),
  dependencies: z.array(z.strictObject({ action_id: z.string(), content_hash: digest })),
  implementations: z.array(z.strictObject({
    index: z.number().int().nonnegative(),
    kind: z.enum(["program", "pipeline", "mcp", "builtin"]),
    platforms: z.array(z.string()),
  })),
  sourceMap: z.array(z.strictObject({
    sourcePointer: z.string(),
    canonicalPointer: z.string(),
    nodeId: z.string().optional(),
  })),
});
const compiled = z.strictObject({
  schema: z.literal("pkm.action.definition.compile/v1"),
  status: z.literal("valid"),
  source: sourceDescriptor,
  definitionDigest: digest,
  canonicalJson: z.string(),
  definition: z.json(),
  plan,
  runtimeStatus: z.literal("not-runnable-here"),
});
const compileResult = z.union([compiled, z.strictObject({
  schema: z.literal("pkm.action.definition.compile/v1"),
  status: z.literal("invalid"),
  source: sourceDescriptor,
  diagnostics: z.array(diagnostic).min(1),
})]);

const projectInput = z.strictObject({ source: moduleSource });
const moduleProjection = z.strictObject({
  module_set_id: z.string(),
  version: z.number().int().positive(),
  name: z.string(),
  actions: z.array(z.string()),
  package_hash: digest,
  provenance: z.json(),
  enabled: z.boolean(),
});
const projectResult = z.strictObject({ ok: z.literal(true), module_sets: z.array(moduleProjection) });

const graphInput = z.strictObject({ graph: z.json(), sourceModules: z.array(moduleSource).max(16).optional() });
const graphResult = z.union([
  z.strictObject({
    schema: z.literal("pkm.action.graph.compile/v1"),
    status: z.literal("valid"),
    definition: z.json(),
    canonicalJson: z.string(),
    definitionDigest: digest,
    sourceMap: z.array(z.strictObject({
      sourcePointer: z.string(),
      canonicalPointer: z.string(),
      nodeId: z.string(),
    })),
    runtimeStatus: z.literal("not-runnable-here"),
  }),
  z.strictObject({
    schema: z.literal("pkm.action.graph.compile/v1"),
    status: z.literal("invalid"),
    diagnostics: z.array(diagnostic).min(1),
  }),
]);

export const actionCompilerDefinitions = [
  {
    id: "action.compiler.capabilities",
    readOnly: true,
    description: "Describe bounded, deterministic Action validation, ModuleSet projection and graph compilation. No persistence, execution, host reads, providers, network or credentials.",
    input: z.strictObject({}),
    output: z.strictObject({
      schema: z.literal("pkm.action.compiler.capabilities/v1"),
      definitionSchema: z.literal("pkm.action.definition/v1"),
      moduleSetSchema: z.literal("pkm.action.module-set/v1"),
      runtimeStatus: z.literal("not-runnable-here"),
      sourceIdentity: z.strictObject({
        id: z.enum(["compiler-capture-v1", "frozen-original-v2"]),
        evidence: z.enum(["historical", "fixture-only"]),
      }),
      limits: z.strictObject(Object.fromEntries(
        Object.entries(ACTION_COMPILER_LIMITS).map(([key, value]) => [key, z.literal(value)]),
      ) as { [K in keyof typeof ACTION_COMPILER_LIMITS]: z.ZodLiteral<number> }),
      implementationKinds: z.tuple([z.literal("program"), z.literal("pipeline"), z.literal("mcp")]),
      unavailable: z.array(z.string()),
    }),
  },
  {
    id: "action.definition.check",
    readOnly: true,
    description: "Apply the original non-mutating Action authoring diagnostics to one inline definition or explicitly supplied isolated ModuleSet snapshot.",
    input: checkInput,
    output: checkResult,
  },
  {
    id: "action.definition.compile",
    readOnly: true,
    description: "Validate and compile one portable Action definition to deterministic JSON, its original canonical digest semantics and a static dependency/source map. The result is not executable here.",
    input: checkInput,
    output: compileResult,
  },
  {
    id: "action.moduleSet.project",
    readOnly: true,
    description: "Validate and project a caller-supplied ModuleSet manifest and bounded file snapshot. No directory discovery or initialization occurs.",
    input: projectInput,
    output: projectResult,
  },
  {
    id: "action.graph.compile",
    readOnly: true,
    description: "Compile a bounded original Action block graph against explicitly supplied Action ModuleSet snapshots and captured built-in component contracts. No persistence or execution occurs.",
    input: graphInput,
    output: graphResult,
  },
] as const;

export type ActionCompilerOperation = typeof actionCompilerDefinitions[number]["id"];
export type ActionCompilerRequest = { operation: ActionCompilerOperation; args: unknown };
