import * as fs from "fs";
import * as path from "path";
import type { RetrievalIndexEventV1, RetrievalIndexSource } from "./retrieval-contracts";
import { assertRetrievalIndexEventV1 } from "./retrieval-contracts";

interface PersistedIndexState {
  schema: 1;
  generation: number;
  appliedEventIds: string[];
  sourceRevisions: Record<string, string>;
  sources: Record<string, RetrievalIndexSource>;
}

export interface RetrievalIndexApplyResult {
  generation: number;
  applied: number;
  reused: number;
  sources: RetrievalIndexSource[];
}

function compareRevision(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined) return Math.sign(leftNumber - rightNumber);
  return left === right ? 0 : 1;
}

export class RetrievalIndexEventStore {
  constructor(private readonly statePath: string) {}

  private read(): PersistedIndexState {
    try {
      const value = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as PersistedIndexState;
      if (value.schema === 1 && Number.isSafeInteger(value.generation)) return value;
    } catch { /* first materialization */ }
    return { schema: 1, generation: 0, appliedEventIds: [], sourceRevisions: {}, sources: {} };
  }

  apply(inputs: readonly unknown[]): RetrievalIndexApplyResult {
    const state = this.read();
    const appliedIds = new Set(state.appliedEventIds);
    let applied = 0;
    let reused = 0;
    let barrierGeneration: number | undefined;
    for (const input of inputs) {
      const event = assertRetrievalIndexEventV1(input);
      if (appliedIds.has(event.eventId)) {
        reused++;
        continue;
      }
      const previousRevision = state.sourceRevisions[event.sourceId];
      if (previousRevision && compareRevision(event.sourceRevision, previousRevision) <= 0) {
        throw new Error(`Stale source revision ${event.sourceRevision} for ${event.sourceId}; current revision is ${previousRevision}.`);
      }
      if (event.kind === "upsert") state.sources[event.sourceId] = { ...event.source, links: [...(event.source.links || [])] };
      else if (event.kind === "delete") delete state.sources[event.sourceId];
      else if (event.kind === "link-upsert") {
        const source = state.sources[event.sourceId];
        if (!source) throw new Error(`Cannot upsert a link for missing source ${event.sourceId}.`);
        const links = (source.links || []).filter(link => !(link.relation === event.link.relation && link.target === event.link.target));
        source.links = [...links, { ...event.link }];
      } else if (event.kind === "link-delete") {
        const source = state.sources[event.sourceId];
        if (!source) throw new Error(`Cannot delete a link for missing source ${event.sourceId}.`);
        source.links = (source.links || []).filter(link => !(link.relation === event.link.relation && link.target === event.link.target));
      } else {
        if (event.generation <= state.generation) throw new Error(`Rebuild barrier generation ${event.generation} is not newer than ${state.generation}.`);
        barrierGeneration = event.generation;
      }
      state.sourceRevisions[event.sourceId] = event.sourceRevision;
      appliedIds.add(event.eventId);
      applied++;
    }
    if (applied) state.generation = barrierGeneration || state.generation + 1;
    state.appliedEventIds = [...appliedIds].sort();
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporary, this.statePath);
    return {
      generation: state.generation,
      applied,
      reused,
      sources: Object.values(state.sources).sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    };
  }
}
