import * as fs from "fs";
import * as path from "path";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const actionId = (value: unknown): value is string => typeof value === "string" && /^action_run_[a-f0-9]{32}$/.test(value);

export function recordedActionReferences(result: string | undefined): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5) return;
    if (typeof value === "string") {
      try { visit(JSON.parse(value), depth + 1); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      return;
    }
    if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
    const record = object(value);
    if (!record) return;
    if (actionId(record.run_id)) found.add(record.run_id);
    for (const key of ["data", "result", "run", "runs", "structuredContent", "content", "text"]) {
      if (record[key] !== undefined) visit(record[key], depth + 1);
    }
  };
  visit(result, 0);
  return [...found];
}

export function readHarnessActions(stateDirectory: string, references: string[],
  read: (filename: string) => unknown = filename => JSON.parse(fs.readFileSync(filename, "utf8"))) {
  const directory = path.join(stateDirectory, "actions", "runs");
  const records = new Map<string, RecordValue>(), warnings: string[] = [];
  if (!references.length) return { actionRuns: [], actionWarnings: warnings };
  const names = fs.existsSync(directory) ? fs.readdirSync(directory).filter(actionId) : [];
  for (const name of names) {
    try {
      const record = object(read(path.join(directory, name, "run.json")));
      if (record?.schema !== "pkm.action.run/v1" || record.run_id !== name) throw new Error("Record identity mismatch.");
      records.set(name, record);
    } catch (error) {
      warnings.push(references.includes(name)
        ? `Action Run ${name} could not be read: ${error instanceof Error ? error.message : String(error)}`
        : "The Action Run index is incomplete: an entry could not be read. Child Run coverage may be incomplete.");
    }
  }
  const included = new Set(references.filter(actionId));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, record] of records) if (typeof record.parent_run_id === "string" && included.has(record.parent_run_id) && !included.has(id)) {
      included.add(id); changed = true;
    }
  }
  const actionRuns = [...included].flatMap(id => {
    const record = records.get(id);
    if (!record) { warnings.push(`Referenced Action Run ${id} is unavailable.`); return []; }
    const steps: RecordValue[] = [];
    const stepDirectory = path.join(directory, id, "steps");
    for (const name of fs.existsSync(stepDirectory) ? fs.readdirSync(stepDirectory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)) : []) {
      try {
        const receipt = object(read(path.join(stepDirectory, name)));
        if (receipt?.schema !== "pkm.action.step-receipt/v1" || typeof receipt.key !== "string") throw new Error("Invalid component receipt.");
        steps.push(receipt);
      } catch (error) {
        warnings.push(`${id}: a component receipt is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    steps.sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
    const eventDirectory = path.join(directory, id, "step-events");
    for (const name of fs.existsSync(eventDirectory) ? fs.readdirSync(eventDirectory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)) : []) {
      try {
        const events = object(read(path.join(eventDirectory, name)));
        if (events?.schema !== "pkm.action.component-events/v1" || typeof events.key !== "string" || !Array.isArray(events.events)) throw new Error("Invalid Component event record.");
        const completed = steps.find(step => step.key === events.key);
        if (completed) Object.assign(completed, { events:events.events, component:events.component, actionId:events.action_id });
        else steps.push({ ...events, at:object(events.events[0])?.at, reason:object(events.events[events.events.length - 1])?.reason });
      } catch (error) {
        warnings.push(`${id}: Component lifecycle evidence is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    steps.sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
    const execution = object(record.execution);
    return [{
      runId:id, actionId:record.action_id, state:record.state, parentRunId:record.parent_run_id,
      revision:record.content_hash, definition:record.definition, inputs:record.inputs, output:record.output,
      startedAt:record.started_at, completedAt:record.completed_at, error:record.error,
      execution:execution ? { phase:execution.phase, reasonCode:execution.reasonCode, resumeCondition:execution.resumeCondition, receipts:execution.receipts } : undefined,
      steps,
    }];
  });
  return { actionRuns, actionWarnings:warnings };
}
