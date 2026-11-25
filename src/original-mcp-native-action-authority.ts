import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { assertStorage, type Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { assertAuthenticatedOriginalMcpNativeSession, type AuthenticatedOriginalMcpNativeSession } from "./original-mcp-native-attachment.js";
import { originalMcpNativeRequestMethods, requestOriginalMcpNative,
  waitForOriginalMcpNativeSupport } from "./original-mcp-native-request.js";
import { originalDigest } from "./domain/action-compiler-validation.js";
import { assertOriginalMcpActionDomainSession, readOriginalMcpActionCustodySources,
  verifyOriginalMcpActionNativeFootprint, type OriginalMcpActionCustody } from "./original-mcp-action-domain.js";
import { readOriginalActionInvocations } from "./original-mcp-action-invocation.js";
import { actionCheckpoint, checkActionCheckpointAnswer } from "./action-runtime-checkpoints.js";
import { originalActionProgramMethod, originalActionProgramRequest, originalActionProgramPayload,
  assertOriginalActionProgramDecision, type OriginalActionProgramRequest } from "./original-mcp-action-program-contracts.js";
import { resolveActionExecutable } from "./action-program-build.js";
import { originalMcpPrivateBytes } from "./original-mcp-root-custody.js";
import {
  originalNativeActionMethods, originalNativeActionPayloadSchemas, originalNativeActionResultSchemas,
  originalNativeActionSourceRequest, parseOriginalNativeActionConsent,
  type OriginalNativeActionMethod, type OriginalNativeActionPayload, type OriginalNativeActionResult,
} from "./original-mcp-native-action-contracts.js";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const pin = (stat: Stats) => [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const localRequest = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("status"), storePath: z.string(), token: z.string() }),
  z.strictObject({ operation: z.literal("authorize"), storePath: z.string(), token: z.string(),
    actionId: z.string(), contentHash: z.string(), trustEpoch: z.string() }),
  z.strictObject({ operation: z.literal("source_admission"), storePath: z.string(), token: z.string(),
    trustEpoch: z.string(), sourceAdmission: originalNativeActionSourceRequest }),
  z.strictObject({ operation: z.literal("effect_consent"), storePath: z.string(), token: z.string(),
    actionId: z.string(), contentHash: z.string(), trustEpoch: z.string(), effectContext: z.unknown() }),
  z.strictObject({ operation: z.literal("program_consent"), storePath: z.string(), token: z.string(),
    trustEpoch: z.string(), programAdmission: originalActionProgramRequest }),
]);
export interface OriginalMcpNativeActionAuthority {
  readonly kind: "pkm.original-native-action-authority/v1";
  readonly root: string;
  readonly workspaceId: string;
  readonly profileSha256: string;
  readonly epoch: string;
  readonly capsuleSha256: string;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  close(): Promise<void>;
}
const locators = new WeakMap<object, {
  storage: Storage; host: OriginalMcpNativeHost; session: AuthenticatedOriginalMcpNativeSession; current(): void;
}>();
export function assertOriginalMcpNativeActionAuthority(value: unknown, storage: Storage, host: OriginalMcpNativeHost):
  asserts value is OriginalMcpNativeActionAuthority {
  const state = value && typeof value === "object" ? locators.get(value) : undefined;
  if (!state || state.storage !== storage || state.host !== host) fail("NATIVE_ACTION_PRODUCER_LOCATOR_REQUIRED");
  assertAuthenticatedOriginalMcpNativeSession(state.session); state.current();
}
function syncDirectory(path: string) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/**
 * Same-owner compatibility endpoint for the existing concrete Action bridge.
 * All decisions originate on the signed attachment; UI code never writes root state.
 */
export async function startOriginalMcpNativeActionAuthority(storage: Storage, host: OriginalMcpNativeHost,
  session: AuthenticatedOriginalMcpNativeSession, custody: OriginalMcpActionCustody): Promise<OriginalMcpNativeActionAuthority> {
  assertStorage(storage); assertOriginalMcpNativeHost(host, storage); assertAuthenticatedOriginalMcpNativeSession(session);
  const root = storage.workspaceRoot(), signed = session.binding;
  if (signed.root !== root || signed.workspaceId !== host.receipt.workspaceId || signed.planSha256 !== host.receipt.planSha256
    || signed.profileSha256 !== host.receipt.profileSha256 || signed.catalogSha256 !== host.receipt.sourceCatalogSha256
    || session.activationId !== host.receipt.epoch || host.receipt.authorityId !== `native-rpc:${session.brokerId}`)
    fail("NATIVE_ACTION_SIGNED_OWNER_BINDING_REQUIRED");
  const footprint = verifyOriginalMcpActionNativeFootprint(root);
  if (!footprint || footprint.capsuleSha256 !== custody.capsuleSha256) fail("NATIVE_ACTION_FOOTPRINT_REQUIRED");
  const sources = readOriginalMcpActionCustodySources(storage, host, custody);
  const supported = await waitForOriginalMcpNativeSupport(session, { timeoutMs: 30000, signal: host.signal });
  if (originalNativeActionMethods.some(method => !supported.some(candidate => String(candidate) === method)))
    fail("MISSING_NATIVE_METHOD");
  const { receiptSha256: _receipt, ...binding } = host.receipt;
  const directory = join(root, ".pkm-action-authority"), path = join(directory, "host-authority.json");
  const lifetime = new AbortController(), sockets = new Set<Socket>(), token = randomBytes(32).toString("hex");
  let filePin: string | undefined, directoryIdentity: string | undefined, contentSha256: string | undefined;
  let closed = false, closing: Promise<void> | undefined;
  const owner = () => {
    assertOriginalMcpNativeHost(host, storage); assertAuthenticatedOriginalMcpNativeSession(session);
    storage.assertWorkspaceLease();
  };
  function controls() {
    if (!filePin || !directoryIdentity || !contentSha256) fail("NATIVE_ACTION_ENDPOINT_NOT_PUBLISHED");
    const directoryStat = lstatSync(directory), file = lstatSync(path);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || realpathSync(directory) !== directory
      || [directoryStat.dev, directoryStat.ino, directoryStat.uid, directoryStat.mode].join(":") !== directoryIdentity
      || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || pin(file) !== filePin
      || readdirSync(directory).join(",") !== "host-authority.json" || file.size > 8192 || hash(originalMcpPrivateBytes(path, 8192)) !== contentSha256)
      fail("NATIVE_ACTION_ENDPOINT_CHANGED");
  }
  function current() {
    owner();
    if (closed || lifetime.signal.aborted || !server.listening) fail("NATIVE_ACTION_PRODUCER_REVOKED");
    controls();
  }
  async function request<M extends OriginalNativeActionMethod>(method: M, payload: OriginalNativeActionPayload<M>,
    signal: AbortSignal): Promise<OriginalNativeActionResult<M>> {
    current();
    // The generic signed protocol remains the only transport. Before parent integration,
    // unknown Action methods fail closed rather than accepting an injected callback.
    const name: string = method, id = originalMcpNativeRequestMethods.find(candidate => candidate === name);
    if (!id) return fail("MISSING_NATIVE_METHOD");
    const result = originalNativeActionResultSchemas[method].parse(await requestOriginalMcpNative(session, id, payload,
      { signal, timeoutMs: method === "action.status" || method === "action.authorize" ? 2500 : 120000 }));
    current();
    if (result && "trustEpoch" in result && result.trustEpoch !== session.activationId) fail("NATIVE_ACTION_EPOCH_MISMATCH");
    return result as OriginalNativeActionResult<M>;
  }
  async function handle(input: z.infer<typeof localRequest>, signal: AbortSignal) {
    current();
    if (input.storePath !== root || input.token.length !== token.length
      || !timingSafeEqual(Buffer.from(input.token), Buffer.from(token))) fail("NATIVE_ACTION_ENDPOINT_AUTHENTICATION_FAILED");
    if ("trustEpoch" in input && input.trustEpoch !== session.activationId) fail("NATIVE_ACTION_EPOCH_MISMATCH");
    const common = { binding, capsuleSha256: custody.capsuleSha256 };
    if (input.operation === "status") {
      const status = await request("action.status", common, signal);
      return { ok: status.trusted, trusted: status.trusted, trustEpoch: status.trustEpoch };
    }
    if (input.operation === "authorize") {
      if (!sources.some(source => source.actionId === input.actionId && source.contentHash === input.contentHash))
        fail("NATIVE_ACTION_SELECTED_SOURCE_REQUIRED");
      const result = await request("action.authorize", { ...common, actionId: input.actionId,
        contentHash: input.contentHash, trustEpoch: session.activationId }, signal);
      return { ok: result.decision === "approve", trusted: result.decision === "approve", trustEpoch: result.trustEpoch };
    }
    if (input.operation === "source_admission") {
      const sourceRequest = input.sourceAdmission;
      const expected = sources.map(({ actionId, contentHash, implementationSha256, effects }) =>
        ({ actionId, contentHash, implementationSha256, effects }));
      if (sourceRequest.root !== root || sourceRequest.workspaceId !== signed.workspaceId
        || sourceRequest.profileSha256 !== signed.profileSha256 || sourceRequest.epoch !== session.activationId
        || sourceRequest.capsuleSha256 !== custody.capsuleSha256 || originalDigest(sourceRequest.sources) !== originalDigest(expected))
        fail("NATIVE_ACTION_SELECTED_SOURCE_REQUIRED");
      const decision = await request("action.source.approve", { binding, request: sourceRequest }, signal);
      if (decision && (decision.root !== root || decision.workspaceId !== signed.workspaceId
        || decision.profileSha256 !== signed.profileSha256 || decision.epoch !== session.activationId
        || decision.capsuleSha256 !== custody.capsuleSha256 || decision.requestSha256 !== sourceRequest.requestSha256
        || decision.expiresAtMs <= Date.now() || decision.expiresAtMs > Date.now() + 300000))
        fail("NATIVE_ACTION_SOURCE_DECISION_MISMATCH");
      return { ok: !!decision, trusted: true, trustEpoch: session.activationId, consented: !!decision,
        ...(decision ? { sourceDecision: decision } : {}) };
    }
    if (input.operation === "program_consent") {
      const request = input.programAdmission;
      function currentProgram(value: OriginalActionProgramRequest) {
        const receipt = assertOriginalMcpActionDomainSession(storage, host);
        const source = sources.find(item => item.actionId === value.request.action_id && item.contentHash === value.request.content_hash);
        const program = source?.program;
        const proof = custody.toolchains.find(item => item.path === value.executable.path && item.role === "runtime");
        const expected = custody.files.filter(file => file.role !== "state" && file.role !== "toolchain")
          .map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
        const cwd = value.cwd.path, relative = cwd.startsWith(root + "/") ? cwd.slice(root.length + 1) : undefined;
        const directory = lstatSync(cwd), executable = proof && lstatSync(proof.path);
        if (!program || program.kind !== "program" || program.build !== undefined || !proof || !executable
          || value.root !== root || value.workspaceId !== signed.workspaceId || value.profileSha256 !== signed.profileSha256
          || value.epoch !== session.activationId || value.capsuleSha256 !== custody.capsuleSha256
          || value.sourceReceiptSha256 !== receipt.receiptSha256 || value.nativeHostReceiptSha256 !== host.receipt.receiptSha256
          || value.implementationSha256 !== source.implementationSha256 || originalDigest(source.effects) !== originalDigest(["pure"])
          || resolveActionExecutable(String(program.program)) !== proof.path
          || originalDigest(value.arguments) !== originalDigest(program.args ?? [])
          || value.executable.sha256 !== proof.sha256 || value.executable.bytes !== proof.bytes || value.executable.identity !== proof.identity
          || pin(executable) !== proof.identity || hash(originalMcpPrivateBytesForExecutable(proof.path)) !== proof.sha256
          || originalDigest(value.sources) !== originalDigest(expected) || !relative
          || !expected.some(file => file.path.startsWith(relative + "/"))
          || !directory.isDirectory() || directory.isSymbolicLink() || realpathSync(cwd) !== cwd
          || String(directory.dev) !== value.cwd.device || String(directory.ino) !== value.cwd.inode)
          fail("NATIVE_ACTION_PROGRAM_BINDING_MISMATCH");
      }
      currentProgram(request);
      const id = originalMcpNativeRequestMethods.find(method => String(method) === originalActionProgramMethod);
      if (!id) fail("MISSING_NATIVE_METHOD");
      const payload = originalActionProgramPayload.parse({ binding, request });
      const decision = await requestOriginalMcpNative(session, id, payload, { signal, timeoutMs: 120000 });
      current(); currentProgram(request);
      const checked = decision === null ? null : assertOriginalActionProgramDecision(decision, request);
      return { ok: !!checked, trusted: true, trustEpoch: session.activationId, programDecision: checked };
    }
    const effectContext = originalNativeActionPayloadSchemas["action.invocation.approve"].shape.effectContext.parse(input.effectContext);
    const consent = parseOriginalNativeActionConsent(effectContext);
    const source = sources.find(item => item.actionId === input.actionId && item.contentHash === input.contentHash);
    function assertInvocationBindings() {
      const receipt = assertOriginalMcpActionDomainSession(storage, host);
      if (!source?.nativeControl || consent.capsuleSha256 !== custody.capsuleSha256
        || consent.sourceReceiptSha256 !== receipt.receiptSha256 || consent.implementationSha256 !== source.implementationSha256
        || originalDigest(effectContext.effects) !== originalDigest(source.effects)
        || originalDigest(effectContext.components) !== originalDigest(source.components))
        fail("NATIVE_ACTION_INVOCATION_BINDING_MISMATCH");
      if (consent.operation === "action_call") return;
      const call = readOriginalActionInvocations(storage, signed.workspaceId).find(item => item.runId === consent.run_id);
      const database = storage.connectNative();
      try {
        const row = database.prepare("SELECT snapshot FROM action_runtime_runs WHERE actor_id='mcp:external' AND run_id=?").get(consent.run_id);
        const snapshot = row && JSON.parse(String(row.snapshot)) as { version: number; state: string;
          definitionDigest: string; inputs: unknown; sourceSnapshot: unknown; implementation: unknown; checkpoints?: unknown[] } | undefined;
        if (!call || originalDigest(call.request) !== originalDigest(consent.request) || !snapshot
          || snapshot.state !== "waiting" || snapshot.version !== consent.expected_version
          || snapshot.definitionDigest !== call.request.content_hash || originalDigest(snapshot.inputs) !== originalDigest(call.request.inputs)
          || originalDigest(snapshot.sourceSnapshot) !== call.sourceSnapshotSha256
          || originalDigest(snapshot.implementation) !== call.implementationSha256)
          return fail("NATIVE_ACTION_CONTINUATION_BINDING_MISMATCH");
        const checked = actionCheckpoint.safeParse(snapshot.checkpoints?.at(-1));
        if (!checked.success || checked.data.state !== "waiting" || checked.data.run_id !== consent.run_id)
          return fail("NATIVE_ACTION_CONTINUATION_BINDING_MISMATCH");
        const checkpoint = checked.data;
        if (consent.operation === "action_checkpoint_respond") {
          if (checkpoint.trigger.kind !== "human" || checkpoint.checkpoint_id !== consent.response.checkpoint_id
            || checkpoint.resume_token !== consent.response.resume_token || checkpoint.proposal_digest !== consent.response.proposal_digest)
            fail("NATIVE_ACTION_CONTINUATION_BINDING_MISMATCH");
          checkActionCheckpointAnswer(checkpoint, consent.response.answer);
        } else if (checkpoint.trigger.kind !== "event" || checkpoint.trigger.name !== consent.response.event_name)
          fail("NATIVE_ACTION_CONTINUATION_BINDING_MISMATCH");
      } finally { database.close(); }
    }
    function originalMcpPrivateBytesForExecutable(path: string) {
      const before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size > 134217728 || before.mode & 0o6022)
        fail("NATIVE_ACTION_PROGRAM_TOOLCHAIN_CHANGED");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const bytes = readFileSync(fd);
        if (pin(before) !== pin(fstatSync(fd)) || pin(before) !== pin(lstatSync(path)) || bytes.length !== before.size)
          fail("NATIVE_ACTION_PROGRAM_TOOLCHAIN_CHANGED");
        return bytes;
      } finally { closeSync(fd); }
    }
    assertInvocationBindings();
    const result = await request("action.invocation.approve", { ...common, actionId: input.actionId,
      contentHash: input.contentHash, trustEpoch: session.activationId, effectContext }, signal);
    assertInvocationBindings();
    return { ok: result.decision === "approve", trusted: true, trustEpoch: result.trustEpoch,
      consented: result.decision === "approve", ...(result.decision === "deny" ? { reason: "EFFECT_CONSENT_DENIED" } : {}) };
  }
  const server = createServer(socket => {
    if (closed || sockets.size >= 8) { socket.destroy(); return; }
    sockets.add(socket);
    const cancelled = new AbortController();
    const signal = AbortSignal.any([cancelled.signal, lifetime.signal, host.signal, session.signal]);
    let bytes = Buffer.alloc(0), received = false;
    socket.setTimeout(125000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { cancelled.abort(); sockets.delete(socket); });
    socket.on("data", chunk => {
      const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      if (received || bytes.length + incoming.length > 65536) { socket.destroy(); return; }
      bytes = Buffer.concat([bytes, incoming]);
      const boundary = bytes.indexOf(10);
      if (boundary < 0) return;
      received = true;
      if (boundary !== bytes.length - 1) { socket.destroy(); return; }
      void Promise.resolve().then(() => handle(localRequest.parse(JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, boundary)))), signal)).then(result => {
          if (!closed && !socket.writableEnded) { current(); socket.end(JSON.stringify(result) + "\n"); }
        }, error => {
          const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
            ? error.code : "NATIVE_ACTION_HANDLER_FAILED";
          if (!socket.destroyed && !socket.writableEnded) socket.end(JSON.stringify({ ok: false, trusted: false, trustEpoch: session.activationId,
            reason: "HOST_AUTHORITY_UNAVAILABLE", error: code }) + "\n");
        }).catch(() => socket.destroy());
    });
  });
  function closeAdmission() {
    closed = true; lifetime.abort();
    for (const socket of sockets) {
      if (socket.destroyed || socket.writableEnded) { socket.destroy(); continue; }
      // The concrete bridge awaits a framed reply, not TCP end; discard pending consent promptly.
      socket.end(JSON.stringify({ ok: false, trusted: false, trustEpoch: session.activationId,
        reason: "HOST_AUTHORITY_UNAVAILABLE", error: "NATIVE_ACTION_PRODUCER_REVOKED" }) + "\n");
      socket.destroySoon();
    }
  }
  async function close() {
    if (closing) return closing;
    closeAdmission();
    host.signal.removeEventListener("abort", revoked); session.signal.removeEventListener("abort", revoked);
    closing = (async () => {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (filePin) await storage.withWorkspaceExclusive(() => {
        assertStorage(storage); storage.assertWorkspaceLease();
        controls(); unlinkSync(path); rmdirSync(directory); syncDirectory(root); filePin = undefined;
      });
    })().catch(error => { closing = undefined; throw error; });
    return closing;
  }
  const revoked = () => { void close().catch(() => { /* Changed controls are preserved for owner reconciliation. */ }); };
  server.on("error", revoked);
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.off("listening", ready); reject(error); };
      const ready = () => { server.off("error", failed); resolve(); };
      server.once("error", failed); server.once("listening", ready); server.listen(0, "127.0.0.1");
    });
    await storage.withWorkspaceExclusive(() => {
      owner();
      if (lstatSync(directory, { throwIfNoEntry: false })) fail("NATIVE_ACTION_OLD_ENDPOINT_RECONCILIATION_REQUIRED");
      mkdirSync(directory, { mode: 0o700 });
      const stat = lstatSync(directory);
      directoryIdentity = [stat.dev, stat.ino, stat.uid, stat.mode].join(":");
      const address = server.address();
      if (!address || typeof address === "string") fail("NATIVE_ACTION_ENDPOINT_UNAVAILABLE");
      const bytes = JSON.stringify({ schema: "pkm.action.host-authority/v1", host: "127.0.0.1", port: address.port,
        token, trust_epoch: session.activationId, store_path: root }) + "\n";
      const file = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(file, bytes); fsyncSync(file); } finally { closeSync(file); }
      filePin = pin(lstatSync(path)); contentSha256 = hash(bytes); syncDirectory(directory); syncDirectory(root);
      controls();
    });
    const locator = Object.freeze({ kind: "pkm.original-native-action-authority/v1" as const, root,
      workspaceId: signed.workspaceId, profileSha256: signed.profileSha256, epoch: session.activationId,
      capsuleSha256: custody.capsuleSha256, signal: lifetime.signal, assertCurrent: current, close });
    locators.set(locator, { storage, host, session, current });
    host.signal.addEventListener("abort", revoked, { once: true }); session.signal.addEventListener("abort", revoked, { once: true });
    const resource = { closeAdmission, release: close };
    storage.retainNativeCleanup(resource);
    current(); return locator;
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Native Action producer startup/cleanup failed."); }
    throw error;
  }
}
