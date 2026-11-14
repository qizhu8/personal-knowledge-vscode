import { constants, accessSync, lstatSync, realpathSync, statSync, mkdirSync, readdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { WorkflowExecutor, type WorkflowStepAdapter } from "./workflow-executor.js";
import { RuntimeProcessService, RuntimeProcessStore } from "./runtime-process.js";
import { canonicalJson, compileWorkflowDefinitionV1 } from "./domain/project-recipes-workflow-contracts.js";
import { HostPythonScriptAdapter, pythonProgramSchema } from "./host-python-script-adapter.js";
import { workflowExecutorCreate } from "./workflow-executor-contracts.js";
import { localNodeProjectSchema, verifyNodeProject, nodeProjectStdin } from "./host-node-project.js";

const principal = z.string().min(1).max(256).regex(/^[^\0\r\n]+$/);
const pinSchema = z.strictObject(Object.fromEntries(["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"]
  .map(key => [key, z.string().regex(/^\d+$/)])) as Record<"dev" | "ino" | "mode" | "size" | "mtimeNs" | "ctimeNs", z.ZodString>);
export const localJournalSchema = z.strictObject({
  schema: z.literal("pkm.local-runtime-journal/v1"), workspaceId: z.uuid(), actorId: principal,
  directory: z.string().min(1), identity: z.string().regex(/^\d+:\d+$/),
});
export const localRuntimeSchema = z.strictObject({
  schema: z.literal("pkm.local-runtime-executor/v1"), workspaceId: z.uuid(), actorId: principal,
  environmentId: z.string().min(1).max(128), executorId: z.string().min(1).max(128),
  provider: z.enum(["node-diagnostic/v1", "dotnet8-diagnostic/v1", "node-project/v1"]),
  catalogDigest: z.string().regex(/^[a-f0-9]{64}$/), executable: z.string().min(1), target: z.string().min(1),
  entryPin: pinSchema, targetPin: pinSchema,
  project: localNodeProjectSchema.optional(),
});
export const localParametersSchema = z.strictObject({
  args: z.array(z.string().max(256).refine(value => !value.includes("\0"))).max(12)
    .refine(value => Buffer.byteLength(JSON.stringify(value)) <= 2048),
  waitMs: z.number().safe().int().min(0).max(20_000),
});
type Journal = z.infer<typeof localJournalSchema>;
type Handle = z.infer<typeof localRuntimeSchema>;
type Parameters = z.infer<typeof localParametersSchema>;
export const localEnvironmentCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("open"), journal: localJournalSchema, recover: z.boolean() }),
  z.strictObject({ operation: z.literal("start"), journal: localJournalSchema, runtime: localRuntimeSchema, parameters: localParametersSchema }),
  z.strictObject({ operation: z.literal("start-python"), journal: localJournalSchema, program: pythonProgramSchema }),
  z.strictObject({ operation: z.literal("status"), journal: localJournalSchema }),
  z.strictObject({ operation: z.literal("cancel"), journal: localJournalSchema, runId: z.string().regex(/^environment-[a-f0-9-]{36}$/) }),
]);
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const ACTOR = "local:owner", LEASE_MS = 4000;
const NODE_PROGRAM = `const args=process.argv.slice(2);const wait=Number(args.shift());
console.log(JSON.stringify({args}));const beat=setInterval(()=>{try{process.stdout.write("alive\\n")}catch{process.exit(1)}},250);
process.stdout.on("error",()=>process.exit(1));setTimeout(()=>{clearInterval(beat);console.log("done")},wait);`;
const CSHARP_PROGRAM = `using System; using System.Threading; using System.Text.Json;
class Program { static void Main(string[] values) {
int wait=int.Parse(values[0]); string[] args=new string[values.Length-1]; Array.Copy(values,1,args,0,args.Length);
Console.WriteLine(JsonSerializer.Serialize(new {args})); for(int elapsed=0;elapsed<wait;elapsed+=250) {
Thread.Sleep(Math.Min(250,wait-elapsed)); try {Console.WriteLine("alive");} catch {return;} } Console.WriteLine("done"); } }`;
function canonical(file: string) {
  if (!isAbsolute(file) || resolve(file) !== file || file.includes("\0")) throw new Error("Noncanonical native environment path.");
}
export function verifyLocalJournal(value: unknown, workspaceId: string): Journal {
  const handle = localJournalSchema.parse(value);
  if (handle.workspaceId !== workspaceId || handle.actorId !== ACTOR) throw new Error("Environment journal workspace/actor rejected.");
  canonical(handle.directory);
  const stat = lstatSync(handle.directory);
  if (realpathSync(handle.directory) !== handle.directory || !stat.isDirectory()
    || `${stat.dev}:${stat.ino}` !== handle.identity || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error("Environment journal identity/ownership rejected.");
  return handle;
}
export function verifyLocalRuntime(value: unknown, workspaceId: string): Handle {
  const handle = localRuntimeSchema.parse(value);
  if (handle.workspaceId !== workspaceId || handle.actorId !== ACTOR) throw new Error("Runtime workspace/actor rejected.");
  for (const file of [handle.executable, handle.target]) canonical(file);
  const same = (file: string, follow: boolean, pin: z.infer<typeof pinSchema>) => {
    const stat = follow ? statSync(file, { bigint: true }) : lstatSync(file, { bigint: true });
    return Object.entries(pin).every(([key, value]) => String(stat[key as keyof typeof stat]) === value);
  };
  if (realpathSync(dirname(handle.executable)) !== dirname(handle.executable)
    || realpathSync(handle.executable) !== handle.target || realpathSync(handle.target) !== handle.target
    || !statSync(handle.target).isFile() || !same(handle.executable, false, handle.entryPin) || !same(handle.target, true, handle.targetPin))
    throw new Error("Registered runtime pin changed.");
  accessSync(handle.executable, constants.X_OK);
  if (handle.provider === "node-project/v1") {
    if (!handle.project) throw new Error("An exact reviewed Node project is required.");
    verifyNodeProject(handle.project);
  } else if (handle.project) throw new Error("Project metadata cannot change a diagnostic provider.");
  return handle;
}
function dotnet8(handle: Handle) {
  const root = dirname(handle.target);
  const owner = statSync(handle.target).uid;
  const latest = (directory: string) => readdirSync(directory).filter(name => /^8\.0\.\d+$/.test(name))
    .sort((a, b) => Number(b.split(".")[2]) - Number(a.split(".")[2]))[0];
  try {
    const sdk = latest(join(root, "sdk")), pack = latest(join(root, "packs", "Microsoft.NETCore.App.Ref"));
    const runtime = latest(join(root, "shared", "Microsoft.NETCore.App"));
    if (!sdk || !pack || !runtime) throw new Error();
    const compiler = join(root, "sdk", sdk, "Roslyn", "bincore", "csc.dll");
    const refs = ["System.Runtime", "System.Console", "System.Threading.Thread", "System.Text.Json", "System.Collections"]
      .map(name => join(root, "packs", "Microsoft.NETCore.App.Ref", pack, "ref", "net8.0", `${name}.dll`));
    const assets = [compiler, ...refs,
      ...["csc.runtimeconfig.json", "csc.deps.json", "Microsoft.CodeAnalysis.dll", "Microsoft.CodeAnalysis.CSharp.dll"].map(name => join(dirname(compiler), name)),
      ...["System.Private.CoreLib.dll", "libcoreclr.so", "libhostpolicy.so"].map(name => join(root, "shared", "Microsoft.NETCore.App", runtime, name))];
    for (const file of assets) {
      const stat = statSync(file);
      if (realpathSync(file) !== file || !stat.isFile() || stat.uid !== owner || (stat.mode & 0o022) !== 0) throw new Error();
      for (let directory = dirname(file); directory.startsWith(root); directory = dirname(directory)) {
        const parent = lstatSync(directory);
        if (!parent.isDirectory() || parent.uid !== owner || (parent.mode & 0o022) !== 0) throw new Error();
        if (directory === root) break;
      }
    }
    const identity = hash(assets.map(file => {
      const stat = statSync(file, { bigint: true });
      return [file, ...["dev", "ino", "size", "mtimeNs", "ctimeNs"].map(key => String(stat[key as keyof typeof stat]))];
    }));
    return { compiler, refs, runtime, identity };
  } catch { throw new Error("A complete local owner-consistent .NET 8 SDK/reference/runtime pack is unavailable. Nothing was downloaded or installed."); }
}
export class HostLocalEnvironmentWorkflow {
  private readonly database: DatabaseSync;
  private readonly ownerId = randomUUID();
  private readonly executor: WorkflowExecutor;
  private runtime?: RuntimeProcessService;
  private python?: HostPythonScriptAdapter;
  private readonly work = new Map<string, Promise<unknown>>();
  private readonly executions = new Set<Promise<unknown>>();
  private readonly handles = new Map<string, { handle: Handle; parameters: Parameters; digest: string;
    sdk?: ReturnType<typeof dotnet8>; programDigest?: string }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;
  private closing?: Promise<void>;
  constructor(private readonly journal: Journal, private readonly workspaceRoot: string, recover: boolean,
    options: { resolveRecipe?: ConstructorParameters<typeof WorkflowExecutor>[1]["resolveRecipe"] } = {}) {
    verifyLocalJournal(journal, journal.workspaceId);
    if (realpathSync(workspaceRoot) !== workspaceRoot || !statSync(workspaceRoot).isDirectory()) throw new Error("Isolated workspace root changed.");
    const file = join(journal.directory, "runs.sqlite");
    for (const candidate of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
      try {
        const stat = lstatSync(candidate);
        if (!stat.isFile() || realpathSync(candidate) !== candidate || stat.uid !== process.getuid?.())
          throw new Error("Journal DB/sidecar is not an owned regular canonical file.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.database = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS local_environment_owner(singleton INTEGER PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL,closed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS local_environment_runs(run_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,environment_id TEXT NOT NULL,provider TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS local_environment_jobs(run_id TEXT NOT NULL,job_id TEXT NOT NULL,phase TEXT NOT NULL);`);
    let previousOwner: string | undefined;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      const prior = this.database.prepare("SELECT * FROM local_environment_owner WHERE singleton=1").get();
      if (prior && prior.closed !== 1 && Number(prior.expires) > Date.now()) throw new Error("Environment journal has a live owner; do not steal its lease.");
      if (prior && prior.closed !== 1 && !recover) throw new Error("Interrupted environment journal: explicitly choose recovery; no automatic replay.");
      const runtimeOwner = this.database.prepare("SELECT name FROM sqlite_master WHERE name='runtime_process_owner'").get();
      if (runtimeOwner) previousOwner = String(this.database.prepare("SELECT owner_id FROM runtime_process_owner WHERE singleton=1").get()?.owner_id ?? "") || undefined;
      this.database.prepare("INSERT INTO local_environment_owner VALUES(1,?,?,0) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,expires=excluded.expires,closed=0")
        .run(this.ownerId, Date.now() + LEASE_MS);
      this.database.exec("COMMIT");
      this.runtime = new RuntimeProcessService({
        repositoryFactory: (owner, capacity) => new RuntimeProcessStore(this.database, owner, capacity, previousOwner),
        adapters: [], resolveAdapter: (id, input) => this.python?.processAdapter(id, input) ?? this.processAdapter(id, input),
        authorizeLaunch: async () => { this.assertOwner(); return true; },
        limits: { concurrency: 1, queue: 0, stdoutBytes: 4096, stderrBytes: 1024, deadlineMs: 25_000, graceMs: 100 },
      });
      this.python = new HostPythonScriptAdapter({ workspaceId: journal.workspaceId, workspaceRoot, runtime: this.runtime,
        check: () => this.assertOwner(),
        jobCreated: (runId, jobId, phase) => { this.database.prepare("INSERT INTO local_environment_jobs VALUES(?,?,?)").run(runId, jobId, phase); },
        track: work => {
          this.executions.add(work);
          void work.finally(() => this.executions.delete(work)).catch(() => undefined);
          return work;
        },
        ...(options.resolveRecipe ? { verifyRecipeSource: program => {
          const current = options.resolveRecipe!({ kind: "recipe", recipeId: program.source.recipeId,
            expectedRevision: program.source.revision, expectedExecutableDigest: program.source.executableDigest,
            snapshotRevision: program.source.snapshotRevision });
          if (current.executableDigest !== program.executableDigest || canonicalJson(current.source) !== canonicalJson(program.source))
            throw new Error("Approved native Recipe snapshot changed.");
        } } : {}),
      });
      this.executor = new WorkflowExecutor(this.database, { workspaceRoot, ownerId: this.ownerId, leaseMs: 30_000,
        adapters: { "pkm.step.command/v1": this.adapter(), "pkm.step.script/v1": this.python.adapter() },
        ...(options.resolveRecipe ? { resolveRecipe: options.resolveRecipe } : {}), assertOwner: () => this.assertOwner() });
      const rows = this.database.prepare("SELECT actor_id,run_id FROM workflow_executor_runs").all();
      for (const row of rows) this.executor.interruptHostOwnedRun(String(row.actor_id), String(row.run_id));
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      this.database.close(); throw error;
    }
    this.timer = setInterval(() => {
      try {
        this.assertOwner();
        this.database.prepare("UPDATE local_environment_owner SET expires=? WHERE owner=? AND closed=0")
          .run(Date.now() + LEASE_MS, this.ownerId);
      } catch { void this.close().catch(() => undefined); }
    }, 500);
  }
  private assertOwner() {
    verifyLocalJournal(this.journal, this.journal.workspaceId);
    const owner = this.database.prepare("SELECT * FROM local_environment_owner WHERE singleton=1").get();
    if (this.stopped || owner?.owner !== this.ownerId || owner.closed !== 0 || Number(owner.expires) <= Date.now())
      throw new Error("Environment host lease lost; no new effects admitted.");
  }
  private processAdapter(id: string, input: unknown) {
    const data = z.strictObject({ runId: z.string(), phase: z.enum(["compile", "run"]) }).parse(input);
    const selected = this.handles.get(data.runId);
    if (!selected || id !== `local-${data.phase}`) throw new Error("No approved native runtime registration.");
    const { handle, parameters } = selected;
    verifyLocalRuntime(handle, this.journal.workspaceId);
    const program = join(this.journal.directory, data.runId);
    const dotnet = selected.sdk;
    const env: Record<string, string> = dotnet ? { DOTNET_CLI_HOME: program, DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
      DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_MULTILEVEL_LOOKUP: "0" } : {};
    return { id, executable: handle.executable, cwd: handle.project?.root ?? this.workspaceRoot, env,
      stdin: !dotnet, outputPersistence: "stored" as const,
      arguments: () => {
        this.assertOwner(); verifyLocalRuntime(handle, this.journal.workspaceId);
        if (handle.project) return ["--no-addons", ...(handle.project.typescript ? ["--experimental-strip-types"] : []),
          "--input-type=commonjs", "-", ...parameters.args];
        if (!dotnet) return ["--no-addons", "--input-type=commonjs", "-", String(parameters.waitMs), ...parameters.args];
        if (dotnet8(handle).identity !== dotnet.identity) throw new Error("Selected local SDK changed; reselect and approve again.");
        if (data.phase === "compile") return [dotnet.compiler, "-nologo", "-noconfig", "-nostdlib", "-target:exe",
          `-out:${join(program, "Program.dll")}`, ...dotnet.refs.map(file => `-r:${file}`), join(program, "Program.cs")];
        const executable = join(program, "Program.dll");
        if (realpathSync(program) !== program || realpathSync(executable) !== executable || !statSync(executable).isFile())
          throw new Error("Controlled compiled C# program changed.");
        if (selected.programDigest !== this.programDigest(program)) throw new Error("Compiled C# program/configuration changed.");
        return [executable, String(parameters.waitMs), ...parameters.args];
      },
    };
  }
  private programDigest(directory: string) {
    return hash(["Program.dll", "Program.runtimeconfig.json"].map(name =>
      createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")));
  }
  private adapter(): WorkflowStepAdapter {
    const execute: WorkflowStepAdapter["execute"] = async (invocation, context) => {
      const selected = this.handles.get(invocation.runId);
      if (!selected || selected.digest !== invocation.executableDigest || context.signal.aborted) return { status: "failed", outputs: {} };
      const { handle, parameters } = selected;
      const launch = async (phase: "compile" | "run") => {
        this.assertOwner(); verifyLocalRuntime(handle, this.journal.workspaceId);
        const job = await this.runtime!.launch({ actorId: ACTOR, operationId: randomUUID(), adapterId: `local-${phase}`,
          input: { runId: invocation.runId, phase }, deadlineMs: 25_000,
          ...(handle.project ? { stdin: nodeProjectStdin(handle.project) }
            : handle.provider === "node-diagnostic/v1" ? { stdin: Buffer.from(NODE_PROGRAM) } : {}) });
        this.database.prepare("INSERT INTO local_environment_jobs VALUES(?,?,?)").run(invocation.runId, job.jobId, phase);
        const cancel = () => { void this.runtime!.cancel(ACTOR, job.jobId).catch(() => undefined); };
        context.signal.addEventListener("abort", cancel, { once: true });
        if (context.signal.aborted) cancel();
        try {
          for (;;) {
            const status = this.runtime!.status(ACTOR, job.jobId);
            if (!["QUEUED", "RUNNING"].includes(status.state)) return status;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        } finally { context.signal.removeEventListener("abort", cancel); }
      };
      if (handle.provider === "dotnet8-diagnostic/v1") {
        const sdk = selected.sdk!, program = join(this.journal.directory, invocation.runId);
        mkdirSync(program, { mode: 0o700 });
        writeFileSync(join(program, "Program.cs"), CSHARP_PROGRAM, { flag: "wx", mode: 0o600 });
        writeFileSync(join(program, "Program.runtimeconfig.json"), JSON.stringify({
          runtimeOptions: { tfm: "net8.0", framework: { name: "Microsoft.NETCore.App", version: sdk.runtime } },
        }), { flag: "wx", mode: 0o600 });
        const compiled = await launch("compile");
        if (compiled.state !== "SUCCEEDED" || context.signal.aborted) return { status: "failed", outputs: {} };
        selected.programDigest = this.programDigest(program);
      }
      const result = await launch("run");
      const stdout = Buffer.from(result.stdout, "base64").toString("utf8");
      if (handle.project) return result.state === "SUCCEEDED" && result.exitCode === 0
        ? { status: "succeeded", outputs: { stdout, exitCode: 0 } }
        : { status: result.state === "INTERRUPTED" ? "unknown" : "failed", outputs: {} };
      let valid = false;
      try { valid = canonicalJson(JSON.parse(stdout.split(/\r?\n/)[0])) === canonicalJson({ args: parameters.args }); } catch { /* Invalid provider output. */ }
      if (result.state !== "SUCCEEDED" || result.exitCode !== 0 || !valid || !stdout.trimEnd().endsWith("done"))
        return { status: result.state === "INTERRUPTED" ? "unknown" : "failed", outputs: {} };
      return { status: "succeeded", outputs: { stdout, exitCode: 0 } };
    };
    return {
      id: "host-local-controlled-program", version: 1, outputContractDigest: hash("local-controlled-program:args:stdout:v1"),
      authorizationDigest: hash({ owner: this.ownerId, workspace: this.journal.workspaceId }),
      authorizeDefinition: binding => {
        this.assertOwner();
        return binding.actorId === ACTOR && binding.node.kind === "pkm.step.command/v1"
          && binding.node.config.program === "host-local-controlled-program"
          && [...this.handles.values()].some(item => item.digest === binding.executableDigest);
      },
      authorizeData: binding => Object.keys(binding.inputs).length === 0,
      validateOutput: outputs => typeof outputs.stdout === "string" && outputs.exitCode === 0,
      execute: (invocation, context) => {
        const work = execute(invocation, context);
        this.executions.add(work);
        void work.finally(() => this.executions.delete(work)).catch(() => undefined);
        return work;
      },
    };
  }
  start(value: unknown, parametersValue: unknown) {
    this.assertOwner();
    if (this.work.size || this.executions.size) throw new Error("An environment program is already active or draining.");
    const handle = verifyLocalRuntime(value, this.journal.workspaceId), parameters = localParametersSchema.parse(parametersValue);
    if (handle.project && parameters.waitMs !== 0) throw new Error("Project programs use their own lifecycle, not diagnostic wait parameters.");
    const sdk = handle.provider === "dotnet8-diagnostic/v1" ? dotnet8(handle) : undefined;
    const runId = `environment-${randomUUID()}`;
    const definition = { schema: "pkm.workflow.definition/v1" as const, spec: { inputs: {}, outputs: {},
      nodes: [{ nodeId: "program", kind: "pkm.step.command/v1" as const, dependsOn: [],
        config: { program: "host-local-controlled-program", args: [String(parameters.waitMs), ...parameters.args], timeoutSeconds: 30, maxOutputBytes: 4096 } }],
      completion: { requiredNodes: ["program"] } } };
    const compiled = compileWorkflowDefinitionV1(definition);
    if (!compiled.ok) throw new Error("Controlled local program Workflow compilation failed.");
    this.handles.set(runId, { handle, parameters, digest: compiled.executableDigest, sdk });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.executor.createInTransaction(ACTOR, { operationId: randomUUID(), runId, source: { kind: "inline", definition },
        expectedExecutableDigest: compiled.executableDigest, deadline: Date.now() + 60_000, inputs: {} });
      this.database.prepare("INSERT INTO local_environment_runs VALUES(?,?,?,?,?)")
        .run(runId, this.journal.workspaceId, handle.environmentId, handle.provider, Date.now());
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); this.handles.delete(runId); throw error; }
    const work = Promise.resolve().then(() => this.executor.tick(ACTOR, runId))
      .catch(() => { try { this.executor.interruptHostOwnedRun(ACTOR, runId); } catch { /* Preserve unknown on lost ownership. */ } })
      .finally(() => { this.work.delete(runId); this.handles.delete(runId); });
    this.work.set(runId, work);
    return this.status(runId);
  }
  startPython(value: unknown) {
    this.assertOwner();
    if (this.work.size || this.executions.size) throw new Error("An environment program is already active or draining.");
    const runId = `environment-${randomUUID()}`, { program, compiled } = this.python!.register(runId, value);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.executor.createInTransaction(ACTOR, workflowExecutorCreate.parse({ operationId: randomUUID(), runId,
        source: program.source.kind === "inline" ? { kind: "inline", definition: compiled.model }
          : { kind: "recipe", recipeId: program.source.recipeId, expectedRevision: program.source.revision,
            expectedExecutableDigest: program.source.executableDigest, snapshotRevision: program.source.snapshotRevision },
        expectedExecutableDigest: compiled.executableDigest, deadline: Date.now() + 90_000, inputs: program.inputs }));
      this.database.prepare("INSERT INTO local_environment_runs VALUES(?,?,?,?,?)")
        .run(runId, this.journal.workspaceId, program.handle.environmentId, "python-script/v1", Date.now());
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); this.python!.release(runId); throw error; }
    const work = Promise.resolve().then(() => this.executor.tick(ACTOR, runId))
      .then(async () => {
        while (["ready", "running"].includes(this.executor.get(ACTOR, runId).state))
          await this.executor.tick(ACTOR, runId);
      })
      .catch(() => { try { this.executor.interruptHostOwnedRun(ACTOR, runId); } catch { /* Lost owner cannot publish output. */ } })
      .finally(() => { this.work.delete(runId); this.python!.release(runId); });
    this.work.set(runId, work);
    return this.status(runId);
  }
  status(runId?: string) {
    this.assertOwner();
    return this.database.prepare("SELECT * FROM local_environment_runs ORDER BY created DESC LIMIT 64").all()
      .filter(row => runId === undefined || row.run_id === runId).map(row => {
        const run = this.executor.get(ACTOR, String(row.run_id));
        const jobs = this.database.prepare("SELECT j.phase,p.record_json FROM local_environment_jobs j JOIN runtime_process_jobs p ON p.job_id=j.job_id WHERE j.run_id=?")
          .all(String(row.run_id)).map(job => {
            const record = JSON.parse(String(job.record_json));
            return { phase: job.phase, state: record.state, effect: record.effect, exitCode: record.exitCode,
              stdout: Buffer.from(record.stdout, "base64").toString("utf8"), stderr: Buffer.from(record.stderr, "base64").toString("utf8") };
          });
        return { runId: row.run_id, workspaceId: row.workspace_id, environmentId: row.environment_id, provider: row.provider,
          state: run.state, effect: run.nodes.some(node => node.effect === "unknown") ? "unknown"
            : run.nodes.some(node => node.effect === "known") ? "known" : "not-started", version: run.version, jobs };
      });
  }
  cancel(runId: string) {
    this.assertOwner();
    if (!this.work.has(runId)) throw new Error("Only this live host's active environment run can be cancelled.");
    const run = this.executor.get(ACTOR, runId);
    this.executor.cancel(ACTOR, { runId, operationId: randomUUID(), expectedVersion: run.version });
    return this.status(runId);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    clearInterval(this.timer);
    this.closing = (async () => {
      let failure: unknown;
      try { this.executor.close(); } catch (error) { failure = error; }
      try { await this.runtime?.close({ drainMs: 0 }); }
      catch (error) {
        this.stopped = true;
        // Runtime may still need this repository to reap its owned child. Preserve the unclosed lease.
        throw error;
      }
      await Promise.allSettled([...this.executions]);
      await Promise.all(this.work.values());
      this.stopped = true;
      try {
        if (failure) throw failure;
        this.database.prepare("UPDATE local_environment_owner SET closed=1 WHERE owner=?").run(this.ownerId);
      } finally { this.database.close(); }
    })();
    return this.closing;
  }
}
