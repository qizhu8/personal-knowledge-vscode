import { randomUUID } from "crypto";
import type * as vscode from "vscode";
import type { PeerBinding } from "./peer-session";
import { assertPeerEndpoint } from "./peer-protocol";
import { PORTAL_FILE_TRANSFER_OPERATION, PORTAL_PERMISSION_DIMENSIONS, type PortalPermission } from "./portal-permissions";

/**
 * Durable named Portal endpoints.
 *
 * Non-secret configuration lives in workspaceState (never globalState, so it is
 * never Settings-Synced); the per-endpoint channel secret lives only in
 * SecretStorage under its own key. Records returned to callers never contain a
 * secret. Keys are distinct from the legacy `pkm.portal.endpoints.v2` and
 * `pkm.portal.endpoint.secret.<id>` keys so legacy cleanup cannot touch them.
 */
export const PORTAL_ENDPOINT_STATE_KEY = "pkm.portal.namedEndpoints.v1";
export const PORTAL_ENDPOINT_SECRET_PREFIX = "pkm.portal.namedEndpoint.credential.v1.";
export const PORTAL_ENDPOINT_MAX = 32;
export const PORTAL_ENDPOINT_PERSISTENT_CAPABILITY = "persistent-v1";

export type PortalEndpointState = Pick<vscode.Memento, "get" | "update">;
export type PortalEndpointSecrets = Pick<vscode.SecretStorage, "get" | "store" | "delete">;

export interface PortalEndpointTransport {
  url: string;
  roomId: string;
  user: string;
  cid: string;
  host: boolean;
  port?: number;
}

export interface PortalEndpointRecord {
  id: string;
  name: string;
  root: string;
  localMachine: string;
  chatId?: string;
  chatName?: string;
  deleted: boolean;
  revision: number;
  acceptsIncoming: boolean;
  permissions: PortalPermission[];
  paired?: { binding: PeerBinding; transport: PortalEndpointTransport };
}

export interface PortalEndpointCreate {
  name: string;
  root: string;
  localMachine: string;
  chatId?: string;
  chatName?: string;
}

export type PortalEndpointChanges = Partial<Pick<PortalEndpointRecord, "name" | "chatId" | "chatName" | "deleted" | "acceptsIncoming" | "permissions">>;

interface StoredState {
  version: 1;
  endpoints: PortalEndpointRecord[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CAPABILITY = /^[a-z0-9][a-z0-9._:+-]{0,63}$/i;
const SECRET = /^[A-Za-z0-9_-]{16,256}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const RECORD_KEYS = new Set(["id", "name", "root", "localMachine", "chatId", "chatName", "deleted", "revision", "acceptsIncoming", "permissions", "paired"]);
const BINDING_KEYS = new Set(["pairId", "peerId", "peerName", "role", "peerChatId", "peerMachine", "peerChatName", "peerEndpoint", "peerCapabilities"]);
const TRANSPORT_KEYS = new Set(["url", "roomId", "user", "cid", "host", "port"]);
const CHANGE_KEYS = new Set(["name", "chatId", "chatName", "deleted", "acceptsIncoming", "permissions"]);

function plainObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`Invalid Portal endpoint ${what}.`);
  return value as Record<string, unknown>;
}
function onlyKeys(item: Record<string, unknown>, allowed: Set<string>, what: string): void {
  for (const key of Object.keys(item)) if (!allowed.has(key)) throw new Error(`Unknown Portal endpoint ${what} field: ${key}.`);
}
function text(value: unknown, what: string, max: number, min = 1): string {
  if (typeof value !== "string" || value.length < min || value.length > max || CONTROL.test(value) || value.trim() !== value) {
    throw new Error(`Invalid Portal endpoint ${what}.`);
  }
  return value;
}
function optionalText(item: Record<string, unknown>, key: string, what: string, max: number): string | undefined {
  return item[key] === undefined ? undefined : text(item[key], what, max);
}
function uuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`Invalid Portal endpoint ${what}.`);
  return value;
}
function endpointUrl(value: unknown, what: string): string {
  const url = text(value, what, 2048);
  try { assertPeerEndpoint(url); } catch (error) { throw new Error(`Invalid Portal endpoint ${what}: ${error instanceof Error ? error.message : String(error)}`); }
  return url;
}
function permissions(value: unknown): PortalPermission[] {
  if (!Array.isArray(value) || value.length > PORTAL_PERMISSION_DIMENSIONS.length) throw new Error("Invalid Portal endpoint permissions.");
  const seen = new Set<string>();
  for (const permission of value) {
    if (permission === PORTAL_FILE_TRANSFER_OPERATION) throw new Error("File transfer is not a grantable Portal endpoint permission; every batch needs explicit consent.");
    if (typeof permission !== "string" || !(PORTAL_PERMISSION_DIMENSIONS as readonly string[]).includes(permission) || seen.has(permission)) {
      throw new Error("Invalid Portal endpoint permissions.");
    }
    seen.add(permission);
  }
  return [...value] as PortalPermission[];
}
function binding(value: unknown): PeerBinding {
  const item = plainObject(value, "binding");
  onlyKeys(item, BINDING_KEYS, "binding");
  if (item.role !== "controller" && item.role !== "controlled") throw new Error("Invalid Portal endpoint binding role.");
  const caps = item.peerCapabilities;
  // Matches PeerSession advertisements such as "commands-v1", "platform:linux" and "program:pwsh".
  if (!Array.isArray(caps) || caps.length > 64 || !caps.every(cap => typeof cap === "string" && CAPABILITY.test(cap))) {
    throw new Error("Invalid Portal endpoint binding capabilities.");
  }
  if (!caps.includes(PORTAL_ENDPOINT_PERSISTENT_CAPABILITY)) throw new Error(`The paired Host does not advertise ${PORTAL_ENDPOINT_PERSISTENT_CAPABILITY}; durable Portal endpoints require it.`);
  const result: PeerBinding = {
    pairId: uuid(item.pairId, "binding pairId"),
    peerId: text(item.peerId, "binding peerId", 256),
    peerName: text(item.peerName, "binding peerName", 256),
    role: item.role,
    peerCapabilities: [...new Set(caps as string[])],
  };
  const chatId = optionalText(item, "peerChatId", "binding peerChatId", 256);
  const machine = optionalText(item, "peerMachine", "binding peerMachine", 256);
  const chatName = optionalText(item, "peerChatName", "binding peerChatName", 256);
  if (chatId !== undefined) result.peerChatId = chatId;
  if (machine !== undefined) result.peerMachine = machine;
  if (chatName !== undefined) result.peerChatName = chatName;
  if (item.peerEndpoint !== undefined) result.peerEndpoint = endpointUrl(item.peerEndpoint, "binding peerEndpoint");
  return result;
}
function transport(value: unknown): PortalEndpointTransport {
  const item = plainObject(value, "transport");
  onlyKeys(item, TRANSPORT_KEYS, "transport");
  if (typeof item.host !== "boolean") throw new Error("Invalid Portal endpoint transport host.");
  const result: PortalEndpointTransport = {
    url: endpointUrl(item.url, "transport url"),
    roomId: text(item.roomId, "transport roomId", 256),
    user: text(item.user, "transport user", 256),
    cid: text(item.cid, "transport cid", 64),
    host: item.host,
  };
  if (item.port !== undefined) {
    if (!Number.isInteger(item.port) || (item.port as number) < 1 || (item.port as number) > 65535) throw new Error("Invalid Portal endpoint transport port.");
    result.port = item.port as number;
  }
  return result;
}
function record(value: unknown): PortalEndpointRecord {
  const item = plainObject(value, "record");
  onlyKeys(item, RECORD_KEYS, "record");
  if (typeof item.deleted !== "boolean" || typeof item.acceptsIncoming !== "boolean") throw new Error("Invalid Portal endpoint flags.");
  if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1) throw new Error("Invalid Portal endpoint revision.");
  const result: PortalEndpointRecord = {
    id: uuid(item.id, "id"),
    name: text(item.name, "name", 128),
    root: text(item.root, "root", 4096),
    localMachine: text(item.localMachine, "localMachine", 256),
    deleted: item.deleted,
    revision: item.revision as number,
    acceptsIncoming: item.acceptsIncoming,
    permissions: permissions(item.permissions),
  };
  const chatId = optionalText(item, "chatId", "chatId", 256);
  const chatName = optionalText(item, "chatName", "chatName", 256);
  if (chatId !== undefined) result.chatId = chatId;
  if (chatName !== undefined) result.chatName = chatName;
  if (item.paired !== undefined) {
    const paired = plainObject(item.paired, "pairing");
    onlyKeys(paired, new Set(["binding", "transport"]), "pairing");
    result.paired = { binding: binding(paired.binding), transport: transport(paired.transport) };
  }
  if (result.deleted && (result.acceptsIncoming || result.permissions.length)) throw new Error("A deleted Portal endpoint cannot hold incoming access or permissions.");
  return result;
}
function copy<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
function parseState(value: unknown): PortalEndpointRecord[] {
  if (value === undefined) return [];
  const item = plainObject(value, "state");
  onlyKeys(item, new Set(["version", "endpoints"]), "state");
  if (item.version !== 1 || !Array.isArray(item.endpoints) || item.endpoints.length > PORTAL_ENDPOINT_MAX) throw new Error("Invalid stored Portal endpoint state.");
  const endpoints = item.endpoints.map(record);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const endpoint of endpoints) {
    if (ids.has(endpoint.id)) throw new Error("Duplicate stored Portal endpoint id.");
    ids.add(endpoint.id);
    if (!endpoint.deleted) {
      const key = endpoint.name.toLowerCase();
      if (names.has(key)) throw new Error("Duplicate stored Portal endpoint name.");
      names.add(key);
    }
  }
  return endpoints;
}
function assertSecret(value: unknown): string {
  if (typeof value !== "string" || !SECRET.test(value)) throw new Error("Invalid Portal endpoint channel secret: expected 16..256 base64url characters.");
  return value;
}

export class PortalEndpointStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly state: PortalEndpointState, private readonly secrets: PortalEndpointSecrets) {}

  /** Throws when stored state is malformed; there is no silent fallback to an empty list. */
  list(): PortalEndpointRecord[] {
    return copy(this.read());
  }

  get(id: string): PortalEndpointRecord | undefined {
    uuid(id, "id");
    const found = this.read().find(endpoint => endpoint.id === id);
    return found && copy(found);
  }

  async create(input: PortalEndpointCreate): Promise<PortalEndpointRecord> {
    const item = plainObject(input, "create input");
    onlyKeys(item, new Set(["name", "root", "localMachine", "chatId", "chatName"]), "create input");
    const created: PortalEndpointRecord = record({
      id: randomUUID(), name: item.name, root: item.root, localMachine: item.localMachine,
      ...(item.chatId !== undefined ? { chatId: item.chatId } : {}), ...(item.chatName !== undefined ? { chatName: item.chatName } : {}),
      deleted: false, revision: 1, acceptsIncoming: false, permissions: [],
    });
    return this.mutate(endpoints => {
      if (endpoints.length >= PORTAL_ENDPOINT_MAX) throw new Error(`At most ${PORTAL_ENDPOINT_MAX} Portal endpoints can be stored.`);
      this.assertUniqueName(endpoints, created.name, created.id);
      return { endpoints: [...endpoints, created], result: created };
    });
  }

  async update(id: string, changes: PortalEndpointChanges): Promise<PortalEndpointRecord> {
    uuid(id, "id");
    const item = plainObject(changes, "changes");
    onlyKeys(item, CHANGE_KEYS, "changes");
    return this.mutate(endpoints => {
      const index = this.indexOf(endpoints, id);
      const current = endpoints[index];
      const next: PortalEndpointRecord = copy(current);
      let bump = false;
      let identityChanged = false;
      if ("name" in item) next.name = text(item.name, "name", 128);
      if ("chatName" in item) {
        if (item.chatName === undefined) delete next.chatName; else next.chatName = text(item.chatName, "chatName", 256);
      }
      if ("chatId" in item) {
        if (item.chatId === undefined) delete next.chatId; else next.chatId = text(item.chatId, "chatId", 256);
        identityChanged ||= next.chatId !== current.chatId;
      }
      if ("deleted" in item) {
        if (typeof item.deleted !== "boolean") throw new Error("Invalid Portal endpoint deleted flag.");
        next.deleted = item.deleted;
        identityChanged ||= next.deleted !== current.deleted;
      }
      const grantChange = "acceptsIncoming" in item || "permissions" in item;
      if (identityChanged) {
        if (grantChange && (item.acceptsIncoming === true || (Array.isArray(item.permissions) && item.permissions.length))) {
          throw new Error("Changing a Portal endpoint's Chat or deletion state clears grants; grant access in a separate update.");
        }
        next.acceptsIncoming = false;
        next.permissions = [];
        bump = true;
      } else if (grantChange) {
        if ("acceptsIncoming" in item) {
          if (typeof item.acceptsIncoming !== "boolean") throw new Error("Invalid Portal endpoint acceptsIncoming flag.");
          next.acceptsIncoming = item.acceptsIncoming;
        }
        if ("permissions" in item) next.permissions = permissions(item.permissions);
        if (next.deleted && (next.acceptsIncoming || next.permissions.length)) throw new Error("A deleted Portal endpoint cannot accept incoming access or hold permissions.");
        bump = next.acceptsIncoming !== current.acceptsIncoming || JSON.stringify(next.permissions) !== JSON.stringify(current.permissions);
      }
      if (!next.deleted) this.assertUniqueName(endpoints, next.name, id);
      if (bump) next.revision = current.revision + 1;
      const validated = record(next);
      const updated = [...endpoints];
      updated[index] = validated;
      return { endpoints: updated, result: validated };
    });
  }

  /**
   * Binds a durable peer and stores its channel secret. Rebinding always resets
   * incoming access and permissions. When the state write fails the previous
   * secret is restored, so a failed pairing never publishes as success.
   */
  async pair(id: string, peer: PeerBinding, peerTransport: PortalEndpointTransport, secret: string): Promise<PortalEndpointRecord> {
    uuid(id, "id");
    const paired = { binding: binding(peer), transport: transport(peerTransport) };
    const channelSecret = assertSecret(secret);
    return this.mutate(async endpoints => {
      const index = this.indexOf(endpoints, id);
      const current = endpoints[index];
      if (current.deleted) throw new Error("Cannot pair a deleted Portal endpoint.");
      const next = record({ ...copy(current), paired, acceptsIncoming: false, permissions: [], revision: current.revision + 1 });
      const updated = [...endpoints];
      updated[index] = next;
      return { endpoints: updated, result: next, secret: channelSecret };
    });
  }

  /**
   * Refreshes public peer metadata of an existing durable pairing on reconnect.
   * Transport and secret are preserved; pairId and peerId must match. Unchanged
   * metadata is a no-op. A different remote Chat or role is an identity change:
   * incoming access and permissions are cleared and the revision increments.
   */
  async refreshPeer(id: string, peer: PeerBinding): Promise<PortalEndpointRecord> {
    uuid(id, "id");
    const refreshed = binding(peer);
    return this.mutate(endpoints => {
      const index = this.indexOf(endpoints, id);
      const current = endpoints[index];
      if (current.deleted || !current.paired) throw new Error("Only a paired, non-deleted Portal endpoint can refresh peer metadata.");
      const previous = current.paired.binding;
      if (previous.pairId !== refreshed.pairId || previous.peerId !== refreshed.peerId) throw new Error("Peer refresh does not match the saved pairing; pair again instead.");
      if (JSON.stringify(previous) === JSON.stringify(refreshed)) return { endpoints, result: current, skipWrite: true };
      const identityChanged = previous.peerChatId !== refreshed.peerChatId || previous.role !== refreshed.role;
      const next = record({
        ...copy(current), paired: { binding: refreshed, transport: copy(current.paired.transport) },
        ...(identityChanged ? { acceptsIncoming: false, permissions: [], revision: current.revision + 1 } : {}),
      });
      const updated = [...endpoints];
      updated[index] = next;
      return { endpoints: updated, result: next };
    });
  }

  /** Returns the channel secret for a paired endpoint, including a deleted one so it can reconnect to propagate deletion; never part of list()/get(). */
  async credential(id: string): Promise<string | undefined> {
    uuid(id, "id");
    await this.queue.catch(() => undefined);
    const endpoint = this.read().find(item => item.id === id);
    if (!endpoint?.paired) return undefined;
    const value = await this.secrets.get(this.secretKey(id));
    return value === undefined ? undefined : assertSecret(value);
  }

  async remove(id: string): Promise<void> {
    uuid(id, "id");
    return this.mutate(async endpoints => {
      const index = this.indexOf(endpoints, id);
      await this.secrets.delete(this.secretKey(id));
      return { endpoints: endpoints.filter((_, position) => position !== index), result: undefined };
    });
  }

  private secretKey(id: string): string {
    return `${PORTAL_ENDPOINT_SECRET_PREFIX}${id}`;
  }

  private read(): PortalEndpointRecord[] {
    return parseState(this.state.get<unknown>(PORTAL_ENDPOINT_STATE_KEY));
  }

  private indexOf(endpoints: PortalEndpointRecord[], id: string): number {
    const index = endpoints.findIndex(endpoint => endpoint.id === id);
    if (index < 0) throw new Error("Unknown Portal endpoint.");
    return index;
  }

  private assertUniqueName(endpoints: PortalEndpointRecord[], name: string, id: string): void {
    const key = name.toLowerCase();
    if (endpoints.some(endpoint => endpoint.id !== id && !endpoint.deleted && endpoint.name.toLowerCase() === key)) throw new Error("A Portal endpoint with this name already exists.");
  }

  private mutate<T>(change: (endpoints: PortalEndpointRecord[]) => { endpoints: PortalEndpointRecord[]; result: T; secret?: string; skipWrite?: boolean } | Promise<{ endpoints: PortalEndpointRecord[]; result: T; secret?: string; skipWrite?: boolean }>): Promise<T> {
    const run = async (): Promise<T> => {
      const { endpoints, result, secret, skipWrite } = await change(this.read());
      if (skipWrite) return copy(result);
      if (secret !== undefined) {
        const id = (result as unknown as PortalEndpointRecord).id;
        const key = this.secretKey(id);
        const previous = await this.secrets.get(key);
        await this.secrets.store(key, secret);
        try {
          await this.write(endpoints);
        } catch (error) {
          try {
            if (previous === undefined) await this.secrets.delete(key); else await this.secrets.store(key, previous);
          } catch { /* the original write failure is the actionable error */ }
          throw error;
        }
      } else {
        await this.write(endpoints);
      }
      return copy(result);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async write(endpoints: PortalEndpointRecord[]): Promise<void> {
    const stored: StoredState = { version: 1, endpoints: copy(endpoints) };
    parseState(stored);
    await this.state.update(PORTAL_ENDPOINT_STATE_KEY, stored);
  }
}
