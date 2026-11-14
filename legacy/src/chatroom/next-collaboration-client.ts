import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ChatRoomCredentialStore, SecretStorageLike } from "./chat-room-credentials";
import type { RoomHostHub, RoomHostUi, RoomPortalAuthority } from "./room-host-owner";

type Value = Record<string, any>;
export class NextCollaborationClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private state: Value = {};
  private ui?: RoomHostUi;
  private selected?: () => void;
  private changed?: () => void;
  private deactivating?: (roomId: string, reason: string) => Promise<void> | void;
  private live = true;
  private closed?: Promise<void>;
  private advertised: Promise<unknown> = Promise.resolve();
  private readonly exited: Promise<void>;
  private readonly executions = new Set<AbortController>();
  private portalEpoch = 0;
  constructor(private readonly options: {
    entry: string; root: string; sourceRoot: string; workspaceId?: string; bootstrap: boolean; remoteUrl?: string;
    assertCurrent(): void; credentials: ChatRoomCredentialStore; profile: SecretStorageLike;
    authorize(binding: Value): boolean;
    strict?: boolean;
    project?(input: { projectId: string; threadId: string; roomId?: string; purpose?: "host" }): boolean;
    portal?: Pick<RoomPortalAuthority, "authorize" | "executeCommand">;
  }) {
    options.assertCurrent();
    this.child = fork(options.entry, [], { execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    this.child.stderr?.on("data", () => {});
    this.child.on("message", (input: Value) => {
      if (input?.type === "callback") { void this.callback(input); return; }
      if (input?.state) {
        this.state = input.state;
        this.changed?.();
      }
      if (input?.type !== "response") return;
      const call = this.pending.get(input.id);
      if (!call) return;
      clearTimeout(call.timer); this.pending.delete(input.id);
      input.error ? call.reject(new Error(input.error)) : call.resolve(input.result);
    });
    this.child.once("error", () => this.failed());
    this.exited = new Promise(resolve => this.child.once("exit", () => { this.failed(); resolve(); }));
  }
  private assert() {
    if (!this.live || !this.child.connected) throw new Error("Next Collaboration owner is unavailable; legacy fallback is not permitted.");
    this.options.assertCurrent(); this.selected?.();
  }
  private failed() {
    this.portalEpoch++;
    this.live = false;
    for (const controller of this.executions) controller.abort(new Error("Collaboration owner exited; inspect existing receipts before retry."));
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error("Next Collaboration owner exited.")); }
    this.pending.clear();
  }
  private async callback(input: Value) {
    let result: unknown, error: string | undefined;
    try {
      this.assert();
      const args = input.args;
      if (!Array.isArray(args)) throw new Error("Invalid Collaboration profile request.");
      if (input.operation.startsWith("credentials.")) {
        const operation = input.operation.slice(12);
        if (!["load", "verifyHost", "create", "replaceJoinSecret", "delete", "createHostProof", "verifyHostProof"].includes(operation)
          || !/^[A-Za-z0-9_-]{6,80}$/.test(args[0])) throw new Error("Invalid Room credential request.");
        result = await (this.options.credentials as any)[operation](...args);
      } else if (input.operation.startsWith("profile.")) {
        if (!/^personalKnowledge\.next\.privateRoomAdmission(?:Stage)?\.v1\.[a-f0-9-]{36}(?:\.[a-f0-9-]{36})?$/.test(args[0]))
          throw new Error("Invalid Collaboration profile admission key.");
        if (input.operation === "profile.get") result = await this.options.profile.get(args[0]);
        else if (input.operation === "profile.store" && typeof args[1] === "string")
          result = await this.options.profile.store(args[0], args[1]);
        else throw new Error("Unsupported Collaboration profile operation.");
      } else if (input.operation === "authorize") result = this.options.authorize(args[0]);
      else if (input.operation === "chooseReconnectPolicy") result = this.options.strict === undefined
        ? await this.ui?.chooseReconnectPolicy(args[0]) : this.options.strict ? "host-approval" : "legacy-client-id";
      else if (input.operation === "project.authorize") result = this.options.project?.(args[0]) ?? false;
      else if (input.operation === "portal.authorize") {
        if (args[0]?.root !== this.state.root && this.state.root !== undefined)
          throw new Error("Portal owner root changed.");
        result = await this.options.portal?.authorize({ ...args[0], root: this.options.sourceRoot }) ?? false;
      }
      else if (input.operation === "approveParticipant") result = await this.ui?.approveParticipant(args[0]) ?? false;
      else if (input.operation === "roomDeactivating") result = await this.deactivating?.(args[0], args[1]);
      else throw new Error("Unsupported Collaboration callback.");
      this.assert();
    } catch (failure) { error = failure instanceof Error ? failure.message : "Collaboration profile request denied."; }
    if (this.child.connected) this.child.send({ type: "callback-result", id: input.id, result, error });
  }
  private request(operation: string, args: unknown[] = [], draining = false): Promise<any> {
    if (!draining) this.assert();
    else if (!this.child.connected) return Promise.resolve();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Collaboration request timed out; do not replay uncertain mutations.")); }, 180_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ type: "request", id, operation, args }, error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }
  async start() {
    await this.request("initialize", [{ root: this.options.root, sourceRoot: this.options.sourceRoot,
      workspaceId: this.options.workspaceId, bootstrap: this.options.bootstrap, remoteUrl: this.options.remoteUrl,
      productCapabilities: !!this.options.portal && !!this.options.project }]);
    return this.status();
  }
  status() {
    return { pid: this.child.pid, live: this.live, root: this.state.root, workspaceId: this.state.workspaceId,
      roomIds: (this.state.rooms ?? []).map((room: Value) => room.roomId),
      sourceRoot: this.options.sourceRoot, storageRoute: "profile-selected-collaboration-workspace",
      sameRootAdoption: false, transport: "plaintext ws/HTTP" };
  }
  hub(ui: RoomHostUi, selected: () => void): RoomHostHub {
    this.ui = ui; this.selected = selected;
    const meetingStore = new Proxy({}, { get: (_target, property) => {
      if (property === "snapshot") return (roomId: string) => {
        this.assert();
        return structuredClone(this.state.meetings?.[roomId] ?? { current: null, history: [], trash: [] });
      };
      return (...args: unknown[]) => this.request(`meeting.${String(property)}`, args);
    } });
    const api: Value = {
      get meetingStore() { return meetingStore; },
      portalAuthority: this.options.portal && this.options.project ? {
        legacyContext: true,
        assertAuthority: () => this.assert(),
        authorize: (input: Value) => {
          if (input.root !== this.options.sourceRoot) throw new Error("Portal configured root changed.");
          return this.request("portal.authorize", [{ ...input, root: this.state.root }]);
        },
        executeCommand: async (input: Value) => {
          if (input.root !== this.options.sourceRoot || !this.options.portal?.executeCommand)
            throw new Error("Portal command owner is unavailable.");
          const { signal, ...value } = input;
          const epoch = this.portalEpoch;
          const admitted = await this.request("portal.consume", [{ ...value, root: this.state.root }]);
          this.assert();
          if (epoch !== this.portalEpoch) throw new Error("Portal stopped before command execution; inspect existing receipts before retry.");
          const controller = new AbortController(), abort = () => controller.abort(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          this.executions.add(controller);
          let checking = false;
          const timer = setInterval(() => {
            if (checking) return;
            checking = true;
            void this.request("portal.check", [admitted.epoch]).catch(error => controller.abort(error)).finally(() => { checking = false; });
          }, 250);
          timer.unref();
          try { return await this.options.portal.executeCommand({ ...input, signal: controller.signal } as any); }
          finally { clearInterval(timer); signal.removeEventListener("abort", abort); this.executions.delete(controller); }
        },
      } : undefined,
      remoteOwnerDirectory: !!this.options.remoteUrl,
      get isRunning() { return !!client.state.running; },
      get port() { return client.state.port ?? 0; },
      get publicHost() { return client.state.publicHost ?? "127.0.0.1"; },
      configureArchive() {},
      configurePersistence: (root: string) => {
        if (root !== `${this.options.sourceRoot}/chatrooms`) throw new Error("Configured Collaboration source changed.");
      },
      onApprovalsChanged: (callback: () => void) => { this.changed = callback; },
      onRoomDeactivating: (callback: typeof this.deactivating) => { this.deactivating = callback; },
      pendingApprovals: () => this.state.approvals ?? [],
      adminRooms: () => this.state.active ?? [],
      portalChannelsSnapshot: () => this.state.channels ?? [],
      createPortalChannel: (...args: unknown[]) => this.request("createPortalChannel", args),
      closePortalChannel: (...args: unknown[]) => { void this.request("closePortalChannel", args).catch(() => {}); },
      setAdvertisedHost: (host: string) => {
        this.advertised = this.request("setAdvertisedHost", [host]);
        void this.advertised.catch(() => {});
      },
      start: async (port: number) => { await this.advertised; return this.request("start", [port]); },
      stop: () => {
        this.portalEpoch++;
        for (const controller of this.executions) controller.abort(new Error("Collaboration Hub stopped."));
        return this.live ? this.request("stop", [], true) : Promise.resolve();
      },
    };
    const client = this;
    api.configureLifecycle = api.configurePersistence;
    return new Proxy(api, { get: (target, property) => {
      if (property === "then") return undefined;
      if (property === "stop") return target.stop;
      this.assert();
      if (property in target) return Reflect.get(target, property, target);
      return (...args: unknown[]) => this.request(String(property), args);
    } }) as RoomHostHub;
  }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closed = (async () => {
      this.portalEpoch++;
      for (const controller of this.executions) controller.abort(new Error("Collaboration owner closing."));
      if (this.child.connected) this.child.send({ type: "close" });
      const wait = (ms: number) => new Promise<false>(resolve => { const timer = setTimeout(() => resolve(false), ms); timer.unref(); });
      if (await Promise.race([this.exited.then(() => true), wait(15_000)])) return;
      this.child.kill("SIGTERM");
      if (await Promise.race([this.exited.then(() => true), wait(10_000)])) return;
      this.child.kill("SIGKILL");
      await this.exited;
    })();
    return this.closed;
  }
}
