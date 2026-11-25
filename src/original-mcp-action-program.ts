import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CoreError } from "./contracts.js";
import type { Storage } from "./storage.js";
import type { ActionAuthorizationBinding } from "./action-runtime.js";
import type { ActionProcessCommand } from "./action-runtime-process.js";
import { originalDigest } from "./domain/action-compiler-validation.js";
import { resolveActionExecutable } from "./action-program-build.js";
import type { OriginalMcpActionCustody } from "./original-mcp-action-domain.js";
import type { OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { readOriginalActionInvocations } from "./original-mcp-action-invocation.js";
import { RUNTIME_PROCESS_LIMITS } from "./runtime-process-contracts.js";
import { assertOriginalActionProgramDecision, originalActionProgramRequest,
  type OriginalActionProgramRequest } from "./original-mcp-action-program-contracts.js";

type Json = Record<string, any>;
export interface OriginalMcpActionProgramSelection { actionId: string; cwd: string }
export interface OriginalMcpActionProgramSource {
  actionId: string; definitionDigest: string; definition: Json; implementation: Json;
}
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const pin = (s: Stats) => [s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(":");
function fail(message: string): never { throw new CoreError("NATIVE_AUTHORITY_REQUIRED", message); }
function checkedFile(path: string, maximum: number) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum
    || (before.mode & 0o7002) !== 0 || realpathSync(path) !== path) fail("ACTION_PROGRAM_BYTES_CHANGED");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = readFileSync(fd);
    if (pin(before) !== pin(fstatSync(fd)) || pin(before) !== pin(lstatSync(path)) || bytes.length !== before.size)
      fail("ACTION_PROGRAM_BYTES_CHANGED");
    return { bytes, identity: pin(before) };
  } finally { closeSync(fd); }
}

/** Internal native composition only; decisions still come from the concrete current Action RPC. */
export function createOriginalMcpActionPrograms(input: {
  storage: Storage; host: OriginalMcpNativeHost; custody: OriginalMcpActionCustody;
  selections: readonly OriginalMcpActionProgramSelection[]; sources: readonly OriginalMcpActionProgramSource[];
  check(): void; refresh(): Promise<void>;
  authorize(binding: ActionAuthorizationBinding, inputs?: Record<string, unknown>): boolean;
  consent(request: OriginalActionProgramRequest, signal: AbortSignal): Promise<unknown>;
}) {
  const { storage, host, custody } = input, shutdown = new AbortController();
  if (input.selections.length !== 1) fail("ACTION_LOCAL_PROGRAM_SCOPE_REQUIRED: select one exact local program target.");
  const grants = new Map<string, { request: OriginalActionProgramRequest; consumed: boolean; expiresAtMs: number }>();
  const plans = new Map<string, { source: OriginalMcpActionProgramSource; assertCurrent(): void;
    request: Pick<OriginalActionProgramRequest, "executable" | "cwd" | "arguments" | "sources"> }>();
  let timer: ReturnType<typeof setTimeout> | undefined, checking = false, closed = false;
  for (const selection of input.selections) {
    if (plans.has(selection.actionId)) fail("Select each local program once.");
    const source = input.sources.find(source => source.actionId === selection.actionId), implementation = source?.implementation;
    if (!source || implementation?.kind !== "program" || implementation.build !== undefined
      || implementation.result_protocol !== undefined && implementation.result_protocol !== "pkm.action.result/v1"
      || Object.keys(source.definition.dependencies ?? {}).length || Object.keys(source.definition.casts ?? {}).length
      || originalDigest(source.definition.effects) !== originalDigest(["pure"]))
      fail("ACTION_LOCAL_PROGRAM_SCOPE_REQUIRED: only an exact dependency-free pure direct-child program is supported.");
    if (typeof implementation.program !== "string" || implementation.program.includes("${")
      || !Array.isArray(implementation.args) || implementation.args.some((arg: unknown) =>
        typeof arg !== "string" || arg.includes("\0") || arg.includes("${") || arg.startsWith("pkm://"))
      || implementation.args.length > 128 || Buffer.byteLength(JSON.stringify(implementation.args)) > 32768)
      fail("ACTION_LOCAL_PROGRAM_ARGUMENTS_REQUIRED");
    const executable = resolveActionExecutable(implementation.program);
    const proof = custody.toolchains.find(item => item.path === executable && item.role === "runtime");
    if (!proof || /^(?:sh|bash|dash|zsh|fish|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?)$/i.test(basename(proof.path)))
      fail("ACTION_LOCAL_PROGRAM_TOOLCHAIN_REQUIRED: shell and unpinned executables remain unavailable.");
    if (proof.path !== realpathSync(process.execPath) || !/^node(?:\.exe)?$/i.test(basename(proof.path)))
      fail("ACTION_LOCAL_PROGRAM_TOOLCHAIN_REQUIRED: this bounded adapter supports the independently pinned current Node runtime only.");
    if (isAbsolute(selection.cwd) || !selection.cwd || selection.cwd.split("/").some(part => !part || part === "." || part === "..")
      || /[\\:\u0000-\u001f]/u.test(selection.cwd)) fail("ACTION_LOCAL_PROGRAM_CONTEXT_REQUIRED");
    const cwd = resolve(custody.root, selection.cwd), info = lstatSync(cwd);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(cwd) !== cwd
      || info.uid !== process.getuid?.() || info.mode & 0o7077) fail("ACTION_LOCAL_PROGRAM_CONTEXT_REQUIRED");
    const cwdIdentity = [info.dev, info.ino, info.uid, info.mode].join(":");
    const selected = custody.files.filter(file => file.role !== "state" && file.role !== "toolchain");
    const contextFiles = selected.filter(file => file.path.startsWith(selection.cwd + "/"));
    if (!contextFiles.length) fail("ACTION_LOCAL_PROGRAM_CONTEXT_CUSTODY_REQUIRED");
    const argv = implementation.args as string[];
    const inline = argv.length === 2 && argv[0] === "-e"
      || argv.length === 3 && argv[0] === "--input-type=module" && argv[1] === "-e";
    const script = argv.length === 1 && !argv[0]!.startsWith("-") ? resolve(cwd, argv[0]!) : undefined;
    if (!inline && (!script || !contextFiles.some(file => join(custody.root, file.path) === script)))
      fail("ACTION_LOCAL_PROGRAM_ARGUMENTS_REQUIRED: only exact inline Node code or one sealed context script is admitted.");
    const assertCurrent = () => {
      input.check(); shutdown.signal.throwIfAborted();
      const current = lstatSync(cwd);
      if (realpathSync(cwd) !== cwd || current.isSymbolicLink()
        || [current.dev, current.ino, current.uid, current.mode].join(":") !== cwdIdentity)
        fail("ACTION_LOCAL_PROGRAM_CONTEXT_CHANGED");
      const checked = checkedFile(proof.path, 134217728);
      if (checked.identity !== proof.identity || hash(checked.bytes) !== proof.sha256)
        fail("ACTION_LOCAL_PROGRAM_TOOLCHAIN_CHANGED");
      const files: string[] = [];
      function visit(directory: string) {
        for (const member of readdirSync(directory)) {
          if (files.length >= 4096) fail("ACTION_LOCAL_PROGRAM_CONTEXT_CHANGED");
          const path = join(directory, member), stat = lstatSync(path);
          if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o7002)
            fail("ACTION_LOCAL_PROGRAM_CONTEXT_CHANGED");
          if (stat.isDirectory()) visit(path);
          else {
            const rel = relative(custody.root, path).split(sep).join("/");
            const record = contextFiles.find(file => file.path === rel);
            if (!record || hash(checkedFile(path, record.bytes).bytes) !== record.sha256)
              fail("ACTION_LOCAL_PROGRAM_CONTEXT_CHANGED");
            files.push(rel);
          }
        }
      }
      visit(cwd);
      if (files.length !== contextFiles.length) fail("ACTION_LOCAL_PROGRAM_CONTEXT_CHANGED");
    };
    assertCurrent();
    plans.set(source.actionId, { source, assertCurrent, request: {
      executable: { path: proof.path, sha256: proof.sha256, bytes: proof.bytes, identity: proof.identity },
      cwd: { path: cwd, device: String(info.dev), inode: String(info.ino) }, arguments: [...implementation.args],
      sources: selected.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
    } });
  }
  function liveGrant(runId: string) {
    const grant = grants.get(runId);
    if (!grant || grant.expiresAtMs <= Date.now()) fail("ACTION_LOCAL_PROGRAM_CONSENT_REQUIRED");
    return grant;
  }
  function monitor() {
    if (timer || closed || !grants.size) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (checking || closed) return;
      checking = true;
      void input.refresh().then(() => {
        input.check();
        const db = storage.connectNative();
        try {
          for (const [runId, grant] of grants) {
            const row = db.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id='mcp:external' AND run_id=?").get(runId);
            const snapshot = row && JSON.parse(String(row.snapshot)) as { state: string } | undefined;
            if (snapshot && ["succeeded", "failed", "cancelled", "unknown"].includes(snapshot.state))
              grants.delete(runId);
            else {
              liveGrant(runId);
              plans.get(grant.request.request.action_id)!.assertCurrent();
            }
          }
        } finally { db.close(); }
      }).catch(() => { shutdown.abort(); }).finally(() => { checking = false; if (!shutdown.signal.aborted) monitor(); });
    }, 50);
    timer.unref();
  }
  const commands: ActionProcessCommand[] = [...plans.values()].map(plan => ({
    id: `original-program-${hash(plan.source.actionId).slice(0, 32)}`, program: plan.source.implementation.program,
    executable: plan.request.executable.path, cwd: plan.request.cwd.path,
    arguments: plan.request.arguments.map(literal => ({ literal })), directChildOnly: true, signal: shutdown.signal,
    assertCurrent: plan.assertCurrent, outputContractDigest: originalDigest(plan.source.definition.output_schema),
    authorizationDigest: originalDigest({ capsuleSha256: custody.capsuleSha256, plan: plan.request }),
    authorizeDefinition: binding => input.authorize(binding),
    authorizeData: binding => input.authorize(binding, binding.inputs),
    async approve(approval) {
      await input.refresh(); plan.assertCurrent();
      if (!approval.runId) return false;
      const grant = liveGrant(approval.runId), request = grant.request;
      const call = readOriginalActionInvocations(storage, host.receipt.workspaceId).find(call => call.runId === approval.runId);
      if (grant.consumed || !call || request.request.action_id !== plan.source.actionId
        || request.request.content_hash !== approval.executableDigest || approval.actorId !== "mcp:external"
        || originalDigest(call.request) !== originalDigest(request.request)
        || call.sourceReceiptSha256 !== request.sourceReceiptSha256
        || originalDigest(approval.arguments) !== originalDigest(plan.request.arguments)
        || hash(canonicalInput(request.request.inputs)) !== approval.inputDigest) return false;
      grant.consumed = true; monitor(); return true;
    },
    redactOutput: value => value,
  }));
  return {
    commands,
    has(actionId: string) { return plans.has(actionId); },
    hasGrant(runId: string) { try { liveGrant(runId); return !shutdown.signal.aborted; } catch { return false; } },
    async approve(binding: Omit<OriginalActionProgramRequest, "schema" | "executable" | "cwd" | "arguments" | "sources" | "effects" | "authority">,
      signal?: AbortSignal) {
      const plan = plans.get(binding.request.action_id);
      if (!plan || closed) fail("ACTION_LOCAL_PROGRAM_SCOPE_REQUIRED");
      if (Buffer.byteLength(canonicalInput(binding.request.inputs)) > RUNTIME_PROCESS_LIMITS.inputBytes)
        fail("ACTION_LOCAL_PROGRAM_INPUT_LIMIT");
      const combined = AbortSignal.any([shutdown.signal, host.signal, ...(signal ? [signal] : [])]);
      combined.throwIfAborted(); plan.assertCurrent();
      const request = originalActionProgramRequest.parse({ ...binding, ...plan.request,
        schema: "pkm.original-mcp-local-program-request/v1", effects: ["pure"],
        authority: { scope: "exact-local-direct-child/v1", shell: false, inheritedEnvironment: false, credentials: false,
          network: false, descendants: false, build: false, automaticReplay: false } });
      const decision = assertOriginalActionProgramDecision(await input.consent(request, combined), request);
      combined.throwIfAborted(); await input.refresh(); plan.assertCurrent();
      grants.set(request.runId, { request, consumed: false, expiresAtMs: decision.expiresAtMs }); monitor();
      return { request, decision };
    },
    close() { closed = true; if (timer) clearTimeout(timer); timer = undefined; shutdown.abort(); grants.clear(); },
  };
}
function canonicalInput(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalInput).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalInput((value as Json)[key])}`).join(",")}}`;
}
