import type { DatabaseSync } from "node:sqlite";

export const ACTION_RUNTIME_DDL = `
CREATE TABLE IF NOT EXISTS action_runtime_runs (
  actor_id TEXT NOT NULL, run_id TEXT NOT NULL, version INTEGER NOT NULL,
  snapshot TEXT NOT NULL, PRIMARY KEY(actor_id,run_id)
);
CREATE TABLE IF NOT EXISTS action_runtime_events (
  actor_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  record_json TEXT NOT NULL, PRIMARY KEY(actor_id,run_id,sequence)
);
CREATE TABLE IF NOT EXISTS action_runtime_receipts (
  actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  result TEXT NOT NULL, PRIMARY KEY(actor_id,operation_id)
);
CREATE INDEX IF NOT EXISTS action_runtime_events_run
  ON action_runtime_events(actor_id,run_id,sequence);`;

export function initializeActionRuntime(database: DatabaseSync): void {
  database.exec(ACTION_RUNTIME_DDL);
}
