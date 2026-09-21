import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { withCrossProcessLockSync } from "../cross-process-lock";
import { canonicalJson } from "../workflow-contracts";
import {
  ProjectModelError,
  ProjectModelState,
  ThreadMovePlan,
  createProject,
  createThread,
  initializeProjectModel,
  moveThread
} from "./project-model";

export const PROJECT_STORE_SCHEMA = 1;

export interface ProjectStoreCommand {
  commandId: string;
  fingerprint: string;
  expectedStoreVersion: number;
}

export interface ProjectSnapshot {
  schema: 1;
  storeVersion: number;
  rootId: string;
  projects: ProjectModelState["projects"];
  threads: ProjectModelState["threads"];
}

export interface ProjectStoreResult {
  snapshot: ProjectSnapshot;
  entityId: string;
  replayed: boolean;
}

interface ProjectReceipt {
  commandId: string;
  fingerprint: string;
  operation: string;
  storeVersion: number;
  entityId: string;
}

interface ProjectStorePayload {
  state: ProjectModelState;
  receipts: ProjectReceipt[];
}

interface ProjectStoreEnvelope {
  schema: 1;
  storeVersion: number;
  payload: ProjectStorePayload;
  digest: string;
}

export class ProjectStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export class ProjectStore {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(readonly directory: string, private readonly createId: () => string = randomUUID) {
    this.filePath = path.join(directory, "projects.json");
    this.lockPath = path.join(directory, "projects.lock");
  }

  list(): ProjectSnapshot {
    return withCrossProcessLockSync(this.lockPath, "Project store", () => this.snapshot(this.loadOrInitialize()));
  }

  createProject(command: ProjectStoreCommand, name: string): ProjectStoreResult {
    return this.mutate(command, "project-create", state => {
      const next = createProject(state, name, this.createId);
      return { state: next, entityId: next.projects[next.projects.length - 1].projectId };
    });
  }

  createThread(command: ProjectStoreCommand, projectId: string, name: string): ProjectStoreResult {
    return this.mutate(command, "thread-create", state => {
      const next = createThread(state, projectId, name, this.createId);
      return { state: next, entityId: next.threads[next.threads.length - 1].threadId };
    });
  }

  moveThread(command: ProjectStoreCommand, plan: ThreadMovePlan): ProjectStoreResult {
    return this.mutate(command, "thread-move", state => ({ state: moveThread(state, plan), entityId: plan.threadId }));
  }

  private mutate(
    command: ProjectStoreCommand,
    operation: string,
    mutation: (state: ProjectModelState) => { state: ProjectModelState; entityId: string }
  ): ProjectStoreResult {
    return withCrossProcessLockSync(this.lockPath, "Project store", () => {
      validateCommand(command);
      const current = this.loadOrInitialize();
      const receipt = current.payload.receipts.find(candidate => candidate.commandId === command.commandId);
      if (receipt) {
        if (receipt.fingerprint !== command.fingerprint) fail("command-conflict", "Command ID was already used with a different fingerprint.");
        return { snapshot: this.snapshot(current), entityId: receipt.entityId, replayed: true };
      }
      if (command.expectedStoreVersion !== current.storeVersion) fail("store-version-conflict", "Expected Project store version does not match the current version.");
      const changed = mutation(clone(current.payload.state));
      const storeVersion = current.storeVersion + 1;
      const next = makeEnvelope(storeVersion, {
        state: changed.state,
        receipts: [...current.payload.receipts, {
          commandId: command.commandId,
          fingerprint: command.fingerprint,
          operation,
          storeVersion,
          entityId: changed.entityId
        }]
      });
      this.write(next);
      return { snapshot: this.snapshot(next), entityId: changed.entityId, replayed: false };
    });
  }

  private loadOrInitialize(): ProjectStoreEnvelope {
    fs.mkdirSync(this.directory, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      const initial = makeEnvelope(1, { state: initializeProjectModel(undefined, this.createId), receipts: [] });
      this.write(initial);
      return initial;
    }
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(this.filePath, "utf8")); }
    catch { fail("store-corrupt", "Project store JSON is corrupt."); }
    return verifyEnvelope(value);
  }

  private snapshot(envelope: ProjectStoreEnvelope): ProjectSnapshot {
    const state = envelope.payload.state;
    return clone({ schema: 1, storeVersion: envelope.storeVersion, rootId: state.rootId, projects: state.projects, threads: state.threads });
  }

  private write(envelope: ProjectStoreEnvelope): void {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, canonicalJson(envelope), "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
    fsyncDirectory(this.directory);
  }
}

function makeEnvelope(storeVersion: number, payload: ProjectStorePayload): ProjectStoreEnvelope {
  return { schema: PROJECT_STORE_SCHEMA, storeVersion, payload: clone(payload), digest: digest(payload) };
}

function verifyEnvelope(value: unknown): ProjectStoreEnvelope {
  if (!isRecord(value) || value.schema !== PROJECT_STORE_SCHEMA || !Number.isSafeInteger(value.storeVersion) || Number(value.storeVersion) < 1
    || !isRecord(value.payload) || !isRecord(value.payload.state) || !Array.isArray(value.payload.receipts) || typeof value.digest !== "string") {
    fail("store-corrupt", "Project store envelope is invalid.");
  }
  const envelope = value as unknown as ProjectStoreEnvelope;
  if (digest(envelope.payload) !== envelope.digest) fail("store-corrupt", "Project store digest does not match its payload.");
  const state = initializeProjectModel(envelope.payload.state);
  if (canonicalJson(state) !== canonicalJson(envelope.payload.state)) fail("store-repair-required", "Project store system records require repair.");
  for (const receipt of envelope.payload.receipts) {
    if (!isRecord(receipt) || typeof receipt.commandId !== "string" || typeof receipt.fingerprint !== "string"
      || typeof receipt.operation !== "string" || !Number.isSafeInteger(receipt.storeVersion) || typeof receipt.entityId !== "string") {
      fail("store-corrupt", "Project store receipt is invalid.");
    }
  }
  return clone(envelope);
}

function validateCommand(command: ProjectStoreCommand): void {
  if (!command || typeof command.commandId !== "string" || !command.commandId.trim() || typeof command.fingerprint !== "string" || !command.fingerprint.trim()
    || !Number.isSafeInteger(command.expectedStoreVersion) || command.expectedStoreVersion < 0) {
    fail("command-invalid", "Project command identity, fingerprint, and expected version are required.");
  }
}

function digest(payload: ProjectStorePayload): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error: any) {
    if (!error || !["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string): never {
  throw new ProjectStoreError(code, message);
}