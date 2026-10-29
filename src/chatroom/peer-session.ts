import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { PEER_PROTOCOL, PeerDelivery, PeerPacket, parsePeerPacket, parsePortalEndpointIdentity, PortalEndpointIdentity } from "./peer-protocol";
export type { PortalEndpointIdentity } from "./peer-protocol";
import { parsePortalObservation, PortalObservation } from "./portal-observation";
import { PortalReview } from "./portal-runtime";
import { portalPersonaSnapshot, type PersonaSnapshot } from "../chat/persona-profiles";
import { parsePortalCommand, PortalCommand } from "./portal-command";

export interface PeerBinding {
  pairId: string;
  peerId: string;
  peerName: string;
  role: "controller" | "controlled";
  peerChatId?: string;
  peerMachine?: string;
  peerChatName?: string;
  peerEndpoint?: string;
  peerCapabilities?: string[];
}
export interface PeerReceipt {
  requestId: string;
  state: "awaiting-approval" | "running" | "completed" | "failed" | "denied" | "cancelled" | "unknown";
  result?: unknown;
  error?: string;
}
export interface PeerSessionOptions {
  roomId: string;
  chatId?: string;
  machine?: string;
  chatName?: string;
  endpoint?: string;
  persistent?: {
    acceptsIncoming(): boolean;
    /** Chat identity is the actual Chat ID, not the owning endpoint ID. Binding changes increase revision. */
    localBinding(): Omit<PortalEndpointIdentity, "acceptsIncoming">;
    /** Metadata only: the parent compares chatId/revision/deleted to invalidate durable grants. */
    changedPeer?(state: PortalEndpointIdentity): void;
  };
  /** True when this side, as controller, starts a review automatically when the controlled side reports progress. */
  autoReview?(): boolean;
  connected(): boolean;
  send(target: string, packet: PeerPacket): void;
  approvePair(peerName: string): Promise<boolean>;
  /** Explicit local consent before roles flip; `role` is this side's role after the switch. */
  approveSwap(peerName: string, role: PeerBinding["role"]): Promise<boolean>;
  approveTask(peerName: string, prompt: string, profileSnapshot?: PersonaSnapshot): Promise<boolean>;
  execute(prompt: string, signal: AbortSignal, requestId: string, profileSnapshot?: PersonaSnapshot): Promise<unknown>;
  commandCapabilities?: string[];
  approveCommand?(peerName: string, command: PortalCommand, requestId: string): Promise<boolean>;
  executeCommand?(command: PortalCommand, signal: AbortSignal, requestId: string): Promise<unknown>;
  /** Observes direct-command lifecycle on either side for a visible local trace; failures never affect the protocol. */
  commandActivity?(activity: { requestId: string; role: PeerBinding["role"]; peerName: string; command: PortalCommand; state: PeerReceipt["state"]; result?: unknown; error?: string }): void;
  taskAttempts?(requestId: string): Promise<unknown>;
  /** Set only when execute forwards the supplied snapshot to the actual attempt runner. */
  profileSnapshots?: boolean;
  files?(payload: Record<string, unknown>): Promise<void>;
  /** Runtime cancellation/permission-cache invalidation; transport disposal must not erase durable grants. */
  invalidated?(): void;
  changed(): void;
  reviewNeeded?(review: PortalReview): void;
  error(error: Error): void;
  log?(message: string): void;
}
interface TaskRecord {
  fingerprint: string;
  receipt: PeerReceipt;
}
function receiptState(value: unknown): value is PeerReceipt["state"] {
  return typeof value === "string" && ["awaiting-approval", "running", "completed", "failed", "denied", "cancelled", "unknown"].includes(value);
}

/** One approved two-party session on an existing Chat connection; never consumes chat history. */
export class PeerSession {
  binding?: PeerBinding;
  pairingFailure?: string;
  readonly receipts = new Map<string, PeerReceipt>();
  readonly observations = new Map<string, PortalObservation>();
  readonly incomingReceipts = new Map<string, PeerReceipt>();
  private endpointState?: PortalEndpointIdentity;
  private publishedEndpoint?: PortalEndpointIdentity;
  private sessionNonce = randomUUID();
  private peerNonce?: string;
  private peerConfirmed = false;
  private epoch = 0;
  private readonly incomingIds = new Set<string>();
  private readonly blockedOutgoing = new Set<string>();
  private readonly retiredNonces = new Set<string>();

  get peerEndpoint(): PortalEndpointIdentity | undefined { return this.endpointState && { ...this.endpointState }; }

  /** True only after both current session nonces and binding revisions were exchanged; always false for temporary Portals. */
  get endpointConfirmed(): boolean {
    if (this.closed || !this.duplex || !this.peerConfirmed || !this.peerNonce || !this.endpointState || !this.publishedEndpoint) return false;
    try { return this.sameBinding(this.localEndpoint(), this.publishedEndpoint); } catch { return false; }
  }

  private get duplex(): boolean { return !!this.options.persistent && !!this.binding?.peerCapabilities?.includes("persistent-v1"); }

  /** Trusted stored metadata only; the parent must authenticate the transport independently. */
  restore(binding: PeerBinding): void {
    if (this.closed || !this.options.persistent || !binding.peerCapabilities?.includes("persistent-v1")) throw new Error("Restore requires persistent-v1 on both endpoints.");
    if (!/^[a-f0-9-]{36}$/.test(binding.pairId) || typeof binding.peerId !== "string" || !binding.peerId || binding.peerId.length > 200
      || typeof binding.peerName !== "string" || !binding.peerName || binding.peerName.length > 200 || !["controller", "controlled"].includes(binding.role)) throw new Error("Invalid stored peer binding.");
    this.peerIdentity({ capabilities: binding.peerCapabilities, chatId: binding.peerChatId, machine: binding.peerMachine, chatName: binding.peerChatName, endpoint: binding.peerEndpoint });
    if (/[\x00-\x1f]/.test(binding.peerId + binding.peerName)) throw new Error("Invalid stored peer identity.");
    this.clear();
    this.binding = { ...binding, peerCapabilities: [...binding.peerCapabilities] };
    this.options.changed();
  }

  private localEndpoint(): PortalEndpointIdentity {
    const config = this.options.persistent!;
    return parsePortalEndpointIdentity({ ...config.localBinding(), acceptsIncoming: config.acceptsIncoming() });
  }

  private sameBinding(a: PortalEndpointIdentity, b: PortalEndpointIdentity): boolean {
    return a.endpointId === b.endpointId && a.chatId === b.chatId && a.deleted === b.deleted && a.revision === b.revision;
  }

  /** Call on each authenticated presence recovery. Repeated unchanged publications are harmless. */
  publishEndpointState(): void {
    const binding = this.binding;
    if (!binding || this.closed || !this.duplex) throw new Error("Endpoint state requires persistent-v1 on both endpoints.");
    const state = this.localEndpoint();
    const previous = this.publishedEndpoint;
    if (previous && !this.sameBinding(previous, state)) {
      if (previous.endpointId !== state.endpointId || state.revision <= previous.revision) throw new Error("Endpoint changes require an increasing binding revision and stable endpoint ID.");
      this.invalidateEndpoint();
    }
    this.publishedEndpoint = state;
    this.send(binding.peerId, "endpoint-state", binding.pairId, randomUUID(), { endpoint: state, nonce: this.sessionNonce, ...(this.peerNonce ? { echo: this.peerNonce } : {}) });
  }

  private invalidateEndpoint(): void {
    this.epoch++;
    this.peerConfirmed = false;
    for (const controller of this.active.values()) controller.abort();
    for (const [id, receipt] of this.incomingReceipts) if (["awaiting-approval", "running"].includes(receipt.state)) this.incomingReceipts.set(id, { requestId: id, state: "unknown", error: "Portal endpoint changed." });
    for (const [id, receipt] of this.receipts) {
      if (this.outgoing.has(id)) this.blockedOutgoing.add(id);
      if (this.outgoing.has(id) && ["awaiting-approval", "running", "unknown"].includes(receipt.state)) {
        const unknown: PeerReceipt = { requestId: id, state: "unknown", error: "Portal endpoint changed; execution outcome is unknown." };
        this.receipts.set(id, unknown);
        const command = this.commandRequests.get(id);
        if (command && this.binding) this.notifyCommand(this.binding, command, unknown);
      }
    }
    for (const pending of this.attemptsPending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Portal endpoint changed.")); }
    this.attemptsPending.clear();
    this.observations.clear(); this.reviewStates.clear();
    this.options.invalidated?.();
    this.options.changed();
  }

  private persistentContext(): Record<string, unknown> {
    if (!this.peerConfirmed || !this.peerNonce || !this.endpointState || !this.publishedEndpoint
      || !this.sameBinding(this.localEndpoint(), this.publishedEndpoint)) throw new Error("Peer endpoint state is not confirmed; publish endpoint state before sending tasks.");
    return { senderNonce: this.sessionNonce, targetNonce: this.peerNonce, senderRevision: this.publishedEndpoint.revision, targetRevision: this.endpointState.revision };
  }

  private validContext(payload: Record<string, unknown>): boolean {
    const context = payload.persistent;
    if (!context || typeof context !== "object" || Array.isArray(context)) return false;
    const item = context as Record<string, unknown>;
    return this.peerConfirmed && !!this.publishedEndpoint && !!this.endpointState
      && this.sameBinding(this.localEndpoint(), this.publishedEndpoint)
      && Object.keys(item).length === 4 && item.senderNonce === this.peerNonce && item.targetNonce === this.sessionNonce
      && item.senderRevision === this.endpointState.revision && item.targetRevision === this.publishedEndpoint.revision;
  }

  private prepareOutgoing(requestId: string): void {
    this.persistentContext();
    if (this.incomingIds.has(requestId) || this.blockedOutgoing.has(requestId)) throw new Error("Remote request ID collides with an incoming or invalidated request.");
  }

  private receiveEndpoint(payload: Record<string, unknown>): void {
    if (!this.duplex) throw new Error("This temporary Portal does not support persistent endpoint state.");
    const state = parsePortalEndpointIdentity(payload.endpoint);
    if (typeof payload.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(payload.nonce)
      || payload.echo !== undefined && (typeof payload.echo !== "string" || !/^[a-f0-9-]{36}$/.test(payload.echo))
      || Object.keys(payload).some(key => !["endpoint", "nonce", "echo"].includes(key))) throw new Error("Invalid Portal endpoint session.");
    if (this.retiredNonces.has(payload.nonce)) throw new Error("Stale Portal endpoint session.");
    if (this.peerNonce && this.peerNonce !== payload.nonce && payload.echo !== this.sessionNonce) {
      // Challenge a restarted transport before replacing confirmed peer metadata.
      this.publishEndpointState();
      return;
    }
    const previous = this.endpointState;
    if (previous && (previous.endpointId !== state.endpointId || state.revision < previous.revision
      || state.revision === previous.revision && !this.sameBinding(state, previous))) throw new Error("Stale or inconsistent Portal endpoint revision.");
    const newSession = this.peerNonce !== payload.nonce;
    if (newSession && this.peerNonce) {
      if (this.retiredNonces.size >= 1000) throw new Error("Portal session boundary reached; restore the connection.");
      this.retiredNonces.add(this.peerNonce);
    }
    const changed = !!previous && !this.sameBinding(previous, state);
    if (previous && (newSession || changed)) this.invalidateEndpoint();
    this.peerNonce = payload.nonce;
    this.endpointState = state;
    this.peerConfirmed = payload.echo === this.sessionNonce;
    const binding = this.binding!;
    binding.peerChatId = state.chatId; binding.peerChatName = state.chatName; binding.peerName = state.name;
    this.options.persistent!.changedPeer?.({ ...state });
    this.options.changed();
    // Acknowledge binding changes so the publisher can reconfirm its new revision.
    if (newSession || changed || payload.echo !== this.sessionNonce) this.publishEndpointState();
  }
  private invitation?: { pairId: string; secret: string; expiresAt: number; role: PeerBinding["role"] };
  private pendingPair?: { pairId: string; peerId: string; requestId: string; expiresAt: number; role: PeerBinding["role"]; secret: string };
  private pendingSwap?: { requestId: string; expiresAt: number };
  private swapping = false;
  private pairing?: { expiresAt: number };
  private closed = false;
  private readonly active = new Map<string, AbortController>();
  private readonly processing = new Set<string>();
  private readonly outgoing = new Map<string, string>();
  private readonly commandRequests = new Map<string, PortalCommand>();
  private readonly attemptsPending = new Map<string, { requestId: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private inspectingAttempts = false;
  private readonly reviewStates = new Map<string, string>();
  private readonly tasks = new Map<string, TaskRecord>();
  /** Last transport send time per receipt; 0 means it was never handed to the transport. */
  private readonly receiptSentAt = new Map<string, number>();

  constructor(private readonly options: PeerSessionOptions) {}

  /** Code holder becomes controlled; the peer that redeems it becomes controller (after local approval here). */
  invite(): string { return this.createInvitation("controlled"); }

  /** Code holder becomes controller; the peer that redeems it with accept() consented to be controlled. */
  offer(): string { return this.createInvitation("controller"); }

  pair(peerId: string, code: string): void { this.redeem(peerId, code, "controller"); }

  accept(peerId: string, code: string): void { this.redeem(peerId, code, "controlled"); }

  /** Local role and deadline of an unredeemed link; the secret itself is never exposed. */
  get pendingInvitation(): { role: PeerBinding["role"]; expiresAt: number } | undefined {
    const invitation = this.invitation;
    return invitation && !this.binding && !this.closed && invitation.expiresAt > Date.now() ? { role: invitation.role, expiresAt: invitation.expiresAt } : undefined;
  }

  /** Deadline of a redeemed link whose local pairing approval is still in progress. */
  get pairingInProgress(): { expiresAt: number } | undefined {
    const attempt = this.pairing;
    return attempt?.expiresAt && !this.binding && !this.closed && attempt.expiresAt > Date.now() ? { expiresAt: attempt.expiresAt } : undefined;
  }

  get swapPending(): boolean { return !!this.pendingSwap && this.pendingSwap.expiresAt > Date.now(); }

  /** Ask the peer to flip roles. The caller must already hold explicit local consent; the peer must grant its own. */
  requestSwap(): void {
    if (this.options.persistent) throw new Error("Persistent Portals are duplex; switching roles is disabled.");
    const binding = this.binding;
    if (this.closed || !binding) throw new Error("Switching control direction requires an approved peer connection.");
    if (this.swapPending || this.swapping) throw new Error("A control-direction switch is already pending.");
    if (this.processing.size || this.active.size || this.inspectingAttempts || this.attemptsPending.size) throw new Error("Finish or cancel the active remote task or result inspection before switching control direction.");
    const requestId = randomUUID();
    this.pendingSwap = { requestId, expiresAt: Date.now() + 2 * 60_000 };
    try { this.send(binding.peerId, "swap", binding.pairId, requestId, { expiresAt: this.pendingSwap.expiresAt }); }
    catch (error) { this.pendingSwap = undefined; throw error; }
    this.options.changed();
  }

  private createInvitation(role: PeerBinding["role"]): string {
    if (this.closed || this.binding || this.pairing) throw new Error("Disconnect the existing peer session before pairing.");
    const pairId = randomUUID(), secret = randomBytes(24).toString("hex");
    this.invitation = { pairId, secret, expiresAt: Date.now() + 10 * 60_000, role };
    return `pkmpeer:v1:${pairId}:${secret}`;
  }

  private redeem(peerId: string, code: string, role: PeerBinding["role"]): void {
    if (this.closed || this.binding || this.pendingPair || this.pairing) throw new Error("A peer session is already connected or pending.");
    const match = /^pkmpeer:v1:([a-f0-9-]{36}):([a-f0-9]{48})$/.exec(code.trim());
    if (!match || !peerId) throw new Error("Choose a peer and a valid PKM Portal Magic Code.");
    this.pairingFailure = undefined;
    const requestId = randomUUID();
    this.pendingPair = { pairId: match[1], peerId, requestId, expiresAt: Date.now() + 10 * 60_000, role, secret: match[2] };
    try { this.send(peerId, "pair", match[1], requestId, { secret: match[2], role, ...this.localIdentity() }); }
    catch (error) { this.pendingPair = undefined; throw error; }
  }

  submit(prompt: string, requestId: string = randomUUID(), profileSnapshot?: PersonaSnapshot): string {
    const binding = this.requireRole("controller");
    if (this.duplex) this.prepareOutgoing(requestId);
    const profiles = portalPersonaSnapshot(profileSnapshot);
    if (profiles && !binding.peerCapabilities?.includes("profiles-v1")) throw new Error("The controlled Host cannot apply Profile snapshots. No task was sent; upgrade or explicitly send without Profiles.");
    if (this.swapPending || this.swapping) throw new Error("A control-direction switch is pending; wait for the peer's answer.");
    if (!prompt.trim() || prompt.length > 16_000) throw new Error("A remote prompt from 1 to 16,000 characters is required.");
    if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error("Invalid remote request identity.");
    const fingerprint = createHash("sha256").update(profiles ? JSON.stringify([prompt, profiles]) : prompt).digest("hex");
    if (this.outgoing.has(requestId) && this.outgoing.get(requestId) !== fingerprint) throw new Error("Remote request ID was already used for different content.");
    if (!this.outgoing.has(requestId) && this.outgoing.size >= 100) throw new Error("This peer session reached its 100-request boundary; inspect receipts and pair again.");
    const payload = { prompt, ...(profiles ? { profileSnapshot: profiles } : {}) };
    parsePeerPacket({ protocol: PEER_PROTOCOL, operation: "task", pairId: binding.pairId, requestId, payload });
    this.outgoing.set(requestId, fingerprint);
    if (!this.receipts.has(requestId)) this.receipts.set(requestId, {
      requestId, state: "unknown", error: "Sent to transport; the target has not acknowledged execution or approval.",
    });
    this.send(binding.peerId, "task", binding.pairId, requestId, payload);
    this.options.changed();
    return requestId;
  }

  submitCommand(value: unknown, requestId: string = randomUUID()): string {
    const binding = this.requireRole("controller");
    if (this.duplex) this.prepareOutgoing(requestId);
    if (!binding.peerCapabilities?.includes("commands-v1")) throw new Error("The executing Host does not support direct commands; upgrade both Hosts and pair again. No model or command was invoked.");
    if (this.swapPending || this.swapping) throw new Error("A control-direction switch is pending.");
    const command = parsePortalCommand(value);
    if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error("Invalid remote request identity.");
    const fingerprint = createHash("sha256").update(JSON.stringify(["command", command])).digest("hex");
    if (this.outgoing.has(requestId) && this.outgoing.get(requestId) !== fingerprint) throw new Error("Remote request ID was already used for different content.");
    if (!this.outgoing.has(requestId) && this.outgoing.size >= 100) throw new Error("This peer session reached its 100-request boundary.");
    const payload = { command };
    parsePeerPacket({ protocol: PEER_PROTOCOL, operation: "command", pairId: binding.pairId, requestId, payload });
    this.outgoing.set(requestId, fingerprint);
    this.commandRequests.set(requestId, command);
    if (!this.receipts.has(requestId)) this.receipts.set(requestId, { requestId, state: "unknown", error: "Sent to transport; awaiting executing Host authorization." });
    this.send(binding.peerId, "command", binding.pairId, requestId, payload);
    this.notifyCommand(binding, command, this.receipts.get(requestId)!);
    this.options.changed();
    return requestId;
  }

  private notifyCommand(binding: PeerBinding, command: PortalCommand, receipt: PeerReceipt): void {
    try {
      this.options.commandActivity?.({ requestId: receipt.requestId, role: this.duplex ? this.outgoing.has(receipt.requestId) ? "controller" : "controlled" : binding.role, peerName: binding.peerName, command, state: receipt.state,
        ...(receipt.result === undefined ? {} : { result: receipt.result }), ...(receipt.error === undefined ? {} : { error: receipt.error }) });
    } catch (error) { this.options.log?.(`command activity trace failed: ${error instanceof Error ? error.message : String(error)}`); }
  }

  cancel(requestId: string): void {
    const binding = this.requireRole("controller");
    if (this.duplex && (!this.outgoing.has(requestId) || this.blockedOutgoing.has(requestId))) throw new Error("No matching outgoing task.");
    this.send(binding.peerId, "cancel", binding.pairId, requestId, {});
  }

  async inspectAttempts(requestId: string): Promise<unknown> {
    const binding = this.requireRole("controller");
    if (!this.outgoing.has(requestId) || this.commandRequests.has(requestId)) throw new Error("Choose an original model task from this Portal; direct commands have no model retries.");
    if (!binding.peerCapabilities?.includes("attempts-v1")) throw new Error("The executing Host cannot share task retry lineage. Upgrade both Hosts and pair again.");
    if (this.attemptsPending.size >= 8) throw new Error("Too many pending Portal attempt inspections.");
    const queryId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.attemptsPending.delete(queryId); reject(new Error("Portal attempt inspection timed out; no task was replayed.")); }, 120_000);
      this.attemptsPending.set(queryId, { requestId, resolve, reject, timer });
      try { this.send(binding.peerId, "attempts", binding.pairId, queryId, { taskRequestId: requestId }); }
      catch (error) {
        clearTimeout(timer); this.attemptsPending.delete(queryId); reject(error);
      }
    });
  }

  observe(observation: PortalObservation): void {
    const binding = this.requireRole("controlled");
    if (!this.processing.has(observation.requestId)) throw new Error("Observation does not belong to an active Portal task.");
    if (this.duplex && parsePortalObservation(observation).chatId !== this.localEndpoint().chatId) throw new Error("Observation belongs to a different local Chat.");
    this.send(binding.peerId, "observe", binding.pairId, observation.requestId, { observation });
  }

  sendFiles(payload: Record<string, unknown>): void {
    if (!this.binding || this.closed) throw new Error("Files require a live paired Portal.");
    if (!this.binding.peerCapabilities?.includes("files-v1")) throw new Error("The remote Host does not advertise approved file transfers. Upgrade both Hosts and pair again; no file bytes were sent.");
    this.send(this.binding.peerId, "files", this.binding.pairId, randomUUID(), payload);
  }

  revoke(): void {
    const binding = this.binding;
    if (binding) this.options.log?.(`peer session ${binding.pairId.slice(0, 8)} revoked locally`);
    this.clear();
    if (binding) this.send(binding.peerId, "revoke", binding.pairId, randomUUID(), {});
  }

  /** Closing loses this pairing; a fresh invitation and consent are required. */
  dispose(): void { this.closed = true; this.clear(); }

  async receive(delivery: PeerDelivery): Promise<void> {
    if (this.closed) return;
    const { packet, from, fromName } = delivery;
    try {
      parsePeerPacket(packet);
      if (packet.operation === "pair") {
        const invitation = this.invitation;
        const supplied = packet.payload.secret;
        if (!invitation || this.binding || this.pairing || invitation.expiresAt <= Date.now()
          || invitation.pairId !== packet.pairId || typeof supplied !== "string"
          || !/^[a-f0-9]{48}$/.test(supplied)
          || !timingSafeEqual(Buffer.from(invitation.secret), Buffer.from(supplied))) throw new Error("Peer invitation is invalid, expired or already used.");
        const peerRole = invitation.role === "controlled" ? "controller" : "controlled";
        // Legacy redeemers omit role and always ask to control; a mismatch must never grant control silently.
        if ((packet.payload.role ?? "controller") !== peerRole) {
          this.invitation = undefined;
          throw new Error("Peer invitation was redeemed with the wrong control direction.");
        }
        const attempt = { expiresAt: invitation.expiresAt };
        this.pairing = attempt;
        this.invitation = undefined;
        try {
          // Offering control needs no second prompt: the redeemer consented to be controlled before sending.
          if (invitation.role === "controlled" && !await this.options.approvePair(fromName)) throw new Error("Portal pairing was declined by the executing user. No task was sent.");
          if (this.closed || this.pairing !== attempt || invitation.expiresAt <= Date.now() || !this.options.connected()) return;
          const identity = this.peerIdentity(packet.payload);
          this.receipts.clear(); this.observations.clear(); this.outgoing.clear(); this.tasks.clear();
          this.binding = { pairId: packet.pairId, peerId: from, peerName: fromName, role: invitation.role, ...identity };
          try { this.send(from, "paired", packet.pairId, packet.requestId, { role: invitation.role, ...this.localIdentity() }); }
          catch (error) { this.binding = undefined; throw error; }
          this.options.changed();
        } finally { if (this.pairing === attempt) this.pairing = undefined; }
        return;
      }
      if (packet.operation === "paired" || packet.operation === "pair-rejected") {
        const pending = this.pendingPair;
        if (!pending || pending.expiresAt <= Date.now() || pending.peerId !== from || pending.pairId !== packet.pairId
          || pending.requestId !== packet.requestId) {
          throw new Error("No matching peer pairing is pending.");
        }
        if (packet.operation === "pair-rejected") {
          if (typeof packet.payload.error !== "string" || !packet.payload.error || packet.payload.error.length > 2000) throw new Error("Invalid Portal pairing rejection.");
          this.pendingPair = undefined;
          this.pairingFailure = packet.payload.error;
          this.options.changed();
          this.options.error(new Error(this.pairingFailure));
          return;
        }
        const expected = pending.role === "controller" ? "controlled" : "controller";
        this.pendingPair = undefined;
        if ((packet.payload.role ?? "controlled") !== expected) throw new Error("Peer confirmed the pairing with the wrong control direction.");
        const identity = this.peerIdentity(packet.payload);
        this.receipts.clear(); this.observations.clear(); this.outgoing.clear(); this.tasks.clear();
        this.binding = { pairId: packet.pairId, peerId: from, peerName: fromName, role: pending.role, ...identity };
        this.options.changed();
        return;
      }
      if (packet.operation === "resume" || packet.operation === "resumed") throw new Error("Portal connections are temporary; pair again with a fresh invitation.");
      const binding = this.binding;
      if (!binding || binding.peerId !== from || binding.pairId !== packet.pairId) throw new Error("Peer packet does not belong to this approved connection.");
      if (packet.operation === "revoke") { this.options.log?.(`peer session ${binding.pairId.slice(0, 8)} revoked by ${fromName}`); this.clear(); return; }
      if (packet.operation === "endpoint-state") { this.receiveEndpoint(packet.payload); return; }
      if (this.options.persistent && (packet.operation === "swap" || packet.operation === "swapped")) throw new Error("Persistent Portals do not switch roles.");
      if (this.duplex && !this.validContext(packet.payload)) {
        if (packet.operation === "task" || packet.operation === "command") {
          // A stale request is never executable later, even after the endpoint catches up.
          if (!this.incomingIds.has(packet.requestId) && this.incomingIds.size < 1000) this.incomingIds.add(packet.requestId);
          const receipt: PeerReceipt = { requestId: packet.requestId, state: "denied", error: "Stale or unconfirmed Portal endpoint state." };
          const context = packet.payload.persistent as Record<string, unknown> | undefined;
          // Echo the rejected generation, never turn an old packet into a receipt for a new session.
          const persistent = context && typeof context === "object" ? {
            senderNonce: context.targetNonce, targetNonce: context.senderNonce,
            senderRevision: context.targetRevision, targetRevision: context.senderRevision,
          } : {};
          this.options.send(binding.peerId, { protocol: PEER_PROTOCOL, operation: "receipt", pairId: binding.pairId, requestId: packet.requestId, payload: { ...receipt, persistent } });
        }
        this.options.error(new Error("Stale or unconfirmed Portal endpoint state."));
        return;
      }
      if (!this.duplex && packet.payload.persistent !== undefined) {
        if (packet.operation === "task" || packet.operation === "command") this.reply(binding, packet.requestId, { requestId: packet.requestId, state: "denied", error: "Persistent requests are unsupported by this temporary Portal." });
        throw new Error("Persistent operations are unsupported by this temporary Portal.");
      }
      if (packet.operation === "attempts") {
        this.requireRole("controlled");
        const epoch = this.epoch;
        const requestId = packet.payload.taskRequestId;
        if (this.inspectingAttempts) {
          this.send(binding.peerId, "attempts-result", binding.pairId, packet.requestId, { error: "Another task attempt inspection is awaiting local approval." });
          return;
        }
        this.inspectingAttempts = true;
        try {
          if (typeof requestId !== "string" || !this.tasks.has(requestId) || !this.options.taskAttempts) throw new Error("No matching original Portal task is available for inspection.");
          const attempts = await this.options.taskAttempts(requestId);
          if (this.binding !== binding || this.closed || this.duplex && epoch !== this.epoch) return;
          if (!attempts) throw new Error("Task attempt lineage is unavailable; the original receipt is unchanged.");
          if (Buffer.byteLength(JSON.stringify(attempts), "utf8") > 36 * 1024) throw new Error("Task retry lineage exceeds the Portal frame budget.");
          this.send(binding.peerId, "attempts-result", binding.pairId, packet.requestId, { attempts });
        } catch (error) {
          if (this.binding === binding && !this.closed) this.send(binding.peerId, "attempts-result", binding.pairId, packet.requestId, { error: error instanceof Error ? error.message : String(error) });
        } finally { this.inspectingAttempts = false; }
        return;
      }
      if (packet.operation === "attempts-result") {
        this.requireRole("controller");
        const pending = this.attemptsPending.get(packet.requestId);
        if (!pending) return;
        clearTimeout(pending.timer); this.attemptsPending.delete(packet.requestId);
        if (typeof packet.payload.error === "string") pending.reject(new Error(packet.payload.error));
        else if (!packet.payload.attempts || typeof packet.payload.attempts !== "object"
          || !("requestId" in packet.payload.attempts) || packet.payload.attempts.requestId !== pending.requestId) pending.reject(new Error("Portal retry results do not match the queried original request."));
        else pending.resolve(packet.payload.attempts);
        return;
      }
      if (packet.operation === "files") {
        if (!this.options.files) throw new Error("This Host does not support Portal file transfers.");
        await this.options.files(packet.payload);
        return;
      }
      if (packet.operation === "observe") {
        this.requireRole("controller");
        if (this.duplex && this.blockedOutgoing.has(packet.requestId)) throw new Error("Observation belongs to an invalidated task.");
        const observation = parsePortalObservation(packet.payload.observation);
        if (observation.requestId !== packet.requestId || !this.outgoing.has(packet.requestId)
          || !binding.peerChatId || observation.chatId !== binding.peerChatId) throw new Error("Observation belongs to a different Portal Chat/task.");
        const previous = this.observations.get(packet.requestId);
        if (previous && previous.sequence >= observation.sequence) return;
        if (["completed", "failed", "denied", "cancelled"].includes(this.receipts.get(packet.requestId)?.state || "")) return;
        this.observations.set(packet.requestId, { ...observation, receivedAt: Date.now() });
        while (this.observations.size > 100) this.observations.delete(this.observations.keys().next().value!);
        this.options.changed();
        if (observation.state === "running") this.reviewStates.set(packet.requestId, "running");
        else if (observation.state === "waiting-approval" || observation.state === "waiting-input" || observation.state === "restricted") this.requestReview(binding, packet.requestId, observation.state);
        return;
      }
      if (packet.operation === "swap") { await this.answerSwap(binding, packet); return; }
      if (packet.operation === "swapped") {
        const pending = this.pendingSwap;
        if (!pending || pending.requestId !== packet.requestId || typeof packet.payload.accepted !== "boolean") throw new Error("No matching control-direction switch is pending.");
        this.pendingSwap = undefined;
        if (pending.expiresAt <= Date.now()) {
          this.revoke();
          throw new Error("The control-direction switch expired. The Portal was revoked to avoid inconsistent roles; pair again.");
        }
        if (!packet.payload.accepted) {
          this.options.changed();
          throw new Error(`${binding.peerName} declined the control-direction switch${typeof packet.payload.reason === "string" ? `: ${packet.payload.reason.slice(0, 200)}` : ""}.`);
        }
        this.flip(binding);
        return;
      }
      if (packet.operation === "receipt") {
        this.requireRole("controller");
        if (this.duplex && this.blockedOutgoing.has(packet.requestId)) throw new Error("Receipt belongs to an invalidated or colliding task.");
        const state = packet.payload.state;
        if (!this.outgoing.has(packet.requestId) || !receiptState(state)
          || packet.payload.error !== undefined && typeof packet.payload.error !== "string") throw new Error("Invalid or unsolicited peer receipt.");
        const prior = this.receipts.get(packet.requestId);
        if (prior && ["completed", "failed", "denied", "cancelled"].includes(prior.state)) return;
        this.receipts.set(packet.requestId, { requestId: packet.requestId, state,
          ...(packet.payload.result === undefined ? {} : { result: packet.payload.result }),
          ...(typeof packet.payload.error === "string" ? { error: packet.payload.error } : {}) });
        while (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value!);
        const sentCommand = this.commandRequests.get(packet.requestId);
        if (sentCommand) this.notifyCommand(binding, sentCommand, this.receipts.get(packet.requestId)!);
        this.options.changed();
        if (state === "running") this.reviewStates.set(packet.requestId, "running");
        else if (!this.commandRequests.has(packet.requestId)) this.requestReview(binding, packet.requestId, state);
        return;
      }
      this.requireRole("controlled");
      if (packet.operation === "cancel") { this.active.get(packet.requestId)?.abort(); return; }
      if (packet.operation === "task" || packet.operation === "command") {
        if (this.duplex) {
          if (this.outgoing.has(packet.requestId)) {
            this.blockedOutgoing.add(packet.requestId);
            this.receipts.set(packet.requestId, { requestId: packet.requestId, state: "unknown", error: "Request ID collision across directions." });
            this.reply(binding, packet.requestId, { requestId: packet.requestId, state: "denied", error: "Request ID collision across directions." });
            return;
          }
          if (this.incomingIds.has(packet.requestId)) {
            const prior = this.incomingReceipts.get(packet.requestId);
            if (prior) this.reply(binding, packet.requestId, prior);
            return;
          }
          if (this.incomingIds.size >= 1000) {
            this.reply(binding, packet.requestId, { requestId: packet.requestId, state: "denied", error: "Persistent Portal request boundary reached; restore the connection." });
            return;
          }
          this.incomingIds.add(packet.requestId);
          if (!this.options.persistent!.acceptsIncoming() || this.options.persistent!.localBinding().deleted) {
            this.reply(binding, packet.requestId, { requestId: packet.requestId, state: "denied", error: "Incoming Portal requests are disabled or the Chat was deleted." });
            return;
          }
        }
        if (this.swapPending || this.swapping) {
          this.reply(binding, packet.requestId, { requestId: packet.requestId, state: "denied", error: "A control-direction switch is pending; no task was started." });
          return;
        }
        await this.run(binding, packet);
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (packet.operation === "pair") {
        try { this.send(from, "pair-rejected", packet.pairId, packet.requestId, { error: failure.message.slice(0, 2000) }); }
        catch (sendError) { this.options.error(sendError instanceof Error ? sendError : new Error(String(sendError))); }
      }
      if (this.duplex && (packet.operation === "task" || packet.operation === "command") && this.binding?.peerId === from && this.binding.pairId === packet.pairId
        && !this.incomingReceipts.has(packet.requestId)) {
        this.reply(this.binding, packet.requestId, { requestId: packet.requestId, state: "denied", error: failure.message.slice(0, 2000) });
      }
      this.options.error(failure);
    }
  }

  private async run(binding: PeerBinding, packet: PeerPacket): Promise<void> {
    const epoch = this.epoch;
    const direct = packet.operation === "command";
    let command: PortalCommand | undefined;
    if (direct) {
      try {
        command = parsePortalCommand(packet.payload.command);
        if (!this.options.approveCommand || !this.options.executeCommand) throw new Error("This Host does not support direct commands.");
      } catch (error) {
        this.reply(binding, packet.requestId, { requestId: packet.requestId, state: "failed", error: error instanceof Error ? error.message : String(error) });
        return;
      }
    }
    const prompt = direct ? JSON.stringify(command) : packet.payload.prompt;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16_000) throw new Error("Invalid remote task prompt.");
    let profiles: PersonaSnapshot | undefined;
    try {
      profiles = portalPersonaSnapshot(packet.payload.profileSnapshot);
      if (profiles && !this.options.profileSnapshots) throw new Error("This Host is not wired to apply Profile snapshots; no task was executed.");
    } catch (error) {
      this.reply(binding, packet.requestId, { requestId: packet.requestId, state: "failed", error: error instanceof Error ? error.message : "Invalid Profile snapshot." });
      return;
    }
    const fingerprint = createHash("sha256").update(direct ? JSON.stringify(["command", command]) : profiles ? JSON.stringify([prompt, profiles]) : prompt).digest("hex");
    const previous = this.tasks.get(packet.requestId);
    if (previous && previous.fingerprint !== fingerprint) throw new Error("Remote request ID was already used for different content.");
    if (this.processing.has(packet.requestId)) return;
    if (this.processing.size) {
      this.reply(binding, packet.requestId, { requestId: packet.requestId, state: "denied", error: "This controlled peer already has an active task; no task was queued." });
      return;
    }
    this.processing.add(packet.requestId);
    const controller = new AbortController();
    this.active.set(packet.requestId, controller);
    try {
      let record: TaskRecord = { fingerprint, receipt: { requestId: packet.requestId, state: "awaiting-approval" } };
      if (previous) {
        this.reply(binding, packet.requestId, previous.receipt);
        return;
      }
      if (this.tasks.size >= 1000) throw new Error("This temporary Portal reached its 1,000-task limit; pair again before submitting more tasks.");
      this.tasks.set(packet.requestId, record);
      const publishReceipt = (receipt: PeerReceipt): void => {
        if (this.duplex && epoch !== this.epoch) return;
        record = { fingerprint, receipt };
        if (command) this.notifyCommand(binding, command, receipt);
        if (this.binding !== binding || this.closed) return;
        this.tasks.set(packet.requestId, record);
        this.reply(binding, packet.requestId, receipt);
      };
      this.reply(binding, packet.requestId, record.receipt);
      if (command) this.notifyCommand(binding, command, record.receipt);
      if (!(command ? await this.options.approveCommand!(binding.peerName, command, packet.requestId) : await this.options.approveTask(binding.peerName, prompt, profiles))) {
        publishReceipt({ requestId: packet.requestId, state: "denied" }); return;
      }
      if (controller.signal.aborted || this.binding !== binding || this.closed || !this.options.connected()
        || this.duplex && (epoch !== this.epoch || !this.validContext(packet.payload) || !this.options.persistent!.acceptsIncoming() || this.localEndpoint().deleted)) {
        publishReceipt({ requestId: packet.requestId, state: "cancelled" }); return;
      }
      publishReceipt({ requestId: packet.requestId, state: "running" });
      try {
        const result = command ? await this.options.executeCommand!(command, controller.signal, packet.requestId) : await this.options.execute(prompt, controller.signal, packet.requestId, profiles);
        const encoded = JSON.stringify(result);
        const boundedResult = encoded && Buffer.byteLength(encoded, "utf8") > 36 * 1024
          ? { truncated: true, preview: Array.from(encoded).slice(0, 5000).join(""), message: "Result exceeded the peer frame budget; inspect the original remote Chat." } : result;
        const commandState = command && result && typeof result === "object" && "state" in result ? result.state : undefined;
        const commandFailed = command && (commandState !== "complete" || !result || typeof result !== "object" || !("exitCode" in result) || result.exitCode !== 0);
        publishReceipt({ requestId: packet.requestId, state: commandState === "cancelled" ? "cancelled" : controller.signal.aborted || commandState === "unknown" ? "unknown" : commandFailed ? "failed" : "completed", result: boundedResult });
      } catch (error) {
        publishReceipt({ requestId: packet.requestId, state: controller.signal.aborted ? "unknown" : "failed",
          error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000) });
      }
    } finally {
      if (this.active.get(packet.requestId) === controller) { this.processing.delete(packet.requestId); this.active.delete(packet.requestId); }
    }
  }

  private async answerSwap(binding: PeerBinding, packet: PeerPacket): Promise<void> {
    const answer = (accepted: boolean, reason?: string): void => {
      if (this.binding === binding && !this.closed) this.send(binding.peerId, "swapped", binding.pairId, packet.requestId, { accepted, ...(reason ? { reason } : {}) });
    };
    if (this.swapping || this.swapPending) { answer(false, "a switch is already pending on both sides"); return; }
    if (this.processing.size || this.active.size || this.inspectingAttempts || this.attemptsPending.size) { answer(false, "a remote task or result inspection is still active"); return; }
    const next = binding.role === "controller" ? "controlled" : "controller";
    const expiresAt = packet.payload.expiresAt;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) { answer(false, "switch expired"); return; }
    this.swapping = true;
    try {
      const allowed = await this.options.approveSwap(binding.peerName, next);
      if (this.binding !== binding || this.closed || !this.options.connected()) return;
      if (!allowed) { answer(false, "not allowed"); return; }
      if (expiresAt <= Date.now()) { answer(false, "switch expired"); return; }
      if (this.processing.size || this.active.size || this.inspectingAttempts || this.attemptsPending.size) { answer(false, "a remote task or result inspection became active"); return; }
      // Reply before flipping: the transport is ordered, so the requester learns its new role before any new task arrives.
      answer(true);
      this.flip(binding);
    } finally { this.swapping = false; }
  }

  private flip(binding: PeerBinding): void {
    this.options.invalidated?.();
    this.binding = { ...binding, role: binding.role === "controller" ? "controlled" : "controller" };
    this.outgoing.clear();
    this.commandRequests.clear();
    this.reviewStates.clear();
    this.options.changed();
  }

  private reply(binding: PeerBinding, requestId: string, receipt: PeerReceipt): void {
    if (this.duplex) {
      this.incomingReceipts.set(requestId, receipt);
      while (this.incomingReceipts.size > 1000) this.incomingReceipts.delete(this.incomingReceipts.keys().next().value!);
    }
    else this.receipts.set(requestId, receipt);
    while (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value!);
    this.options.changed();
    if (this.binding !== binding || this.closed) return;
    if (!this.options.connected()) {
      this.receiptSentAt.set(requestId, 0);
      this.options.log?.(`peer session ${binding.pairId.slice(0, 8)} receipt ${requestId.slice(0, 8)} ${receipt.state} held until the transport reconnects`);
      return;
    }
    try { this.send(binding.peerId, "receipt", binding.pairId, requestId, { ...receipt }); this.receiptSentAt.set(requestId, Date.now()); }
    catch (error) { this.receiptSentAt.set(requestId, 0); this.options.error(error instanceof Error ? error : new Error(String(error))); }
    while (this.receiptSentAt.size > 100) this.receiptSentAt.delete(this.receiptSentAt.keys().next().value!);
  }

  /**
   * After a transport reconnect, re-deliver receipts that were held or sent since `since` (they may have hit a
   * half-open socket). The controller ignores repeats once a task is terminal, so this never re-runs anything.
   */
  resync(since: number): number {
    const binding = this.binding;
    if (this.duplex) return 0;
    if (!binding || this.closed || binding.role !== "controlled") return 0;
    let sent = 0;
    for (const [requestId, at] of [...this.receiptSentAt].slice(-10)) {
      if (at !== 0 && at < since) continue;
      const receipt = this.tasks.get(requestId)?.receipt || this.receipts.get(requestId);
      if (!receipt) continue;
      try { this.send(binding.peerId, "receipt", binding.pairId, requestId, { ...receipt }); this.receiptSentAt.set(requestId, Date.now()); sent++; }
      catch (error) { this.options.log?.(`peer session ${binding.pairId.slice(0, 8)} resync stopped: ${error instanceof Error ? error.message : String(error)}`); break; }
    }
    if (sent) this.options.log?.(`peer session ${binding.pairId.slice(0, 8)} re-delivered ${sent} receipt(s) after reconnect`);
    return sent;
  }
  private requireRole(role: PeerBinding["role"]): PeerBinding {
    if (!this.closed && this.duplex && this.binding) return this.binding;
    if (this.closed || this.binding?.role !== role) throw new Error(`This operation requires an approved ${role} peer connection.`);
    return this.binding;
  }
  private localIdentity(): Record<string, unknown> {
    return { capabilities: ["observations-v1", ...(this.options.persistent ? ["persistent-v1"] : []), ...(this.options.taskAttempts ? ["attempts-v1"] : []), ...(this.options.executeCommand && this.options.approveCommand ? ["commands-v1", ...(this.options.commandCapabilities || [])] : []), ...(this.options.profileSnapshots ? ["profiles-v1"] : []), ...(this.options.files ? ["files-v1"] : []), ...(this.options.autoReview ? ["review-mode-v1", ...(this.options.autoReview() ? ["auto-review-v1"] : [])] : [])], ...(this.options.chatId ? { chatId: this.options.chatId } : {}), ...(this.options.machine ? { machine: this.options.machine } : {}),
      ...(this.options.chatName ? { chatName: this.options.chatName.slice(0, 200) } : {}), ...(this.options.endpoint ? { endpoint: this.options.endpoint } : {}) };
  }
  private peerIdentity(payload: Record<string, unknown>): Pick<PeerBinding, "peerChatId" | "peerMachine" | "peerChatName" | "peerEndpoint" | "peerCapabilities"> {
    if (payload.capabilities !== undefined && (!Array.isArray(payload.capabilities) || payload.capabilities.length > 16 || payload.capabilities.some(value => typeof value !== "string" || value.length > 64))) throw new Error("Invalid peer capabilities.");
    if (payload.chatId !== undefined && (typeof payload.chatId !== "string" || !/^[a-f0-9-]{36}$/.test(payload.chatId))) throw new Error("Invalid peer Chat identity.");
    if (payload.machine !== undefined && (typeof payload.machine !== "string" || payload.machine.length > 255 || /[\x00-\x1f]/.test(payload.machine))) throw new Error("Invalid peer machine identity.");
    for (const field of ["chatName", "endpoint"]) if (payload[field] !== undefined && (typeof payload[field] !== "string" || String(payload[field]).length > (field === "chatName" ? 200 : 1024) || /[\x00-\x1f]/.test(String(payload[field])))) throw new Error("Invalid peer source identity.");
    return { ...(Array.isArray(payload.capabilities) ? { peerCapabilities: payload.capabilities.filter((value): value is string => typeof value === "string") } : {}), ...(typeof payload.chatId === "string" ? { peerChatId: payload.chatId } : {}), ...(typeof payload.machine === "string" ? { peerMachine: payload.machine } : {}),
      ...(typeof payload.chatName === "string" ? { peerChatName: payload.chatName } : {}), ...(typeof payload.endpoint === "string" ? { peerEndpoint: payload.endpoint } : {}) };
  }
  private send(target: string, operation: PeerPacket["operation"], pairId: string, requestId: string, payload: Record<string, unknown>): void {
    if (this.duplex && !["pair", "paired", "pair-rejected", "endpoint-state", "revoke"].includes(operation)) {
      // Denials acknowledge packets without granting permission or requiring a completed handshake.
      const context = operation === "receipt" && payload.state === "denied"
        ? { senderNonce: this.sessionNonce, targetNonce: this.peerNonce, senderRevision: this.publishedEndpoint?.revision, targetRevision: this.endpointState?.revision }
        : this.persistentContext();
      payload = { ...payload, persistent: context };
    }
    this.options.send(target, { protocol: PEER_PROTOCOL, operation, pairId, requestId, payload });
  }
  private clear(): void {
    this.epoch++;
    this.sessionNonce = randomUUID(); this.peerNonce = undefined; this.peerConfirmed = false;
    this.endpointState = undefined; this.publishedEndpoint = undefined;
    this.incomingIds.clear(); this.blockedOutgoing.clear(); this.retiredNonces.clear(); this.incomingReceipts.clear();
    this.options.invalidated?.();
    this.binding = undefined; this.invitation = undefined; this.pendingPair = undefined; this.pairing = undefined; this.pendingSwap = undefined;
    this.outgoing.clear();
    this.commandRequests.clear();
    this.tasks.clear(); this.receipts.clear(); this.observations.clear();
    this.reviewStates.clear();
    for (const pending of this.attemptsPending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Portal disconnected before attempt inspection completed.")); }
    this.attemptsPending.clear();
    for (const controller of this.active.values()) controller.abort();
    if (this.options.persistent) { this.active.clear(); this.processing.clear(); this.receiptSentAt.clear(); }
    this.options.changed();
  }

  private requestReview(binding: PeerBinding, requestId: string, state: PortalReview["state"]): void {
    const normalized = state === "awaiting-approval" ? "waiting-approval" : state;
    if (this.reviewStates.get(requestId) === normalized) return;
    this.reviewStates.set(requestId, normalized);
    this.options.reviewNeeded?.({ id: randomUUID(), pairId: binding.pairId, requestId, state });
  }
}
