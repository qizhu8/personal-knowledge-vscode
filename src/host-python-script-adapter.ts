import { createHash } from "node:crypto";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { hostPythonHandleSchema, verifyHostPythonHandle } from "./host-python-workflow.js";
import { canonicalJson, compileWorkflowDefinitionV1, type WorkflowScriptNodeV1 } from "./domain/project-recipes-workflow-contracts.js";
import type { RuntimeProcessService } from "./runtime-process.js";
import type { WorkflowStepAdapter } from "./workflow-executor.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const pythonProgramSchema = z.strictObject({
  handle: hostPythonHandleSchema, cwd: z.string(), definition: z.unknown(), inputs: z.record(z.string(), z.unknown()),
  source: z.record(z.string(), z.unknown()), executableDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFile: z.strictObject({ root: z.string(), file: z.string(), identity: z.string(),
    pin: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
});
export type PythonScriptProgram = z.infer<typeof pythonProgramSchema>;
export function verifyPythonSourceFile(source: NonNullable<PythonScriptProgram["sourceFile"]>) {
  const root = lstatSync(source.root), file = lstatSync(source.file, { bigint: true });
  const child = relative(source.root, source.file);
  if (!isAbsolute(source.root) || resolve(source.root) !== source.root || realpathSync(source.root) !== source.root
    || !root.isDirectory() || `${root.dev}:${root.ino}` !== source.identity || !child || child.startsWith("..") || isAbsolute(child)
    || realpathSync(dirname(source.file)) !== dirname(source.file) || realpathSync(source.file) !== source.file
    || !file.isFile() || file.nlink !== 1n || file.size > 32768n
    || ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].map(key => String(file[key as keyof typeof file])).join(":") !== source.pin
    || sha(readFileSync(source.file, "utf8")) !== source.sha256)
    throw new Error("Reviewed Python source file/root changed; select and approve again.");
}
export function compilePythonProgram(value: unknown) {
  const program = pythonProgramSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(program)) > 49152) throw new Error("Python approval payload exceeds its bound.");
  const compiled = compileWorkflowDefinitionV1(program.definition);
  if (!compiled.ok || compiled.executableDigest !== program.executableDigest || compiled.model.spec.nodes.length > 4)
    throw new Error("Reviewed Python Workflow digest/definition rejected.");
  for (const node of compiled.model.spec.nodes) {
    if (node.kind !== "pkm.step.script/v1" || node.config.runtime !== "python"
      || node.config.environmentId !== program.handle.environmentId || node.control && node.control.mode !== "single"
      || node.dependsOn.some(dependency => dependency.loop) || node.config.cwd && node.config.cwd !== "."
      || Buffer.byteLength(node.config.script) > 16384 || node.config.script.includes("\0")
      || node.config.timeoutSeconds > 20 || node.config.maxOutputBytes > 4096
      || (node.config.args ?? []).length > 12)
      throw new Error("Only bounded Python script steps in the explicitly selected environment are admitted (four steps, 20 seconds, 4096 output bytes).");
  }
  if (program.source.kind !== "inline" && program.source.kind !== "recipe") throw new Error("Unsupported Python source.");
  if (program.sourceFile) {
    verifyPythonSourceFile(program.sourceFile);
    const file = compileWorkflowDefinitionV1(JSON.parse(readFileSync(program.sourceFile.file, "utf8")));
    if (!file.ok || file.executableDigest !== compiled.executableDigest) throw new Error("Python payload differs from the reviewed file.");
  }
  return { program, compiled };
}
export function pythonScriptArguments(node: WorkflowScriptNodeV1, inputs: Record<string, unknown>) {
  const args = (node.config.args ?? []).map(argument => argument.replace(/\{\{\s*inputs\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,
    (_match, key: string) => {
      const value = inputs[key];
      if (!Object.hasOwn(inputs, key) || !["string", "boolean", "number"].includes(typeof value))
        throw new Error("Python argument input must be an explicitly bound primitive.");
      return String(value);
    }));
  if (args.some(arg => arg.includes("\0") || arg.includes("{{") || Buffer.byteLength(arg) > 1024)
    || Buffer.byteLength(JSON.stringify(args)) > 4096) throw new Error("Invalid or unbound Python arguments.");
  return args;
}

/** Native registrations only. No path, serialized handle or public token registers an executable. */
export class HostPythonScriptAdapter {
  private readonly registrations = new Map<string, ReturnType<typeof compilePythonProgram>>();
  private readonly rootIdentity: string;
  constructor(private readonly options: {
    workspaceId: string; actorId?: string; workspaceRoot: string; runtime: RuntimeProcessService; check(): void;
    jobCreated(runId: string, jobId: string, phase: string): void;
    track<T>(work: Promise<T>): Promise<T>;
    verifyRecipeSource?(program: PythonScriptProgram): void;
  }) {
    const root = lstatSync(options.workspaceRoot);
    this.rootIdentity = `${root.dev}:${root.ino}`;
  }
  register(runId: string, value: unknown) {
    if (this.registrations.has(runId)) throw new Error("Python run approval cannot be reused.");
    const prepared = compilePythonProgram(value);
    if (prepared.program.source.kind === "recipe" && !this.options.verifyRecipeSource)
      throw new Error("Recipe Python requires an actual native Recipe source resolver; inline substitution is forbidden.");
    this.check(prepared.program);
    this.registrations.set(runId, prepared);
    return prepared;
  }
  release(runId: string) { this.registrations.delete(runId); }
  private check(program: PythonScriptProgram) {
    this.options.check();
    verifyHostPythonHandle(program.handle, this.options.workspaceId, this.options.actorId ?? "local:owner");
    const root = lstatSync(this.options.workspaceRoot);
    if (program.cwd !== this.options.workspaceRoot || realpathSync(this.options.workspaceRoot) !== this.options.workspaceRoot
      || !root.isDirectory() || `${root.dev}:${root.ino}` !== this.rootIdentity) throw new Error("Python cwd changed.");
    if (program.sourceFile) verifyPythonSourceFile(program.sourceFile);
    if (program.source.kind === "recipe") this.options.verifyRecipeSource!(program);
  }
  processAdapter(id: string, input: unknown) {
    if (id !== "host-python-script") return undefined;
    const data = z.strictObject({ runId: z.string(), nodeId: z.string() }).parse(input);
    const selected = this.registrations.get(data.runId);
    const node = selected?.compiled.model.spec.nodes.find(node => node.nodeId === data.nodeId);
    if (!selected || node?.kind !== "pkm.step.script/v1") throw new Error("No live native Python run approval.");
    this.check(selected.program);
    return { id, executable: selected.program.handle.executable, cwd: this.options.workspaceRoot, env: {},
      stdin: true, outputPersistence: "stored" as const, arguments: () => {
        this.check(selected.program);
        return ["-I", "-B", "-", ...pythonScriptArguments(node, selected.program.inputs)];
      } };
  }
  adapter(): WorkflowStepAdapter {
    return {
      id: "host-reviewed-python-script", version: 1, outputContractDigest: sha("python:stdout:exitCode:v1"),
      authorizationDigest: sha(`${this.options.workspaceId}:native-memory-per-run-python:v1`),
      authorizeDefinition: binding => [...this.registrations.values()].some(({ program, compiled }) => {
        this.check(program);
        return binding.actorId === (this.options.actorId ?? "local:owner") && binding.executableDigest === program.executableDigest
          && canonicalJson(binding.source) === canonicalJson(program.source)
          && compiled.model.spec.nodes.some(node => canonicalJson(node) === canonicalJson(binding.node));
      }),
      authorizeData: binding => [...this.registrations.values()].some(({ program }) =>
        binding.actorId === (this.options.actorId ?? "local:owner") && binding.executableDigest === program.executableDigest
        && canonicalJson(binding.source) === canonicalJson(program.source)
        && canonicalJson(binding.inputs) === canonicalJson(program.inputs)),
      validateOutput: outputs => typeof outputs.stdout === "string" && outputs.exitCode === 0,
      execute: (invocation, context) => this.options.track((async () => {
        const selected = this.registrations.get(invocation.runId), node = invocation.node;
        if (!selected || invocation.actorId !== (this.options.actorId ?? "local:owner") || node.kind !== "pkm.step.script/v1"
          || invocation.executableDigest !== selected.program.executableDigest
          || canonicalJson(invocation.inputs) !== canonicalJson(selected.program.inputs)
          || !selected.compiled.model.spec.nodes.some(item => canonicalJson(item) === canonicalJson(node)))
          throw new Error("Exact Python execution approval is absent.");
        this.check(selected.program);
        if (context.signal.aborted) return { status: "failed", outputs: {} };
        const job = await this.options.runtime.launch({ actorId: invocation.actorId, operationId: invocation.invocationId,
          adapterId: "host-python-script", input: { runId: invocation.runId, nodeId: node.nodeId },
          deadlineMs: node.config.timeoutSeconds * 1000, stdin: Buffer.from(`${node.config.script}\n`) });
        this.options.jobCreated(invocation.runId, job.jobId, `python:${node.nodeId}`);
        const cancel = () => { void this.options.runtime.cancel(invocation.actorId, job.jobId).catch(() => undefined); };
        context.signal.addEventListener("abort", cancel, { once: true });
        if (context.signal.aborted) cancel();
        try {
          for (;;) {
            const result = this.options.runtime.status(invocation.actorId, job.jobId);
            if (!["QUEUED", "RUNNING"].includes(result.state)) {
              const stdout = Buffer.from(result.stdout, "base64").toString("utf8");
              if (result.state !== "SUCCEEDED" || result.stdoutDroppedBytes || result.stderrDroppedBytes)
                return { status: result.effect === "unknown" ? "unknown" : "failed", outputs: {} };
              return { status: "succeeded", outputs: { stdout, exitCode: 0 } };
            }
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        } finally { context.signal.removeEventListener("abort", cancel); }
      })()),
    };
  }
}
