import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RuntimeProcessService, RuntimeProcessStore } from "./runtime-process.js";
import { WorkflowExecutor, type WorkflowStepAdapter } from "./workflow-executor.js";
import { canonicalJson, compileWorkflowDefinitionV1 } from "./domain/project-recipes-workflow-contracts.js";
import { verifyHostPythonHandle } from "./host-python-environment.js";
export { hostPythonHandleSchema, verifyHostPythonHandle } from "./host-python-environment.js";
export const PYTHON_TRIAL_SCRIPT = "print(7)";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export type HostPythonWorkflowResult = {
  workspaceId: string; actorId: string; environmentId: string; runId: string;
  state: "succeeded" | "failed" | "unknown"; stdout: string; exitCode: number | null;
  error?: string;
};

/** One user-started, host-approved script, through the real Workflow scheduler and Runtime.
 * The handle and process repository live in memory only. Script is native configuration,
 * not a request argument. This is not a Python sandbox; scripts inherit OS user permissions.
 */
export async function runHostPythonWorkflow(options: {
  handle: unknown; workspaceId: string; actorId: string; workspaceRoot: string;
  script: string; signal: AbortSignal; approve(): Promise<boolean>;
}): Promise<HostPythonWorkflowResult> {
  const handle = verifyHostPythonHandle(options.handle, options.workspaceId, options.actorId);
  if (typeof options.script !== "string" || !options.script.trim() || options.script.includes("\0")
    || Buffer.byteLength(options.script) > 16_384) throw new Error("Invalid native Python script configuration.");
  const root = realpathSync(options.workspaceRoot);
  if (!isAbsolute(options.workspaceRoot) || root !== options.workspaceRoot || !statSync(root).isDirectory())
    throw new Error("Python workflow workspace root rejected.");
  const check = () => verifyHostPythonHandle(handle, options.workspaceId, options.actorId);
  const database = new DatabaseSync(":memory:");
  let runtime: RuntimeProcessService | undefined, executor: WorkflowExecutor | undefined;
  const runId = `python-${randomUUID()}`;
  let processResult: { stdout: string; exitCode: number | null; error?: string } = { stdout: "", exitCode: null };
  try {
    const node = { nodeId: "python", kind: "pkm.step.script/v1" as const, dependsOn: [],
      config: { runtime: "python" as const, environmentId: handle.environmentId, script: options.script,
        timeoutSeconds: 5, maxOutputBytes: 1024 } };
    const definition = { schema: "pkm.workflow.definition/v1" as const,
      spec: { inputs: {}, outputs: {}, nodes: [node], completion: { requiredNodes: ["python"] } } };
    const compiled = compileWorkflowDefinitionV1(definition);
    if (!compiled.ok) throw new Error("Native Python workflow compilation failed.");
    let approved = false;
    runtime = new RuntimeProcessService({
      repositoryFactory: (owner, capacity) => new RuntimeProcessStore(database, owner, capacity),
      adapters: [{ id: "host-python", executable: handle.executable, cwd: root, env: {},
        stdin: true, outputPersistence: "ephemeral", arguments() { check(); return ["-I", "-B", "-"]; } }],
      authorizeLaunch: async request => approved && !options.signal.aborted && request.actorId === options.actorId
        && request.adapterId === "host-python" && !!check(),
      limits: { concurrency: 1, queue: 0, stdoutBytes: 1024, stderrBytes: 0, deadlineMs: 5000, graceMs: 100 },
    });
    const service = runtime;
    const adapter: WorkflowStepAdapter = {
      id: "host-python-script", version: 1, outputContractDigest: hash("host-python:stdout:exitCode:v1"),
      authorizationDigest: hash(JSON.stringify(handle)),
      authorizeDefinition: binding => binding.actorId === options.actorId && binding.executableDigest === compiled.executableDigest
        && canonicalJson(binding.node) === canonicalJson(compiled.model.spec.nodes[0]) && !!check(),
      authorizeData: binding => binding.actorId === options.actorId && Object.keys(binding.inputs).length === 0,
      validateOutput: outputs => typeof outputs.stdout === "string" && Number.isInteger(outputs.exitCode),
      async execute(invocation, context) {
        if (context.signal.aborted || options.signal.aborted || invocation.actorId !== options.actorId
          || invocation.executableDigest !== compiled.executableDigest) return { status: "failed", outputs: {} };
        check();
        approved = await options.approve();
        if (!approved || context.signal.aborted || options.signal.aborted) throw new Error("Host Python approval denied.");
        check();
        const job = await service.launch({ actorId: options.actorId, operationId: invocation.invocationId,
          adapterId: "host-python", input: {}, deadlineMs: 5000, stdin: Buffer.from(`${options.script}\n`) });
        const cancel = () => { void service.cancel(options.actorId, job.jobId).catch(() => undefined); };
        const signal = AbortSignal.any([options.signal, context.signal]);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        try {
          const result = await service.waitCaptured(options.actorId, job.jobId);
          if (!result) throw new Error("Python process result unavailable.");
          processResult = { stdout: result.stdout.toString("utf8"), exitCode: result.job.exitCode };
          if (result.job.state !== "SUCCEEDED" || result.job.stdoutDroppedBytes) {
            processResult.error = `Python process ${result.job.state}: ${result.job.reason}; exit ${result.job.exitCode ?? "none"}.`;
            return { status: result.job.effect === "unknown" ? "unknown" : "failed", outputs: {} };
          }
          return { status: "succeeded", outputs: { stdout: processResult.stdout, exitCode: result.job.exitCode } };
        } finally { signal.removeEventListener("abort", cancel); }
      },
    };
    executor = new WorkflowExecutor(database, { workspaceRoot: root, ownerId: randomUUID(),
      adapters: { "pkm.step.script/v1": adapter }, leaseMs: 10_000 });
    executor.create(options.actorId, { operationId: randomUUID(), runId, source: { kind: "inline", definition },
      expectedExecutableDigest: compiled.executableDigest, deadline: Date.now() + 10_000, inputs: {} });
    const result = await executor.tick(options.actorId, runId);
    if (!approved) throw new Error("Host Python approval denied; no process was admitted.");
    const state = result?.state === "succeeded" ? "succeeded" : result?.state === "failed" ? "failed" : "unknown";
    return { workspaceId: options.workspaceId, actorId: options.actorId, environmentId: handle.environmentId, runId,
      state, ...processResult, ...(state !== "succeeded" && !processResult.error ? { error: "Python workflow did not complete; no automatic retry." } : {}) };
  } finally { executor?.close(); await runtime?.close({ drainMs: 0 }); database.close(); }
}
