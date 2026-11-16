import { z } from "zod";
import { publicName } from "../../src/public-identity.js";
import { definitions as coreDefinitions } from "../../src/contracts.js";
import { documentLifecycleDefinitions } from "../../src/document-lifecycle-contracts.js";
import { folderLifecycleDefinitions } from "../../src/folder-lifecycle-contracts.js";
import { knowledgeMutationDefinitions } from "../../src/knowledge-mutations-contracts.js";
import { noteDefinitions } from "../../src/note-contracts.js";
import { resourceLifecycleDefinitions } from "../../src/resource-lifecycle-contracts.js";
import { researchDefinitions } from "../../src/research-contracts.js";
import { searchDefinitions } from "../../src/search-contracts.js";
import { skillDefinitions } from "../../src/skill-contracts.js";
import { trashLifecycleDefinitions } from "../../src/trash-lifecycle-contracts.js";

const publicDefinition = (operation: string) => {
  const definition = coreDefinitions.find(item => item.id === operation);
  if (!definition) throw new TypeError(`Canonical capability is not registered: ${operation}`);
  return definition;
};

const operations = {
  documentList: publicDefinition("knowledge.document.list"),
  documentGet: publicDefinition("knowledge.document.get"),
  noteList: noteDefinitions[0],
  noteGet: noteDefinitions[1],
  noteSearch: searchDefinitions[0],
  skillList: skillDefinitions[0],
  skillGet: skillDefinitions[1],
  skillSearch: searchDefinitions[1],
  researchList: researchDefinitions[0],
  researchSearch: searchDefinitions[2],
  noteCreate: knowledgeMutationDefinitions[0],
  noteUpdate: knowledgeMutationDefinitions[1],
  skillCreate: knowledgeMutationDefinitions[2],
  skillUpdate: knowledgeMutationDefinitions[3],
  researchCreate: knowledgeMutationDefinitions[4],
  researchUpdate: knowledgeMutationDefinitions[5],
  assetList: publicDefinition("knowledge.asset.list"),
  assetGet: publicDefinition("knowledge.asset.get"),
  assetPreview: resourceLifecycleDefinitions[0],
  documentMovePreview: documentLifecycleDefinitions[0],
  documentMove: documentLifecycleDefinitions[1],
  folderMovePreview: folderLifecycleDefinitions[0],
  folderMove: folderLifecycleDefinitions[1],
  trashPreview: trashLifecycleDefinitions[0],
  trashMove: trashLifecycleDefinitions[1],
  trashRestore: trashLifecycleDefinitions[2],
} as const;

export type KnowledgeLifecycleOperation = keyof typeof operations;
type Input<K extends KnowledgeLifecycleOperation> = z.input<(typeof operations)[K]["input"]>;
type Output<K extends KnowledgeLifecycleOperation> = z.output<(typeof operations)[K]["output"]>;
type DocumentListInput = {
  offset?: number; limit?: number; workspaceRevision?: string; includeDeleted?: boolean; area?: "notes" | "skills" | "papers";
};
type DocumentGetInput = { id: string };
type KnowledgeLifecycleState = {
  status: "disconnected" | "connecting" | "connected" | "error" | "disposed";
  code?: string;
  capabilities: KnowledgeLifecycleOperation[];
  workspaceId?: string;
};
type ServerBinding = {
  serverId: typeof publicName;
  workspaceId: string;
  actorId: string;
  protocolVersion: "v1";
};
export interface KnowledgeLifecycleHost {
  secrets: { get(key: string): Promise<string | undefined> };
  attestServer(origin: string, info: Readonly<Record<string, unknown>>): Promise<ServerBinding>;
  fetch?: typeof fetch;
  onState?(state: KnowledgeLifecycleState): void;
}

export class KnowledgeLifecycleClientError extends Error {
  constructor(readonly code: string, readonly effect: "not-committed" | "unknown" = "not-committed") {
    super(code);
    this.name = "KnowledgeLifecycleClientError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256;
const unavailableCodes = new Set(["NOT_FOUND", "NOT_AVAILABLE", "ACCESS_DENIED"]);

/**
 * Typed VS Code host bridge for the exact lifecycle capability set.
 * The bearer is kept only in a private field for this process session.
 */
export class KnowledgeLifecycleClient {
  readonly #host: KnowledgeLifecycleHost;
  readonly #origin: string;
  readonly #secretKey: string;
  readonly #expectedWorkspaceId: string;
  readonly #timeoutMs: number;
  #token = "";
  #status: KnowledgeLifecycleState["status"] = "disconnected";
  #code: string | undefined;
  #binding: ServerBinding | undefined;
  #available = new Set<KnowledgeLifecycleOperation>();
  #controllers = new Set<AbortController>();
  #generation = 0;
  #disposed = false;

  constructor(host: KnowledgeLifecycleHost, options: {
    origin: string; secretKey: string; expectedWorkspaceId: string; timeoutMs?: number;
  }) {
    const url = new URL(options.origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) throw new KnowledgeLifecycleClientError("UNSAFE_ORIGIN");
    if (!validId(options.secretKey) || !validId(options.expectedWorkspaceId))
      throw new KnowledgeLifecycleClientError("INVALID_HOST_CONFIGURATION");
    const timeoutMs = options.timeoutMs ?? 12_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
      throw new KnowledgeLifecycleClientError("INVALID_HOST_CONFIGURATION");
    this.#host = host;
    this.#origin = url.origin;
    this.#secretKey = options.secretKey;
    this.#expectedWorkspaceId = options.expectedWorkspaceId;
    this.#timeoutMs = timeoutMs;
  }

  state(): KnowledgeLifecycleState {
    return {
      status: this.#status,
      ...(this.#code ? { code: this.#code } : {}),
      capabilities: [...this.#available],
      ...(this.#binding ? { workspaceId: this.#binding.workspaceId } : {}),
    };
  }

  available<K extends KnowledgeLifecycleOperation>(key: K): boolean {
    return this.#available.has(key);
  }

  #emit(): void {
    try { this.#host.onState?.(this.state()); } catch { /* Observers cannot change transport outcomes. */ }
  }

  async connect(): Promise<KnowledgeLifecycleState> {
    if (this.#disposed) throw new KnowledgeLifecycleClientError("DISPOSED");
    this.disconnect();
    const generation = this.#generation;
    this.#status = "connecting";
    this.#emit();
    try {
      const token = await this.#host.secrets.get(this.#secretKey);
      if (generation !== this.#generation) throw new KnowledgeLifecycleClientError("REQUEST_ABORTED");
      if (!token || token.length < 32 || /[\r\n]/.test(token))
        throw new KnowledgeLifecycleClientError("AUTHENTICATION_REQUIRED");
      this.#token = token;
      const info = await this.#request("server_info", {}, false);
      if (info.name !== publicName || info.serverId !== publicName || !validId(info.workspaceId) ||
          !validId(info.actorId) || info.workspaceVersion !== "pkm.next-workspace/v2" ||
          info.protocolVersion !== "v1" || !isRecord(info.storage) ||
          info.storage.workspaceSchema !== "pkm.next-workspace/v2" || info.storage.authority !== "Markdown" ||
          !validId(info.catalogRevision)) throw new KnowledgeLifecycleClientError("INCOMPATIBLE_SERVER");
      const binding = await this.#host.attestServer(this.#origin, info);
      if (generation !== this.#generation) throw new KnowledgeLifecycleClientError("REQUEST_ABORTED");
      if (!binding || binding.serverId !== publicName || binding.workspaceId !== this.#expectedWorkspaceId ||
          binding.workspaceId !== info.workspaceId || binding.actorId !== info.actorId ||
          !validId(binding.actorId) || binding.protocolVersion !== "v1")
        throw new KnowledgeLifecycleClientError("WORKSPACE_BINDING_MISMATCH");
      this.#binding = { ...binding };
      for (const key of Object.keys(operations) as KnowledgeLifecycleOperation[]) {
        const definition = operations[key];
        try {
          const description = await this.#request("capabilities_describe", { operation: definition.id }, false);
          if (description.operation !== definition.id || description.version !== 1 ||
              description.readOnly !== definition.readOnly || description.catalogRevision !== info.catalogRevision)
            throw new KnowledgeLifecycleClientError("INCOMPATIBLE_CAPABILITY");
          this.#available.add(key);
        } catch (error) {
          if (!(error instanceof KnowledgeLifecycleClientError) || !unavailableCodes.has(error.code)) throw error;
        }
      }
      if (generation !== this.#generation) throw new KnowledgeLifecycleClientError("REQUEST_ABORTED");
      this.#status = "connected";
      this.#code = undefined;
      this.#emit();
      return this.state();
    } catch (error) {
      if (generation === this.#generation) {
        this.#token = "";
        this.#binding = undefined;
        this.#available.clear();
        this.#status = "error";
        this.#code = error instanceof KnowledgeLifecycleClientError ? error.code : "CONNECTION_FAILED";
        this.#emit();
      }
      throw error;
    }
  }

  disconnect(): void {
    if (this.#disposed) return;
    this.#generation++;
    this.#token = "";
    this.#available.clear();
    this.#binding = undefined;
    for (const controller of this.#controllers) controller.abort();
    this.#status = "disconnected";
    this.#code = undefined;
    this.#emit();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.disconnect();
    this.#disposed = true;
    this.#status = "disposed";
    this.#emit();
  }

  async #invoke<K extends KnowledgeLifecycleOperation>(
    key: K, input: Input<K>, signal?: AbortSignal,
  ): Promise<Output<K>> {
    if (this.#status !== "connected") throw new KnowledgeLifecycleClientError("NOT_CONNECTED");
    if (!this.#available.has(key)) throw new KnowledgeLifecycleClientError("CAPABILITY_UNAVAILABLE");
    const definition = operations[key];
    const parsed = definition.input.safeParse(input);
    if (!parsed.success) throw new KnowledgeLifecycleClientError("INVALID_ARGUMENT");
    const mutationId = definition.readOnly ? undefined
      : (parsed.data as { operationId: string }).operationId;
    const body = { operation: definition.id, version: 1, arguments: parsed.data };
    try {
      return await this.#request(
        definition.readOnly ? "capability_read" : "capability_call",
        body,
        !definition.readOnly,
        signal,
      ) as Output<K>;
    } catch (error) {
      this.#code = error instanceof KnowledgeLifecycleClientError ? error.code : "TRANSPORT_ERROR";
      this.#emit();
      if (mutationId && error instanceof KnowledgeLifecycleClientError && error.effect === "unknown") {
        throw new KnowledgeLifecycleClientError("PENDING_OUTCOME_UNKNOWN", "unknown");
      }
      throw error;
    }
  }

  async #request(
    method: "server_info" | "capabilities_describe" | "capability_read" | "capability_call",
    body: Record<string, unknown>,
    mutation: boolean,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.#token) throw new KnowledgeLifecycleClientError("NOT_CONNECTED");
    if (!["server_info", "capabilities_describe", "capability_read", "capability_call"].includes(method))
      throw new KnowledgeLifecycleClientError("INVALID_METHOD");
    const serialized = JSON.stringify(body);
    if (new TextEncoder().encode(serialized).length > 131_072)
      throw new KnowledgeLifecycleClientError("REQUEST_TOO_LARGE");
    const generation = this.#generation;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.#controllers.add(controller);
    const timer = setTimeout(abort, this.#timeoutMs);
    try {
      const response = await (this.#host.fetch ?? globalThis.fetch)(`${this.#origin}/v1/${method}`, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#token}` },
        body: serialized,
        signal: controller.signal,
      });
      if (!response.headers.get("content-type")?.startsWith("application/json"))
        throw new KnowledgeLifecycleClientError("INVALID_RESPONSE", mutation ? "unknown" : "not-committed");
      const raw = await response.text();
      if (raw.length > 1_048_576) throw new KnowledgeLifecycleClientError("RESPONSE_TOO_LARGE", mutation ? "unknown" : "not-committed");
      if (generation !== this.#generation || controller.signal.aborted)
        throw new KnowledgeLifecycleClientError("REQUEST_ABORTED", mutation ? "unknown" : "not-committed");
      const envelope: unknown = JSON.parse(raw);
      if (!isRecord(envelope) || envelope.schema !== "pkm.next-result/v1" || !validId(envelope.requestId) ||
          Boolean(envelope.result) === Boolean(envelope.error))
        throw new KnowledgeLifecycleClientError("INVALID_RESPONSE", mutation ? "unknown" : "not-committed");
      if (isRecord(envelope.error)) {
        const code = typeof envelope.error.code === "string" && /^[A-Z_]{1,64}$/.test(envelope.error.code)
          ? envelope.error.code : "SERVER_ERROR";
        const effect = envelope.error.effect === "not-committed" ? "not-committed" : mutation ? "unknown" : "not-committed";
        throw new KnowledgeLifecycleClientError(code, effect);
      }
      if (!response.ok || !isRecord(envelope.result))
        throw new KnowledgeLifecycleClientError("INVALID_RESPONSE", mutation ? "unknown" : "not-committed");
      return envelope.result;
    } catch (error) {
      if (error instanceof KnowledgeLifecycleClientError) throw error;
      throw new KnowledgeLifecycleClientError(controller.signal.aborted ? "REQUEST_ABORTED" : "TRANSPORT_ERROR",
        mutation ? "unknown" : "not-committed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.#controllers.delete(controller);
    }
  }

  documentList(input: DocumentListInput = {}, signal?: AbortSignal) { return this.#invoke("documentList", input, signal); }
  documentGet(input: DocumentGetInput, signal?: AbortSignal) { return this.#invoke("documentGet", input, signal); }
  noteList(input: Input<"noteList"> = {}, signal?: AbortSignal) { return this.#invoke("noteList", input, signal); }
  noteGet(input: Input<"noteGet">, signal?: AbortSignal) { return this.#invoke("noteGet", input, signal); }
  noteSearch(input: Input<"noteSearch">, signal?: AbortSignal) { return this.#invoke("noteSearch", input, signal); }
  skillList(input: Input<"skillList"> = {}, signal?: AbortSignal) { return this.#invoke("skillList", input, signal); }
  skillGet(input: Input<"skillGet">, signal?: AbortSignal) { return this.#invoke("skillGet", input, signal); }
  skillSearch(input: Input<"skillSearch">, signal?: AbortSignal) { return this.#invoke("skillSearch", input, signal); }
  researchList(input: Input<"researchList"> = {}, signal?: AbortSignal) { return this.#invoke("researchList", input, signal); }
  researchSearch(input: Input<"researchSearch">, signal?: AbortSignal) { return this.#invoke("researchSearch", input, signal); }
  noteCreate(input: Input<"noteCreate">, signal?: AbortSignal) { return this.#invoke("noteCreate", input, signal); }
  noteUpdate(input: Input<"noteUpdate">, signal?: AbortSignal) { return this.#invoke("noteUpdate", input, signal); }
  skillCreate(input: Input<"skillCreate">, signal?: AbortSignal) { return this.#invoke("skillCreate", input, signal); }
  skillUpdate(input: Input<"skillUpdate">, signal?: AbortSignal) { return this.#invoke("skillUpdate", input, signal); }
  researchCreate(input: Input<"researchCreate">, signal?: AbortSignal) { return this.#invoke("researchCreate", input, signal); }
  researchUpdate(input: Input<"researchUpdate">, signal?: AbortSignal) { return this.#invoke("researchUpdate", input, signal); }
  assetList(input: Input<"assetList">, signal?: AbortSignal) { return this.#invoke("assetList", input, signal); }
  assetGet(input: Input<"assetGet">, signal?: AbortSignal) { return this.#invoke("assetGet", input, signal); }
  assetPreview(input: Input<"assetPreview">, signal?: AbortSignal) { return this.#invoke("assetPreview", input, signal); }
  documentMovePreview(input: Input<"documentMovePreview">, signal?: AbortSignal) { return this.#invoke("documentMovePreview", input, signal); }
  documentMove(input: Input<"documentMove">, signal?: AbortSignal) { return this.#invoke("documentMove", input, signal); }
  folderMovePreview(input: Input<"folderMovePreview">, signal?: AbortSignal) { return this.#invoke("folderMovePreview", input, signal); }
  folderMove(input: Input<"folderMove">, signal?: AbortSignal) { return this.#invoke("folderMove", input, signal); }
  trashPreview(input: Input<"trashPreview">, signal?: AbortSignal) { return this.#invoke("trashPreview", input, signal); }
  trashMove(input: Input<"trashMove">, signal?: AbortSignal) { return this.#invoke("trashMove", input, signal); }
  trashRestore(input: Input<"trashRestore">, signal?: AbortSignal) { return this.#invoke("trashRestore", input, signal); }
}
