import * as fs from "fs";
import * as path from "path";

interface MetricSample { at: string; value: number; count?: number; }
type MetricStore = Record<string, MetricSample[]>;

function readStore(filePath: string): MetricStore {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")) as MetricStore; }
  catch { return {}; }
}

export function recordPerformanceMetric(stateDir: string, name: string, value: number, count?: number): void {
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(name) || !Number.isFinite(value) || value < 0) return;
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, "metrics.json");
  const store = readStore(filePath);
  const samples = store[name] ||= [];
  samples.push({ at: new Date().toISOString(), value: Math.round(value), ...(Number.isFinite(count) ? { count: Math.max(0, Math.round(Number(count))) } : {}) });
  if (samples.length > 200) samples.splice(0, samples.length - 200);
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

export function performanceSummary(stateDir: string): Record<string, { samples: number; p50: number; p95: number; latest: number }> {
  const store = readStore(path.join(stateDir, "metrics.json"));
  return Object.fromEntries(Object.entries(store).map(([name, samples]) => {
    const values = samples.map(sample => sample.value);
    return [name, { samples: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), latest: values[values.length - 1] || 0 }];
  }));
}
