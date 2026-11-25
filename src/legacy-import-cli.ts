import { isAbsolute } from "node:path";
import {
  cleanupInterruptedLegacyImportStages, importLegacyWorkspace, inspectLegacyRootForAdoption,
  planLegacyImport, recoverLegacyImportOutcome,
} from "./legacy-import.js";

type ImportCommand = "import-plan" | "import" | "import-status" | "import-cleanup";

export async function runLegacyRootInspectionCli(args: string[]): Promise<void> {
  const checkWriters = args.length === 3 && args[2] === "--check-writers";
  if ((!checkWriters && args.length !== 2) || args[0] !== "--root" || !args[1] || !isAbsolute(args[1])) {
    throw new Error("Usage: inspect-legacy-root --root <absolute legacy Knowledge Root> [--check-writers]");
  }
  if (checkWriters) {
    const { inspectLinuxLegacyWriterQuiescence } = await import("./linux-legacy-writer-quiescence.js");
    const writerQuiescence = await inspectLinuxLegacyWriterQuiescence(args[1]);
    const inspection = writerQuiescence.blockers.length ? null : await inspectLegacyRootForAdoption(args[1]);
    console.log(JSON.stringify({ preflight: {
      schema: "pkm.legacy-root-cold-preflight/v1", sourceRoot: writerQuiescence.root,
      ready: false, writerQuiescence, inspection,
      blockers: inspection ? inspection.blockers : [{
        code: "legacy-writers-active", path: ".",
        message: "Legacy writers or unverified processes remain; content inventory was not started. No process was terminated.",
      }],
    } }));
    process.exitCode = 1;
    return;
  }
  const inspection = await inspectLegacyRootForAdoption(args[1]);
  console.log(JSON.stringify({ inspection }));
}

export async function runLegacyImportCli(command: ImportCommand, args: string[]): Promise<void> {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const valueOptions = new Set(["--source", "--destination", "--plan-sha256", "--python", "--memory-engine", "--memory-actor-id", "--memory-continuity-scope-sha256", "--router-config"]);
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--acknowledge-quiescent-disposable-copy" || option === "--acknowledge-abandoned-stages") {
      if (switches.has(option)) throw new Error(`Duplicate option: ${option}`);
      switches.add(option);
    } else if (valueOptions.has(option)) {
      const value = args[++index];
      if (!value || value.startsWith("--") || values.has(option)) throw new Error(`Missing or duplicate value for ${option}.`);
      values.set(option, value);
    } else {
      throw new Error(`Unknown import option: ${option}`);
    }
  }
  const permitted = command === "import-plan" ? ["--source", "--memory-engine", "--memory-actor-id", "--memory-continuity-scope-sha256", "--router-config"] : command === "import"
    ? ["--source", "--destination", "--plan-sha256", "--python", "--memory-engine", "--memory-actor-id", "--memory-continuity-scope-sha256", "--router-config"]
    : ["--destination"];
  if ([...values.keys()].some(option => !permitted.includes(option))
    || [...switches].some(option => option !== (command === "import-cleanup"
      ? "--acknowledge-abandoned-stages" : "--acknowledge-quiescent-disposable-copy"))
    || (command === "import-status" && switches.size))
    throw new Error("Options do not match the import command.");
  for (const option of permitted.filter(option => option === "--destination" || option === "--source"
    || option === "--python" || option === "--plan-sha256")) {
    const value = values.get(option);
    if (!value) throw new Error(`Required option: ${option}`);
    if (option !== "--plan-sha256" && !isAbsolute(value)) throw new Error(`${option} must be an absolute path.`);
  }
  if (command === "import-status") {
    const outcome = await recoverLegacyImportOutcome(values.get("--destination")!);
    console.log(JSON.stringify({ outcome }));
    if (outcome.status !== "published") process.exitCode = 1;
    return;
  }
  if (command === "import-cleanup") {
    if (!switches.has("--acknowledge-abandoned-stages"))
      throw new Error("Explicitly acknowledge cleanup of abandoned disposable import stages.");
    const cleanup = await cleanupInterruptedLegacyImportStages(values.get("--destination")!);
    console.log(JSON.stringify({ cleanup }));
    if (cleanup.retained.length) process.exitCode = 1;
    return;
  }
  if (!switches.has("--acknowledge-quiescent-disposable-copy"))
    throw new Error("Explicitly acknowledge that the source is a quiescent disposable copy.");
  if (!!values.get("--memory-engine") !== !!values.get("--memory-actor-id")) {
    throw new Error("--memory-engine and --memory-actor-id must be supplied together.");
  }
  for (const option of ["--memory-engine", "--memory-actor-id", "--router-config"]) {
    const value = values.get(option);
    if (value && option !== "--memory-actor-id" && !isAbsolute(value)) throw new Error(`${option} must be an absolute path.`);
    if (value && option === "--memory-actor-id" && !value.trim()) throw new Error(`${option} must not be empty.`);
  }
  const policy = {
    ...(values.get("--memory-engine") ? { memoryEngine: values.get("--memory-engine")! } : {}),
    ...(values.get("--memory-actor-id") ? { memoryActorId: values.get("--memory-actor-id")! } : {}),
    ...(values.get("--memory-continuity-scope-sha256") ? { memoryContinuityScopeSha256: values.get("--memory-continuity-scope-sha256")! } : {}),
    ...(values.get("--router-config") ? { routerConfig: values.get("--router-config")! } : {}),
  };
  if (policy.memoryContinuityScopeSha256 && !policy.memoryEngine) throw new Error("Scope continuity requires an explicit original Memory import.");
  if (command === "import" && policy.memoryContinuityScopeSha256) {
    throw new Error("A trusted native host must approve Memory scope continuity; the offline CLI cannot grant it.");
  }
  const plan = await planLegacyImport(values.get("--source")!, {}, policy);
  if (command === "import-plan") {
    console.log(JSON.stringify({ plan }));
    if (!plan.ready) process.exitCode = 1;
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(values.get("--plan-sha256")!))
    throw new Error("--plan-sha256 must be the exact lowercase SHA-256 from import-plan.");
  if (!plan.ready) {
    console.log(JSON.stringify({ plan }));
    process.exitCode = 1;
    return;
  }
  if (plan.planSha256 !== values.get("--plan-sha256"))
    throw new Error("The source no longer matches the approved plan; run import-plan again.");
  const receipt = await importLegacyWorkspace(plan, values.get("--destination")!, {
    pythonExecutable: values.get("--python")!,
    ...(values.get("--memory-actor-id") ? { memoryActorId: values.get("--memory-actor-id")! } : {}),
  });
  console.log(JSON.stringify({ receipt }));
}
