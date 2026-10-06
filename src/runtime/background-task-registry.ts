export type BackgroundTaskStatus = "queued" | "running";
export type BackgroundTaskKind = "content-check" | "inventory" | "retrieval" | "github-sync" | "broker-refresh" | "other";

export interface BackgroundTaskProgress {
  current: number;
  total?: number;
  unit?: string;
}

export interface BackgroundTask {
  id: string;
  kind: BackgroundTaskKind;
  label: string;
  status: BackgroundTaskStatus;
  detail?: string;
  queuedAt?: string;
  startedAt?: string;
  nextRunAt?: string;
  progress?: BackgroundTaskProgress;
}

export interface BackgroundTaskSnapshot {
  revision: number;
  updatedAt: string;
  tasks: BackgroundTask[];
}

export type BackgroundTaskListener = (snapshot: BackgroundTaskSnapshot) => void;

export interface BackgroundTaskUpdate {
  label?: string;
  detail?: string;
  nextRunAt?: string;
  progress?: BackgroundTaskProgress;
}

export interface BackgroundTaskProducer {
  queued(update?: BackgroundTaskUpdate): void;
  running(update?: BackgroundTaskUpdate): void;
  idle(): void;
}

function copyTask(task: BackgroundTask): BackgroundTask {
  return { ...task, progress: task.progress ? { ...task.progress } : undefined };
}

export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly listeners = new Set<BackgroundTaskListener>();
  private revision = 0;
  private updatedAt = "";

  constructor(private readonly now: () => Date = () => new Date()) {}

  producer(identity: Pick<BackgroundTask, "id" | "kind" | "label">): BackgroundTaskProducer {
    const update = (status: BackgroundTaskStatus, patch: BackgroundTaskUpdate = {}): void => {
      const previous = this.tasks.get(identity.id);
      const timestamp = this.now().toISOString();
      this.set({
        ...identity,
        ...patch,
        status,
        queuedAt: status === "queued"
          ? previous?.status === "queued" ? previous.queuedAt : timestamp
          : previous?.queuedAt,
        startedAt: status === "running"
          ? previous?.status === "running" ? previous.startedAt : timestamp
          : undefined,
      });
    };
    return {
      queued: patch => update("queued", patch),
      running: patch => update("running", patch),
      idle: () => this.remove(identity.id),
    };
  }

  set(task: BackgroundTask): void {
    const normalized = copyTask(task);
    const previous = this.tasks.get(task.id);
    if (previous && JSON.stringify(previous) === JSON.stringify(normalized)) return;
    this.tasks.set(task.id, normalized);
    this.changed();
  }

  remove(id: string): void {
    if (!this.tasks.delete(id)) return;
    this.changed();
  }

  clear(): void {
    if (!this.tasks.size) return;
    this.tasks.clear();
    this.changed();
  }

  snapshot(): BackgroundTaskSnapshot {
    const tasks = [...this.tasks.values()].map(copyTask).sort((left, right) => {
      if (left.status !== right.status) return left.status === "running" ? -1 : 1;
      const leftTime = left.nextRunAt || "";
      const rightTime = right.nextRunAt || "";
      if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
      return left.label.localeCompare(right.label);
    });
    return { revision: this.revision, updatedAt: this.updatedAt, tasks };
  }

  subscribe(listener: BackgroundTaskListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private changed(): void {
    this.revision += 1;
    this.updatedAt = this.now().toISOString();
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
