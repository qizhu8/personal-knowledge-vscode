import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { hostname } from "node:os";
import { originalPortalInput, originalPortalPermissionGrant, type OriginalPortalInput } from "./original-mcp-portal-contracts.js";

type Json = Record<string, any>;
type Peer = {
  binding?: Json; peerEndpoint?: Json; endpointConfirmed: boolean;
  receipts: Map<string, Json>; observations: Map<string, Json>; incomingActivity?: Json;
  pendingInvitation?: Json; swapPending?: unknown;
  invite(): string; offer(): string; accept(id: string, code: string): void;
  submit(prompt: string, id: string): string; submitCommand(command: unknown, id: string): string;
  receive(delivery: unknown): Promise<void>; sendFiles(value: unknown): void | Promise<void>;
  inspectAttempts(id: string): Promise<unknown>; cancel(id: string): void; requestSwap(): void;
  revoke(): void; dispose(): void; publishEndpointState(): void;
  restore(binding: Json): void;
};
type Client = { isConnected: boolean; members: Json[]; participantId: string;
  connect(options: Json): void; disconnect(): void; sendPeer(target: string, packet: unknown): void };
type Files = { offer(paths: string[]): Promise<{ transferId: string; done: Promise<unknown> }>;
  handle(value: unknown): Promise<void>; dispose(): void };
type SocketServer = { clients: Set<{ terminate(): void }>; close(done: () => void): void;
  handleUpgrade(request: unknown, socket: unknown, head: unknown, accept: (socket: unknown) => void): void };
type Entry = { id: string; root: string; revision: number; external: boolean; saved: boolean;
  peer: Peer; client: Client; files: Files; url: string; channelId: string; secret: string;
  externalUntil: number; role: "controller" | "controlled"; transfers: Json[];
  permissions?: { grant(value: unknown): unknown; snapshot(): Json; invalidate(reason: string): void; allows(permission: string, resource?: string): boolean };
  sourceRevision?: number; members?: Set<string>; reconnectingAt?: number; closeTimer?: NodeJS.Timeout };
export interface OriginalPortalBusinessHost {
  root: string;
  assertCurrent(): void;
  consent(request: { phase: string; contextId: string; pairId: string; revision: number; detail: Json },
    signal?: AbortSignal): Promise<Json | null>;
  executeCommand(command: Json, signal: AbortSignal, requestId: string, contextId: string): Promise<unknown>;
  executeTask(input: { prompt: string; requestId: string; chatId: string; contextId: string;
    pairId: string;
    assertCurrent(): void; authorizeTool(name: string, arguments_: Json): Promise<void>;
    approveTransition(detail: Json): Promise<void> }, signal: AbortSignal): Promise<unknown>;
  taskAttempts(requestId: string, contextId: string): Promise<unknown>;
  destination(contextId: string): string;
  commandCapabilities: readonly string[];
  /** Supplied only by a current native saved-endpoint/SecretStorage producer, never public arguments. */
  savedEndpoints?(): Promise<readonly Json[]>;
}
const retained = () => {
  const loaded = createRequire(import.meta.url)("./legacy-chatroom-retained.cjs");
  return {
    PeerSession: loaded.PeerSession as new (options: Json) => Peer,
    ChatClient: loaded.ChatClient as new (events: Json) => Client,
    PortalFiles: loaded.PortalFiles as new (options: Json) => Files,
    PortalRelay: loaded.PortalRelay as new () => {
      setAuthorityGuard(check: () => void): void; create(id?: string, secret?: string): { channelId: string; secret: string };
      accept(socket: unknown, remote?: string): void; close(id: string): void; stop(): void;
    },
    WebSocketServer: loaded.WebSocketServer as new (options: Json) => SocketServer,
    createPortalLink: loaded.createPortalLink as (value: Json) => string,
    parsePortalLink: loaded.parsePortalLink as (value: string) => Json,
    selectPortalRoute: loaded.selectPortalRoute as (routes: Json[], requirements: unknown) => Json,
    endpointScope: loaded.endpointScope as (url: string) => string,
    PortalConnectionJournal: loaded.PortalConnectionJournal as new () => {
      observe(owner: Json, binding?: Json): void; snapshot(live: Map<string, Json>): Json;
    },
    PortalPermissions: loaded.PortalPermissions as new (options: Json) => NonNullable<Entry["permissions"]>,
    portalConnectionAccess: loaded.portalConnectionAccess as (id?: string, permissions?: Json) => Json,
  };
};

/** Host-neutral owner of the existing Original peer protocol; UI supplies decisions, not business state. */
export class OriginalPortalBusiness {
  private readonly components = retained();
  private readonly entries = new Map<string, Entry>();
  private readonly journal = new this.components.PortalConnectionJournal();
  private readonly lifetime = new AbortController();
  private readonly work = new Set<Promise<unknown>>();
  private server?: Server;
  private sockets?: SocketServer;
  private relay?: InstanceType<ReturnType<typeof retained>["PortalRelay"]>;
  private relayOpening?: Promise<void>;
  private address = "";
  private closed = false;
  private readonly sourceChecks = new Map<string, NodeJS.Timeout>();
  constructor(private readonly host: OriginalPortalBusinessHost) {
    if (!isAbsolute(host.root)) throw new Error("PORTAL_CURRENT_ROOT_REQUIRED");
    this.current();
  }
  private current(signal?: AbortSignal) {
    this.host.assertCurrent();
    if (this.closed || this.lifetime.signal.aborted || signal?.aborted) throw new Error("PORTAL_CANCELLED");
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.work.add(promise); void promise.finally(() => this.work.delete(promise)).catch(() => {}); return promise;
  }
  private async consent(phase: string, entry: Entry | undefined, detail: Json, signal?: AbortSignal) {
    this.current(signal);
    const revision = entry?.revision, binding = entry?.peer.binding;
    const decision = await this.host.consent({ phase, contextId: entry?.id ?? "", pairId: binding?.pairId ?? "",
      revision: revision ?? 0, detail: { ...detail, ...(entry?.saved ? { sourceRevision: entry.sourceRevision } : {}) } }, signal);
    this.current(signal);
    if (entry && (entry.root !== this.host.root || entry.revision !== revision || entry.peer.binding !== binding))
      throw new Error("PORTAL_CONTEXT_CHANGED_DURING_APPROVAL");
    if (decision?.decision !== "approve") throw new Error("PORTAL_LOCAL_CONSENT_REQUIRED");
    return decision;
  }
  private async startRelay(port = 0) {
    return this.relayOpening ??= (async () => {
      this.current();
      const relay = new this.components.PortalRelay();
      relay.setAuthorityGuard(() => this.current());
      const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
      const sockets = new this.components.WebSocketServer({ noServer: true, maxPayload: 53248 });
      server.on("upgrade", (request, socket, head) => {
        try { this.current(); }
        catch { socket.destroy(); return; }
        if (request.url !== "/pkm/portal") { socket.destroy(); return; }
        sockets.handleUpgrade(request, socket, head, ws => relay.accept(ws, "owned-loopback"));
      });
      this.server = server; this.sockets = sockets; this.relay = relay;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject); server.listen(port, "127.0.0.1", resolve);
      });
      this.current();
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("PORTAL_RELAY_UNAVAILABLE");
      this.address = `ws://127.0.0.1:${address.port}/pkm/portal`;
    })();
  }
  private createEntry(id: string, link: Json, role: Entry["role"], saved = false, configuration?: Json): Entry {
    this.current();
    if (this.entries.size >= 32 || this.entries.has(id)) throw new Error("PORTAL_CONNECTION_LIMIT");
    let entry!: Entry;
    const onStatus = (status: string) => {
      if (!entry) return;
      if (status === "connected") {
        entry.reconnectingAt = undefined; clearTimeout(entry.closeTimer); entry.closeTimer = undefined;
        if (entry.saved && entry.peer.binding) entry.peer.publishEndpointState();
      } else if (entry.peer.binding && !entry.reconnectingAt) {
        entry.reconnectingAt = Date.now();
        entry.closeTimer = setTimeout(() => this.end(entry), 120000); entry.closeTimer.unref();
      }
    };
    const client = new this.components.ChatClient({
      onStatus, onPeer: (delivery: unknown) => this.track(peer.receive(delivery)),
      onMessage() {}, onHistory() {}, onPresence(members: Json[]) {
        if (entry) entry.members = new Set(members.map(member => String(member.id)));
      }, onFileComplete() {},
    });
    const peer = new this.components.PeerSession({
      roomId: link.roomId, chatId: configuration?.chatId, machine: hostname(),
      chatName: configuration?.chatName ?? "External agent", endpoint: link.url,
      connected: () => client.isConnected,
      autoReview: () => false,
      send: (target: string, packet: unknown) => { this.current(); client.sendPeer(target, packet); },
      approvePair: () => this.consent("pair", entry, {}).then(() => true, () => false),
      approveSwap: (_name: string, direction: string) => this.consent("switch", entry, { direction }).then(() => true, () => false),
      approveTask: (_name: string, prompt: string) => this.consent("task", entry, { prompt }).then(() => true, () => false),
      execute: async (prompt: string, signal: AbortSignal, requestId: string) => {
        const decision = await this.consent("task", entry, { prompt, requestId }, signal);
        const chatId = decision.chatId;
        if (typeof chatId !== "string") throw new Error("PORTAL_EXISTING_LOCAL_CHAT_REQUIRED");
        const binding = entry.peer.binding, revision = entry.revision;
        const assertCurrent = () => {
          this.current();
          if (!this.entries.has(entry.id) || entry.peer.binding !== binding || entry.revision !== revision
            || !this.status(entry).connected) throw new Error("PORTAL_TASK_CONTEXT_CHANGED");
        };
        return this.host.executeTask({ prompt, requestId, chatId, contextId: entry.id, pairId: binding!.pairId, assertCurrent,
          approveTransition: detail => this.consent("task-transition", entry, detail, signal).then(() => {}),
          authorizeTool: async (name, args) => {
            assertCurrent();
            if (entry.saved) await this.consent("endpoint-check", entry, {});
            const dimensions: Record<string, string> = {
              read_file: "files-read", find_files: "files-read", search_text: "files-read", list_directory: "files-read",
              replace_text: "files-write", save_file: "files-write", run_process: "code-execute",
              run_process_background: "code-execute", process_cancel: "code-execute", process_get: "progress-read", process_output: "progress-read",
              pkm_search: "pkm-read", pkm_read: "pkm-read", get_document: "pkm-read", note_todo_read: "pkm-read",
              memory_read: "chat-read", list_chats: "chat-read", session_info: "progress-read",
              record_harness: "progress-read", report_work: "progress-read", find_actions: "pkm-read",
            };
            const permission = dimensions[name.replace(/^remote:/, "")];
            const path = args.path ?? args.filePath ?? args.directory;
            const resource = typeof path === "string" ? resolve(this.host.root, path) : undefined;
            const all = entry.permissions?.snapshot().grants.some((grant: Json) =>
              grant.mode === "all" && !Object.keys(grant.scopes).length);
            if (!(permission ? entry.permissions?.allows(permission, permission.startsWith("files-") ? resource : undefined) : all))
              throw new Error("PORTAL_TOOL_DIMENSION_DENIED");
            assertCurrent();
          },
        }, signal);
      },
      commandCapabilities: [...this.host.commandCapabilities],
      approveCommand: (_name: string, command: Json, requestId: string) =>
        this.consent("command", entry, { command, requestId }).then(() => true, () => false),
      executeCommand: (command: Json, signal: AbortSignal, requestId: string) => {
        this.current(signal); return this.host.executeCommand(command, signal, requestId, entry.id);
      },
      taskAttempts: async (requestId: string) => {
        await this.consent("attempts", entry, { requestId });
        return this.host.taskAttempts(requestId, entry.id);
      },
      files: (payload: unknown) => files.handle(payload),
      ...(configuration ? { persistent: {
        acceptsIncoming: () => configuration.acceptsIncoming === true && !configuration.deleted,
        localBinding: () => ({ endpointId: id, name: configuration.name ?? id, chatId: configuration.chatId,
          chatName: configuration.chatName, deleted: configuration.deleted, revision: configuration.revision }),
      } } : {}),
      invalidated: () => {
        if (entry) { entry.externalUntil = 0; entry.revision++; entry.permissions?.invalidate("role-change"); }
      },
      changed() {}, error() {},
    });
    const files = new this.components.PortalFiles({
      send: (payload: unknown) => peer.sendFiles(payload),
      approve: async (detail: Json) => { await this.consent("files", entry, detail); return true; },
      destination: () => this.host.destination(id),
      controlled: () => peer.binding?.role === "controlled" || saved,
      assertActive: () => {
        this.current(); if (!client.isConnected || !peer.binding) throw new Error("PORTAL_DISCONNECTED");
      },
      onStatus: (status: Json) => {
        if (entry) { entry.transfers.push(status); if (entry.transfers.length > 64) entry.transfers.shift(); }
      },
    });
    entry = { id, root: this.host.root, revision: configuration?.revision ?? 1, external: true, saved,
      peer, client, files, url: link.url, channelId: link.roomId, secret: link.secret, role, externalUntil: 0, transfers: [],
      ...(saved ? { sourceRevision: configuration?.revision } : {}) };
    this.entries.set(id, entry);
    client.connect({ url: link.url, room: "Portal", roomId: link.roomId, token: link.secret,
      user: "External agent", cid: configuration?.paired?.transport?.cid ?? id.replaceAll("-", "") });
    return entry;
  }
  private async connected(entry: Entry, signal?: AbortSignal) {
    const deadline = Date.now() + 10000;
    while (!entry.client.isConnected) {
      this.current(signal);
      if (Date.now() >= deadline) throw new Error("PORTAL_TRANSPORT_CONNECT_TIMEOUT");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  private async paired(entry: Entry, signal?: AbortSignal) {
    const deadline = Date.now() + 600000;
    while (!entry.peer.binding) {
      this.current(signal);
      if (!this.entries.has(entry.id) || Date.now() >= deadline) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  private status(entry: Entry): Json {
    const connected = entry.client.isConnected && !!entry.peer.binding && !!entry.members?.has(entry.peer.binding.peerId)
      && (!entry.saved || entry.peer.endpointConfirmed);
    return { contextId: entry.id, connected, state: entry.reconnectingAt ? "reconnecting" : connected ? "connected"
      : entry.peer.pendingInvitation ? "awaiting-peer" : "disconnected",
      endpoint: entry.url, endpointScope: this.components.endpointScope(entry.url),
      ...(entry.peer.pendingInvitation ? { pending: { ...entry.peer.pendingInvitation,
        linkAvailable: true, endpoint: entry.url, endpointScope: this.components.endpointScope(entry.url) } } : {}),
      ...(entry.reconnectingAt ? { reconnecting: { since: entry.reconnectingAt, deadline: entry.reconnectingAt + 120000 } } : {}),
      ...(entry.saved ? { persistentEndpoint: true } : {}),
      binding: entry.peer.binding, execution: entry.peer.incomingActivity, switchPending: !!entry.peer.swapPending,
      access: this.components.portalConnectionAccess(entry.peer.binding?.pairId, entry.permissions?.snapshot()),
      transfers: entry.transfers.slice(-64), receipts: [...entry.peer.receipts.values()].map(({ requestId, state, error }) => ({ requestId, state, error })),
      observations: [...entry.peer.observations.values()].slice(-64) };
  }
  async invoke(raw: OriginalPortalInput, signal?: AbortSignal): Promise<Json> {
    const input = originalPortalInput.parse(raw); this.current(signal);
    if (input.operation === "connections") {
      const live = new Map<string, Json>();
      for (const entry of this.entries.values()) {
        this.journal.observe({ chatId: entry.id, chatLabel: "External agent", external: entry.external,
          localMachine: hostname(), endpoint: entry.url }, entry.peer.binding);
        live.set(entry.id, { pairId: entry.peer.binding?.pairId, connected: this.status(entry).connected,
          access: this.components.portalConnectionAccess(entry.peer.binding?.pairId, entry.permissions?.snapshot()),
          ...(entry.reconnectingAt ? { reconnecting: { since: entry.reconnectingAt, deadline: entry.reconnectingAt + 120000 } } : {}) });
      }
      return { ...this.journal.snapshot(live),
        endpoints: (await this.host.savedEndpoints?.() ?? []).map(({ id, name, revision, deleted, acceptsIncoming, paired }) =>
          ({ id, name, revision, deleted, acceptsIncoming, pairingStored: !!paired })) };
    }
    let entry = this.entries.get(input.context_id);
    if (input.operation === "open") {
      if (!input.context_id) {
        const choice = await this.consent("open", undefined, {});
        const configuration = choice.endpoint;
        if (choice.role === "controller") {
          await this.startRelay();
          const channel = this.relay!.create();
          entry = this.createEntry(configuration?.id ?? randomUUID(),
            { url: this.address, roomId: channel.channelId, secret: channel.secret }, "controller", !!configuration, configuration);
          await this.connected(entry, signal);
          const code = entry.peer.offer();
          const link = this.components.createPortalLink({ url: entry.url, room: "Portal", roomId: entry.channelId,
            secret: entry.secret, code, controller: entry.client.participantId, role: "controller" });
          await this.consent("pair-code", entry, { privateLink: link }, signal);
        } else if (choice.role === "controlled" && typeof choice.privateLink === "string") {
          const link = this.components.parsePortalLink(choice.privateLink);
          entry = this.createEntry(configuration?.id ?? randomUUID(), link, "controlled", !!configuration, configuration);
          await this.connected(entry, signal);
          entry.peer.accept(link.controller, link.code);
        } else throw new Error("PORTAL_PAIRING_ROLE_REQUIRED");
        await this.paired(entry, signal);
        if (configuration) {
          const saved = await this.consent("save-pair", entry, {
            binding: entry.peer.binding, credential: entry.secret,
            transport: { url: entry.url, roomId: entry.channelId, user: "External agent",
              cid: entry.id.replaceAll("-", ""), host: choice.role === "controller",
              ...(choice.role === "controller" ? { port: Number(new URL(entry.url).port) } : {}) },
          }, signal);
          Object.assign(configuration, saved.endpoint);
          entry.revision = configuration.revision;
          entry.sourceRevision = configuration.revision;
          entry.peer.publishEndpointState();
        }
      } else if (!entry) {
        const decision = await this.consent("endpoint", undefined, { id: input.context_id, reconnect: true }, signal);
        const saved = decision.endpoint;
        if (!saved || saved.root !== this.host.root || saved.deleted) throw new Error("PORTAL_CURRENT_SAVED_ENDPOINT_REQUIRED");
        const transport = saved.paired.transport;
        if (transport.host) {
          const address = new URL(transport.url);
          if (address.hostname !== "127.0.0.1" || address.pathname !== "/pkm/portal")
            throw new Error("PORTAL_OWNED_RELAY_REQUIRED");
          await this.startRelay(transport.port);
          if (this.address !== transport.url) throw new Error("PORTAL_CURRENT_RELAY_SOURCE_CHANGED");
          this.relay!.create(transport.roomId, decision.credential);
        }
        entry = this.createEntry(saved.id, { url: transport.url, roomId: transport.roomId, secret: decision.credential },
          saved.paired.binding.role, true, saved);
        entry.peer.restore(saved.paired.binding);
        await this.connected(entry, signal); entry.peer.publishEndpointState();
      } else throw new Error("PORTAL_ALREADY_OPEN");
      await this.paired(entry, signal);
      if (entry.saved) {
        const deadline = Date.now() + 10000;
        while (!entry.peer.endpointConfirmed) {
          this.current(signal);
          if (Date.now() >= deadline) throw new Error("PORTAL_SAVED_ENDPOINT_CONFIRMATION_REQUIRED");
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        let checking = false;
        const timer = setInterval(() => {
          if (checking || !this.entries.has(entry!.id)) return;
          checking = true;
          this.track(this.consent("endpoint-check", entry, {}).catch(() => this.end(entry!))
            .finally(() => { checking = false; }));
        }, 500);
        timer.unref(); this.sourceChecks.set(entry.id, timer);
      }
      return this.status(entry);
    }
    if (input.operation === "route") {
      const route = this.components.selectPortalRoute([...this.entries.values()]
        .filter(value => !input.context_id || value.id === input.context_id)
        .map(value => ({ contextId: value.id, connected: this.status(value).connected, role: value.peer.binding?.role,
          capabilities: value.peer.binding?.peerCapabilities ?? [] })), input.requirements);
      entry = this.entries.get(route.contextId);
    }
    if (!entry || entry.root !== this.host.root) throw new Error("PORTAL_CURRENT_CONTEXT_REQUIRED");
    if (entry.externalUntil <= Date.now()) await this.consent("external", entry, { operation: input.operation }, signal);
    this.current(signal);
    if (input.operation === "status") return this.status(entry);
    if (input.operation === "disconnect") {
      this.end(entry);
      return { contextId: entry.id, connected: false, ...(entry.saved ? { pairingSaved: true } : {}) };
    }
    if (!this.status(entry).connected) throw new Error("PORTAL_DISCONNECTED");
    if (input.operation === "permissions") {
      const decision = await this.consent("permissions", entry, {}, signal);
      const grant = originalPortalPermissionGrant.parse(decision.grant);
      entry.permissions ??= new this.components.PortalPermissions({ chatId: entry.id, connectionId: entry.peer.binding!.pairId });
      entry.permissions.grant(grant); return this.status(entry);
    }
    if (input.operation === "files") {
      const paths = input.file_paths ?? (await this.consent("files", entry, { picker: true }, signal)).paths;
      if (!Array.isArray(paths) || paths.some(path => !isAbsolute(path))) throw new Error("PORTAL_ABSOLUTE_LOCAL_FILES_REQUIRED");
      const offered = await entry.files.offer(paths);
      this.track(offered.done);
      return { contextId: entry.id, transferId: offered.transferId,
        instruction: "Waiting for per-batch controlled-side permission. Offering is not delivery or installation." };
    }
    if (input.operation === "send") {
      const requestId = entry.peer.submit(input.prompt, input.request_id);
      return { contextId: entry.id, requestId, receipt: entry.peer.receipts.get(requestId), endpoint: entry.url };
    }
    if (input.operation === "command" || input.operation === "route") {
      const requestId = entry.peer.submitCommand(input.command, input.request_id);
      return { contextId: entry.id, requestId, execution: "direct-command", modelCalls: 0,
        machine: entry.peer.binding?.peerMachine, receipt: entry.peer.receipts.get(requestId),
        ...(input.operation === "route" ? { requirements: input.requirements } : {}) };
    }
    if (["get", "attempts", "cancel"].includes(input.operation)) {
      if (!entry.peer.receipts.has(input.request_id)) throw new Error("PORTAL_ORIGINAL_REQUEST_REQUIRED");
      if (input.operation === "cancel") entry.peer.cancel(input.request_id);
      const taskAttempts = input.operation === "attempts" ? await entry.peer.inspectAttempts(input.request_id) : undefined;
      return { contextId: entry.id, queriedRequestId: input.request_id, receipt: entry.peer.receipts.get(input.request_id),
        observation: entry.peer.observations.get(input.request_id), ...(taskAttempts === undefined ? {} : { taskAttempts }) };
    }
    if (input.operation === "switch") {
      await this.consent("switch", entry, {}, signal); entry.peer.requestSwap(); return this.status(entry);
    }
    throw new Error("PORTAL_OPERATION_REQUIRED");
  }
  private end(entry: Entry) {
    clearInterval(this.sourceChecks.get(entry.id)); this.sourceChecks.delete(entry.id);
    clearTimeout(entry.closeTimer);
    if (!entry.saved && !this.closed && !this.lifetime.signal.aborted && entry.client.isConnected) {
      try { entry.peer.revoke(); } catch {}
    }
    entry.peer.dispose(); entry.files.dispose();
    entry.permissions?.invalidate("disconnect");
    entry.client.disconnect(); this.entries.delete(entry.id); this.relay?.close(entry.channelId);
    entry.secret = ""; entry.externalUntil = 0; entry.revision++;
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.lifetime.abort();
    for (const entry of this.entries.values()) this.end(entry);
    this.relay?.stop();
    const sockets = this.sockets;
    if (sockets) {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
    }
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    await Promise.allSettled([...this.work]);
  }
}
