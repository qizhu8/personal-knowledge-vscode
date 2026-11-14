import type { LocalEnvironment } from "./local-environment-catalog";
import { planPackageMerge } from "../servers/pyenvs";
import { cachedPythonPackages, pythonAnalysisEntry } from "./local-python-analytics";
import { readPythonMetadataSnapshot } from "./local-python-inspection";
import { inspectCondaPrefix } from "./local-conda-lifecycle";
import { planPythonLifecycle, bashQuote } from "./local-python-lifecycle";

export function condaManualDeleteScript(entry: LocalEnvironment, executable: string) {
  const prefix = inspectCondaPrefix(entry);
  if (!prefix.root.includes("/envs/"))
    throw new Error("Legacy conda manual deletion requires an /envs/ prefix. Use the reviewed managed-copy removal action for Next synthetic copies.");
  return `#!/bin/bash\nset -eu\n# MANUAL ONLY: permanent deletion; metadata restore cannot restore files. Never executed by PKM.\n[ ! -L ${bashQuote(prefix.root)} ]\n[ "$(/usr/bin/realpath -- ${bashQuote(prefix.root)})" = ${bashQuote(prefix.root)} ]\n[ "$(/usr/bin/stat -c '%d:%i' -- ${bashQuote(prefix.root)})" = ${bashQuote(prefix.identity)} ]\n${bashQuote(executable)} env remove -y -p ${bashQuote(prefix.root)}\n`;
}
export function generatePythonMergeScript(storage: string, a: LocalEnvironment, b: LocalEnvironment, condaExecutable?: string) {
  const ca = cachedPythonPackages(storage, a), cb = cachedPythonPackages(storage, b);
  if (!ca.sourceMatches || !cb.sourceMatches) throw new Error("Refresh historical snapshots before generating a destructive manual merge plan.");
  const metadata = (entry: LocalEnvironment) => readPythonMetadataSnapshot(storage, entry)?.snapshot;
  const plan = planPackageMerge(pythonAnalysisEntry(a, metadata(a)), pythonAnalysisEntry(b, metadata(b)), ca.snapshot.packages, cb.snapshot.packages);
  const dropEntry = plan.drop.id === a.id ? a : b;
  let deletion: string;
  if (dropEntry.manager === "conda") {
    if (!condaExecutable) throw new Error("Explicitly select installed conda before generating the manual conda deletion footer.");
    deletion = condaManualDeleteScript(dropEntry, condaExecutable);
  } else deletion = planPythonLifecycle(dropEntry).deletionScript;
  const safeComment = (value: string) => value.replace(/[\r\n\0]/g, " ");
  const lines = ["#!/bin/bash", "set -euo pipefail", "# MANUAL REVIEW ONLY — PKM never runs this script or installs its packages.",
    `# Keep ${safeComment(plan.keep.name)} (${plan.keep.id}); drop ${safeComment(plan.drop.name)} (${plan.drop.id}).`,
    `# Cached inputs: ${ca.snapshot.capturedAt} and ${cb.snapshot.capturedAt}. Counts win; allocated size breaks ties.`,
    "# Direct registered interpreter is used instead of ambient activation/PATH.", ""];
  if (plan.missing.length) {
    const specs = plan.missing.sort((x, y) => x.name.localeCompare(y.name)).map(p => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p.name) || !/^[A-Za-z0-9][A-Za-z0-9.+!_-]*$/.test(p.version))
        throw new Error("Package metadata cannot form a safe pinned manual requirement.");
      return bashQuote(`${p.name}==${p.version}`);
    });
    lines.push(`${bashQuote(plan.keep.python)} -m pip install -- ${specs.join(" ")}`);
    if (plan.keep.manager === "conda") lines.push("# Some missing requirements may be conda-managed; manually review equivalent conda installs.");
  } else lines.push("# No missing packages to install.");
  for (const p of plan.differences.slice(0, 300))
    lines.push(`# ${safeComment(p.name)}: keep ${safeComment(p.keep)} vs drop ${safeComment(p.drop)} (unchanged; review manually).`);
  lines.push("", "# STOP and verify the kept environment before manually deleting the other.",
    "read -r -p 'After verification type DELETE to remove the redundant prefix: ' answer", "[ \"$answer\" = DELETE ]",
    deletion.replace(/^#![^\n]*\n/, ""));
  return { script: lines.join("\n") + "\n", keep: plan.keep.name, drop: plan.drop.name,
    keepId: plan.keep.id, dropId: plan.drop.id };
}
