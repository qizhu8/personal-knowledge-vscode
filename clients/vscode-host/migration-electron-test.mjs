import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { initialize, Storage } from "../../dist/storage.js";
import { admitLegacyRetrievalModel } from "../../dist/legacy-retrieval-model.js";
import { stageIsolatedManagedGeneration, publishIsolatedManagedGeneration } from "../../experimental/managed-migration.mjs";
import { runElectronAcceptance } from "./electron-test.mjs";
import { enrollManagedSchedulerArtifacts } from "../../tests/managed-scheduler-artifact-fixture.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, `.managed-electron-${randomUUID()}`);
try {
  await mkdir(root, { mode: 0o700 });
  const data = await initialize(join(root, "data"));
  await writeFile(join(data, "notes", "Example.md"), "---\ntitle: Electron migration\n---\nActual frozen Note read\n");
  await mkdir(join(data, "papers"));
  await writeFile(join(data, "papers", "Paper.md"), "---\ntitle: Electron Research\n---\nActual frozen Research read\n");
  const modelEnabled = process.env.PKM_MANAGED_MODEL_ACCEPTANCE === "1";
  const schedulerArtifactsEnabled = process.env.PKM_MANAGED_SCHEDULER_ARTIFACTS_ACCEPTANCE === "1";
  const python = execFileSync("python3", ["-I", "-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim();
  let model;
  if (modelEnabled) {
    model = JSON.parse(execFileSync(python, ["-I", "-B", resolve(here, "../../tests/legacy-retrieval-tiny-model.py"),
      join(root, "random-offline-model-source")], { encoding: "utf8", env: { ...process.env, TMPDIR: root, OMP_NUM_THREADS: "1" } }));
    const storage = await Storage.open(data);
    try {
      await admitLegacyRetrievalModel(storage, { id: "mcp:external", canWrite: true }, {
        sourceRoot: model.root, packageId: model.packageId, authorityId: "test-native-electron-owner",
        authorize: () => true, learningEnabled: true, userFeedback: false,
      });
    } finally { await storage.close(); }
  }
  const schedulerArtifacts = schedulerArtifactsEnabled
    ? await enrollManagedSchedulerArtifacts(data, join(root, "explicit-host-artifact-paths")) : undefined;
  const options = { managedRoot: join(root, "managed"), data, python, allowWrites: modelEnabled || schedulerArtifactsEnabled,
    ...(schedulerArtifacts ? { snapshotScheduler: schedulerArtifacts.snapshotScheduler } : {}),
    modelDependencies: modelEnabled, maxPythonDependencyBytes: modelEnabled ? 2 * 1024 ** 3 : 512 * 1024 ** 2 };
  const first = await stageIsolatedManagedGeneration(options);
  const second = await stageIsolatedManagedGeneration(options);
  if (process.env.PKM_MANAGED_ELECTRON_COPY_SIGNAL)
    await writeFile(process.env.PKM_MANAGED_ELECTRON_COPY_SIGNAL, JSON.stringify({
      managedRoot: options.managedRoot, generations: [first.generation, second.generation],
      runtimeBuilds: [first.runtimeBuild, second.runtimeBuild],
    }) + "\n", { flag: "wx" });
  await publishIsolatedManagedGeneration(options.managedRoot, first.generation);
  await runElectronAcceptance({
    runner: "migration-electron-test-runner.cjs", workspace: data,
    environment: { PKM_MANAGED_MIGRATION_FIXTURE: JSON.stringify({
      managedRoot: options.managedRoot, first: first.generation, second: second.generation,
      modelPackageId: model?.packageId,
      schedulerArtifacts,
      module: fileURLToPath(new URL("../../experimental/managed-migration.mjs", import.meta.url)),
    }) },
  });
} finally { await rm(root, { recursive: true, force: true }); }
