import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { PEER_PROTOCOL, PeerDelivery, PeerPacket, parsePeerPacket } from "./peer-protocol";
import { parsePortalObservation, PortalObservation } from "./portal-observation";
import { PortalReview } from "./portal-runtime";
import { portalPersonaSnapshot, type PersonaSnapshot } from "../chat/persona-profiles";

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
  /** True when this side, as controller, starts a review automatically when the controlled side reports progress. */
  autoReview?(): boolean;
  connected(): boolean;
  send(target: string, packet: PeerPacket): void;
  approvePair(peerName: string): Promise<boolean>;
  /** Explicit local consent before roles flip; `role` is this side's role after the switch. */
  approveSwap(peerName: string, role: PeerBinding["role"]): Promise<boolean>;
  approveTask(peerName: string, prompt: string, profileSnapshot?: PersonaSnapshot): Promise<boolean>;
  execute(prompt: string, signal: AbortSignal, requestId: string, profileSnapshot?: PersonaSnapshot): Promise<unknown>;
  /** Set only when execute forwards the supplied snapshot to the actual attempt runner. */
  profileSnapshots?: boolean;
  files?(payload: Record<string, unknown>): Promise<void>;
  invalidated?(): void;
  changed(): void;
  reviewNeeded?(review: PortalReview): void;
  error(error: Error): void;
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
  readonly receipts = new Map<string, PeerReceipt>();
  readonly observations = new Map<string, PortalObservation>();
  private invitation?: { pairId: string; secret: string; expiresAt: number; role: PeerBinding["role"] };
  private pendingPair?: { pairId: string; peerId: string; expiresAt: number; role: PeerBinding["role"]; secret: string };
  private pendingSwap?: { requestId: string; expiresAt: number };
  private swapping = false;
  private pairing?: { expiresAt: number };
  private closed = false;
  private readonly active = new Map<string, AbortController>();
  private readonly processing = new Set<string>();
  private readonly outgoing = new Map<string, string>();
  private readonly reviewStates = new Map<string, string>();
  private readonly tasks = new Map<string, TaskRecord>();

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
    const binding = this.binding;
    if (this.closed || !binding) throw new Error("Switching control direction requires an approved peer connection.");
    if (this.swapPending || this.swapping) throw new Error("A control-direction switch is already pending.");
    if (this.processing.size || this.active.size) throw new Error("Finish or cancel the active remote task before switching control direction.");
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
    this.pendingPair = { pairId: match[1], peerId, expiresAt: Date.now() + 10 * 60_000, role, secret: match[2] };
    try { this.send(peerId, "pair", match[1], randomUUID(), { secret: match[2], role, ...this.localIdentity() }); }
    catch (error) { this.pendingPair = undefined; throw error; }
  }

  submit(prompt: string, requestId: string = randomUUID(), profileSnapshot?: PersonaSnapshot): string {
    const binding = this.requireRole("controller");
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

  cancel(requestId: string): void {
    const binding = this.requireRole("controller");
    this.send(binding.peerId, "cancel", binding.pairId, requestId, {});
  }

  observe(observation: PortalObservation): void {
    const binding = this.requireRole("controlled");
    if (!this.processing.has(observation.requestId)) throw new Error("Observation does not belong to an active Portal task.");
    this.send(binding.peerId, "observe", binding.pairId, observation.requestId, { observation });
  }

  sendFiles(payload: Record<string, unknown>): void {
    if (!this.binding || this.closed) throw new Error("Files require a live paired Portal.");
    if (!this.binding.peerCapabilities?.includes("files-v1")) throw new Error("The remote Host does not advertise approved file transfers. Upgrade both Hosts and pair again; no file bytes were sent.");
    this.send(this.binding.peerId, "files", this.binding.pairId, randomUUID(), payload);
  }

  revoke(): void {
    const binding = this.binding;
    this.clear();
    if (binding) this.send(binding.peerId, "revoke", binding.pairId, randomUUID(), {});
  }

  /** Closing loses this pairing; a fresh invitation and consent are required. */
  dispose(): void { this.closed = true; this.clear(); }

  async receive(delivery: PeerDelivery): Promise<void> {
    if (this.closed) return;
    try {
      const { packet, from, fromName } = delivery;
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
          if (invitation.role === "controlled" && !await this.options.approvePair(fromName)) return;
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
      if (packet.operation === "paired") {
        const pending = this.pendingPair;
        if (!pending || pending.expiresAt <= Date.now() || pending.peerId !== from || pending.pairId !== packet.pairId) {
          throw new Error("No matching peer pairing is pending.");
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
      if (packet.operation === "revoke") { this.clear(); return; }
      if (packet.operation === "files") {
        if (!this.options.files) throw new Error("This Host does not support Portal file transfers.");
        await this.options.files(packet.payload);
        return;
      }
      if (packet.operation === "observe") {
        this.requireRole("controller");
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
        const state = packet.payload.state;
        if (!this.outgoing.has(packet.requestId) || !receiptState(state)
          || packet.payload.error !== undefined && typeof packet.payload.error !== "string") throw new Error("Invalid or unsolicited peer receipt.");
        const prior = this.receipts.get(packet.requestId);
        if (prior && ["completed", "failed", "denied", "cancelled"].includes(prior.state)) return;
        this.receipts.set(packet.requestId, { requestId: packet.requestId, state,
          ...(packet.payload.result === undefined ? {} : { result: packet.payload.result }),
          ...(typeof packet.payload.error === "string" ? { error: packet.payload.error } : {}) });
        while (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value!);
        this.options.changed();
        if (state === "running") this.reviewStates.set(packet.requestId, "running");
        else this.requestReview(binding, packet.requestId, state);
        return;
      }
      this.requireRole("controlled");
      if (packet.operation === "cancel") { this.active.get(packet.requestId)?.abort(); return; }
      if (packet.operation === "task") {
        if (this.swapPending || this.swapping) {
          this.reply(binding, packet.requestId, { requestId: packet.requestId, state: "denied", error: "A control-direction switch is pending; no task was started." });
          return;
        }
        await this.run(binding, packet);
      }
    } catch (error) { this.options.error(error instanceof Error ? error : new Error(String(error))); }
  }

  private async run(binding: PeerBinding, packet: PeerPacket): Promise<void> {
    const prompt = packet.payload.prompt;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16_000) throw new Error("Invalid remote task prompt.");
    let profiles: PersonaSnapshot | undefined;
    try {
      profiles = portalPersonaSnapshot(packet.payload.profileSnapshot);
      if (profiles && !this.options.profileSnapshots) throw new Error("This Host is not wired to apply Profile snapshots; no task was executed.");
    } catch (error) {
      this.reply(binding, packet.requestId, { requestId: packet.requestId, state: "failed", error: error instanceof Error ? error.message : "Invalid Profile snapshot." });
      return;
    }
    const fingerprint = createHash("sha256").update(profiles ? JSON.stringify([prompt, profiles]) : prompt).digest("hex");
    const previous = this.tasks.get(packet.requestId);
    if (previous && previous.fingerprint !== fingerprint) throw new Error("Remote request ID was already used for different content.");
    if (this.processing.has(packet.requestId)) return;
    if (this.processing.size) throw new Error("This controlled peer already has an active task; no task was queued.");
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
        record = { fingerprint, receipt };
        if (this.binding !== binding || this.closed) return;
        this.tasks.set(packet.requestId, record);
        this.reply(binding, packet.requestId, receipt);
      };
      this.reply(binding, packet.requestId, record.receipt);
      if (!await this.options.approveTask(binding.peerName, prompt, profiles)) {
        publishReceipt({ requestId: packet.requestId, state: "denied" }); return;
      }
      if (controller.signal.aborted || this.binding !== binding || this.closed || !this.options.connected()) {
        publishReceipt({ requestId: packet.requestId, state: "cancelled" }); return;
      }
      publishReceipt({ requestId: packet.requestId, state: "running" });
      try {
        const result = await this.options.execute(prompt, controller.signal, packet.requestId, profiles);
        const encoded = JSON.stringify(result);
        const boundedResult = encoded && Buffer.byteLength(encoded, "utf8") > 36 * 1024
          ? { truncated: true, preview: Array.from(encoded).slice(0, 5000).join(""), message: "Result exceeded the peer frame budget; inspect the original remote Chat." } : result;
        publishReceipt({ requestId: packet.requestId, state: controller.signal.aborted ? "unknown" : "completed", result: boundedResult });
      } catch (error) {
        publishReceipt({ requestId: packet.requestId, state: controller.signal.aborted ? "unknown" : "failed",
          error: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000) });
      }
    } finally { this.processing.delete(packet.requestId); this.active.delete(packet.requestId); }
  }

  private async answerSwap(binding: PeerBinding, packet: PeerPacket): Promise<void> {
    const answer = (accepted: boolean, reason?: string): void => {
      if (this.binding === binding && !this.closed) this.send(binding.peerId, "swapped", binding.pairId, packet.requestId, { accepted, ...(reason ? { reason } : {}) });
    };
    if (this.swapping || this.swapPending) { answer(false, "a switch is already pending on both sides"); return; }
    if (this.processing.size || this.active.size) { answer(false, "a remote task is still active"); return; }
    const next = binding.role === "controller" ? "controlled" : "controller";
    const expiresAt = packet.payload.expiresAt;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) { answer(false, "switch expired"); return; }
    this.swapping = true;
    try {
      const allowed = await this.options.approveSwap(binding.peerName, next);
      if (this.binding !== binding || this.closed || !this.options.connected()) return;
      if (!allowed) { answer(false, "not allowed"); return; }
      if (expiresAt <= Date.now()) { answer(false, "switch expired"); return; }
      if (this.processing.size || this.active.size) { answer(false, "a remote task became active"); return; }
      // Reply before flipping: the transport is ordered, so the requester learns its new role before any new task arrives.
      answer(true);
      this.flip(binding);
    } finally { this.swapping = false; }
  }

  private flip(binding: PeerBinding): void {
    this.options.invalidated?.();
    this.binding = { ...binding, role: binding.role === "controller" ? "controlled" : "controller" };
    this.outgoing.clear();
    this.reviewStates.clear();
    this.options.changed();
  }

  private reply(binding: PeerBinding, requestId: string, receipt: PeerReceipt): void {
    this.receipts.set(requestId, receipt);
    while (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value!);
    this.options.changed();
    if (this.binding !== binding || this.closed) return;
    try { this.send(binding.peerId, "receipt", binding.pairId, requestId, { ...receipt }); }
    catch (error) { this.options.error(error instanceof Error ? error : new Error(String(error))); }
  }
  private requireRole(role: PeerBinding["role"]): PeerBinding {
    if (this.closed || this.binding?.role !== role) throw new Error(`This operation requires an approved ${role} peer connection.`);
    return this.binding;
  }
  private localIdentity(): Record<string, unknown> {
    return { capabilities: ["observations-v1", ...(this.options.profileSnapshots ? ["profiles-v1"] : []), ...(this.options.files ? ["files-v1"] : []), ...(this.options.autoReview ? ["review-mode-v1", ...(this.options.autoReview() ? ["auto-review-v1"] : [])] : [])], ...(this.options.chatId ? { chatId: this.options.chatId } : {}), ...(this.options.machine ? { machine: this.options.machine } : {}),
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
    this.options.send(target, { protocol: PEER_PROTOCOL, operation, pairId, requestId, payload });
  }
  private clear(): void {
    this.options.invalidated?.();
    this.binding = undefined; this.invitation = undefined; this.pendingPair = undefined; this.pairing = undefined; this.pendingSwap = undefined;
    this.outgoing.clear();
    this.tasks.clear(); this.receipts.clear(); this.observations.clear();
    this.reviewStates.clear();
    for (const controller of this.active.values()) controller.abort();
    this.options.changed();
  }

  private requestReview(binding: PeerBinding, requestId: string, state: PortalReview["state"]): void {
    const normalized = state === "awaiting-approval" ? "waiting-approval" : state;
    if (this.reviewStates.get(requestId) === normalized) return;
    this.reviewStates.set(requestId, normalized);
    this.options.reviewNeeded?.({ id: randomUUID(), pairId: binding.pairId, requestId, state });
  }
}
