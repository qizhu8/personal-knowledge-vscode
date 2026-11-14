import * as fs from "fs";
import * as path from "path";
import { comparePackageSets, similarPackageSets, type PyEnv } from "../servers/pyenvs";
export { planPackageMerge as planPythonPackageMerge } from "../servers/pyenvs";
import type { LocalEnvironment } from "./local-environment-catalog";
import { readPythonPackageSnapshot } from "./local-python-packages";

export function cachedPythonPackages(storage: string, entry: LocalEnvironment) {
  const cached = readPythonPackageSnapshot(storage, entry);
  if (!cached) throw new Error(`No package snapshot for ${entry.id}. Explicitly refresh it first; analysis never runs a manager.`);
  return cached;
}
export function pythonAnalysisEntry(entry: LocalEnvironment, metadata?: { pyVersion: string; sizeBytes: number }): PyEnv {
  let version = metadata?.pyVersion || (typeof entry.legacyPython?.pyVersion === "string" ? entry.legacyPython.pyVersion : "");
  if (!version && entry.root) {
    try {
      const file = path.join(entry.root, "pyvenv.cfg");
      if (fs.lstatSync(file).isFile() && fs.statSync(file).size <= 65_536)
        version = fs.readFileSync(file, "utf8").match(/^\s*version(?:_info)?\s*=\s*(\d+\.\d+(?:\.\d+)?)/mi)?.[1] || "";
    } catch { /* Unknown minor versions are not excluded by the legacy algorithm. */ }
  }
  return { id: entry.id, name: entry.name, manager: entry.manager as PyEnv["manager"],
    path: entry.root!, python: entry.executors[0].executable, pyVersion: version,
    sizeBytes: metadata?.sizeBytes ?? (typeof entry.legacyPython?.sizeBytes === "number" ? entry.legacyPython.sizeBytes : 0) };
}
export function comparePythonSnapshots(storage: string, a: LocalEnvironment, b: LocalEnvironment) {
  if (a.id === b.id) throw new Error("Pick two different environments.");
  const ca = cachedPythonPackages(storage, a), cb = cachedPythonPackages(storage, b);
  return { ...comparePackageSets(ca.snapshot.packages, cb.snapshot.packages, a.name, b.name),
    snapshots: [{ id: a.id, capturedAt: ca.snapshot.capturedAt, sourceMatches: ca.sourceMatches },
      { id: b.id, capturedAt: cb.snapshot.capturedAt, sourceMatches: cb.sourceMatches }] };
}
export function similarPythonSnapshots(storage: string, entries: LocalEnvironment[],
  metadata: (entry: LocalEnvironment) => { pyVersion: string; sizeBytes: number } | undefined = () => undefined) {
  if (entries.length > 64) throw new Error("Select at most 64 environments for bounded pairwise analysis.");
  const snapshots = entries.map(entry => ({ entry, ...cachedPythonPackages(storage, entry) }));
  return { ...similarPackageSets(snapshots.map(({ entry, snapshot }) => ({
    env: pythonAnalysisEntry(entry, metadata(entry)), map: new Map(snapshot.packages.map(p => [p.name.toLowerCase(), p.version])),
  }))), snapshots: snapshots.map(({ entry, snapshot, sourceMatches }) => ({ id: entry.id, capturedAt: snapshot.capturedAt, sourceMatches })) };
}
