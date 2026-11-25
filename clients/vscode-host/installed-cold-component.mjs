import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  prepareInstalledNativeTodoSourceFixture, verifyInstalledNativeTodoSource, verifyInstalledNativeTodoSourceRestored,
} from "./installed-native-source.mjs";
import {
  prepareInstalledNativeActionFixture, bootstrapInstalledNativeActionComponent,
  verifyInstalledNativeAction, preserveInstalledNativeActionB1, verifyInstalledNativeActionRestored,
  prepareInstalledNativeActionProgramFixture, verifyInstalledNativeActionProgram, verifyInstalledNativeActionProgramRestored,
} from "./installed-native-action.mjs";
import {
  prepareInstalledNativeMemoryFixture, installedNativeMemoryProviderOptions,
  verifyInstalledNativeMemory, verifyInstalledNativeMemoryRestored,
} from "./installed-native-memory.mjs";
import {
  prepareInstalledNativeTodoWorkerFixture, verifyInstalledNativeTodoWorker, verifyInstalledNativeTodoWorkerRestored,
} from "./installed-native-todo-worker.mjs";
import {
  prepareInstalledNativeRecipeFixture, verifyInstalledNativeRecipe, verifyInstalledNativeRecipeRestored,
} from "./installed-native-recipe.mjs";
import {
  prepareInstalledNativeTodoAssignmentFixture, verifyInstalledNativeTodoAssignment,
  verifyInstalledNativeTodoAssignmentRestored, installedNativeTodoAssignmentModelFixture,
} from "./installed-native-todo-assignment.mjs";
import {
  prepareInstalledNativeRoomFixture, verifyInstalledNativeRoom, verifyInstalledNativeRoomRestored,
} from "./installed-native-room.mjs";
import {
  prepareInstalledNativeRoomLiveFixture, verifyInstalledNativeRoomLive, verifyInstalledNativeRoomLiveRestored,
} from "./installed-native-room-live.mjs";
import {
  prepareInstalledNativeManagedTaskFixture, verifyInstalledNativeManagedTask, verifyInstalledNativeManagedTaskRestored,
  installedNativeManagedTaskModelFixture, installedNativeManagedTaskProviderOptions,
} from "./installed-native-managed-task.mjs";
import {
  prepareInstalledNativeManagedTaskAdoptionFixture, verifyInstalledNativeManagedTaskAdoption,
  verifyInstalledNativeManagedTaskAdoptionRestored, installedNativeManagedTaskAdoptionProviderOptions,
} from "./installed-native-managed-task-adoption.mjs";
import {
  installedNativeKnowledgeMovePrivacyPolicy, prepareInstalledNativeKnowledgeMoveFixture,
  verifyInstalledNativeKnowledgeMove, verifyInstalledNativeKnowledgeMoveB1, verifyInstalledNativeKnowledgeMoveRestored,
} from "./installed-native-knowledge-move.mjs";
import {
  prepareInstalledNativeLegacyAssetsMoveFixture, verifyInstalledNativeLegacyAssetsMove,
  verifyInstalledNativeLegacyAssetsMoveB1, verifyInstalledNativeLegacyAssetsMoveRestored,
} from "./installed-native-legacy-assets-move.mjs";
import {
  prepareInstalledNativeSharedLegacyAssetsMoveFixture, verifyInstalledNativeSharedLegacyAssetsMove,
  verifyInstalledNativeSharedLegacyAssetsMoveB1, verifyInstalledNativeSharedLegacyAssetsMoveRestored,
} from "./installed-native-shared-legacy-assets-move.mjs";
import {
  prepareInstalledNativePrivateResourcePublicationFixture, verifyInstalledNativePrivateResourcePublication,
  verifyInstalledNativePrivateResourcePublicationB1, verifyInstalledNativePrivateResourcePublicationRestored,
} from "./installed-native-private-resource-publication.mjs";
import {
  prepareInstalledNativePrivateResourceLifecycleFixture, verifyInstalledNativePrivateResourceLifecycle,
  verifyInstalledNativePrivateResourceLifecycleB1, verifyInstalledNativePrivateResourceLifecycleRestored,
} from "./installed-native-private-resource-lifecycle.mjs";
import {
  mountInstalledNativePrivateResourceRecoveryParent, releaseInstalledNativePrivateResourceRecoveryMount,
  prepareInstalledNativePrivateResourceRecoveryFixture, verifyInstalledNativePrivateResourceRecoveryEnospc,
  reopenInstalledNativePrivateResourceRecovery, verifyInstalledNativePrivateResourceRecoveryEpoch,
  closeInstalledNativePrivateResourceRecoveryEpoch, verifyInstalledNativePrivateResourceRecoveryB1,
  verifyInstalledNativePrivateResourceRecoveryRestored,
} from "./installed-native-private-resource-recovery.mjs";
import {
  prepareInstalledNativePrivateInplaceFixture, verifyInstalledNativePrivateInplace,
  verifyInstalledNativePrivateInplaceB1, verifyInstalledNativePrivateInplaceRestored,
} from "./installed-native-private-inplace.mjs";
import {
  prepareInstalledNativeTrashFixture, verifyInstalledNativeTrash,
  verifyInstalledNativeTrashB1, verifyInstalledNativeTrashRestored,
} from "./installed-native-trash.mjs";
import {
  prepareInstalledNativeTrashLifecycleFixture, verifyInstalledNativeTrashLifecycle,
  createInstalledNativeTrashLifecycleFaultController, installedNativeTrashLifecycleFaultInjector,
  verifyInstalledNativeTrashLifecyclePending, verifyInstalledNativeTrashLifecycleB1,
  verifyInstalledNativeTrashLifecycleRestored,
} from "./installed-native-trash-lifecycle.mjs";
import {
  installedNativeTodoGenesisPrivacyPolicy, prepareInstalledNativeTodoGenesisFixture, verifyInstalledNativeTodoGenesis,
  verifyInstalledNativeTodoGenesisB1, verifyInstalledNativeTodoGenesisRestored,
} from "./installed-native-todo-genesis.mjs";
import {
  prepareInstalledNativeTodoLifecycleFixture, verifyInstalledNativeTodoLifecycle, pinInstalledNativeTodoLifecycleStopped,
  verifyInstalledNativeTodoLifecycleB1, verifyInstalledNativeTodoLifecycleRestored,
} from "./installed-native-todo-lifecycle.mjs";
import {
  prepareInstalledNativeTodoRecoveryFixture, createInstalledNativeTodoRecoveryFaultController,
  installedNativeTodoRecoveryFaultInjector, verifyInstalledNativeTodoRecoveryPending,
  verifyInstalledNativeTodoRecoveryB1, verifyInstalledNativeTodoRecoveryRestored,
} from "./installed-native-todo-recovery.mjs";
import {
  prepareInstalledNativeSkillPaperTrashFixture, verifyInstalledNativeSkillPaperTrash,
  verifyInstalledNativeSkillPaperTrashB1, verifyInstalledNativeSkillPaperTrashRestored,
  installedNativeSkillPaperTrashNoteSchemaControl,
} from "./installed-native-skill-paper-trash.mjs";
import { prepareInstalledHeldTrashParser, verifyInstalledHeldTrashParser } from "./installed-held-trash-parser.mjs";
import {
  prepareInstalledNativeNotePaperBasicFixture, verifyInstalledNativeNotePaperBasic,
  verifyInstalledNativeNotePaperBasicB1, verifyInstalledNativeNotePaperBasicRestored,
} from "./installed-native-note-paper-basic.mjs";
import {
  prepareInstalledNativeResearchBasicFixture, verifyInstalledNativeResearchBasic,
  verifyInstalledNativeResearchBasicB1, verifyInstalledNativeResearchBasicRestored,
} from "./installed-native-research-basic.mjs";
import {
  prepareInstalledNativeKnowledgeRecovery, verifyInstalledNativeKnowledgeRecovery,
  verifyInstalledNativeKnowledgeRecoveryB1, verifyInstalledNativeKnowledgeRecoveryRestored,
} from "./installed-native-knowledge-recovery-normal.mjs";
import {
  prepareInstalledNativeActionPureFixture, verifyInstalledNativeActionPure,
  verifyInstalledNativeActionPureB1, verifyInstalledNativeActionPureRestored,
} from "./installed-native-action-pure.mjs";

async function waitJson(path, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Cold native fixture timed out: ${path}`);
}

/** Disposable original-layout fixture only; no existing library/profile can enter its branded recovery API. */
export async function verifyInstalledColdComponent({ root, fixture, installed, payloadBuildId,
  editor, cliArgs, env, short, python, uiScript, nativeHome, stop, roomCredentialIntent,
  roomLiveCredentialPreparation, roomCallerEnvironment = {} }) {
  if (fixture.nativeScript) {
    const { verifyInstalledNativeScriptLifecycle } = await import("./installed-native-script-lifecycle.mjs");
    return verifyInstalledNativeScriptLifecycle({
      root, fixture, installed, payloadBuildId, editor, cliArgs, env, short, python, uiScript, nativeHome, stop,
    });
  }
  const api = await import(pathToFileURL(join(installed, "next-runtime/server/dist/original-mcp-cold-component.js")).href);
  const first = await waitJson(join(root, "native-identity-first.json"));
  const previousHome = process.env.HOME;
  let component, componentFixture, app, ui, ticket, endpoint, roomLiveDirectory, passed = false, componentClosed = false;
  let recoveryMount, recoveryEpoch;
  const recoveryEndpoints = [];
  const failures = [];
  try {
    process.env.HOME = nativeHome;
    const base = join(nativeHome, ".local/state/pkm-v5-recovery");
    await mkdir(base, { recursive: true, mode: 0o700 });
    if (fixture.nativePrivateResourceRecovery)
      recoveryMount = await mountInstalledNativePrivateResourceRecoveryParent({
        directory: join(base, `private-recovery-parent-${randomUUID()}`), namespaceWitness: fixture.recoveryNamespaceWitness,
      });
    componentFixture = await api.createOriginalMcpColdComponentFixture(join(recoveryMount?.directory ?? base, `native-cold-${randomUUID()}`));
    const inventory = await import(pathToFileURL(join(installed, "next-runtime/server/dist/linux-legacy-writer-quiescence.js")).href);
    const quiescence = {};
    async function waitForColdQuiescence(phase) {
      const reports = [], deadline = Date.now() + 10000;
      let stable = 0;
      const evidence = join(root, `cold-${phase}-quiescence.json`);
      while (Date.now() < deadline) {
        const report = await inventory.inspectLinuxLegacyWriterQuiescence(componentFixture.root);
        const blockers = await Promise.all(report.blockers.map(async blocker => {
          try {
            const status = await readFile(`/proc/${blocker.pid}/status`, "utf8");
            return { ...blocker, status: status.split("\n").filter(line => /^(Name|State|PPid|Uid):/.test(line)) };
          } catch (error) {
            return { ...blocker, statusError: String(error.code || error.name) };
          }
        }));
        reports.push({ ...report, blockers });
        await writeFile(evidence, JSON.stringify({
          scope: "new disposable cold fixture; unchanged strict Linux guard, no ignored or terminated process",
          stableRequired: 3, reports,
        }));
        stable = report.blockers.length ? 0 : stable + 1;
        if (stable === 3) { quiescence[phase] = { stableRequired: 3, reports }; return; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await inventory.assertLinuxLegacyWritersQuiescent(componentFixture.root);
      throw new Error(`Cold ${phase} process inventory did not stabilize; preserve ${evidence}.`);
    }
    for (const name of ["notes", "skills", ".pkm", ...(fixture.nativeActionPure ? ["papers"] : [])])
      await mkdir(join(componentFixture.root, name), { recursive: true, mode: 0o700 });
    const original = "---\ntitle: Entry\n---\nOriginal cold native fixture Note.\n";
    await writeFile(join(componentFixture.root, "notes/Entry.md"), original, { mode: 0o600 });
    await writeFile(join(componentFixture.root, "skills/Base.md"), "---\ntitle: Base\n---\nOriginal fixture skill.\n", { mode: 0o600 });
    await writeFile(join(componentFixture.root, ".pkm/content-privacy.json"),
      JSON.stringify(fixture.nativeTodoGenesis || fixture.nativeTodoLifecycle || fixture.nativeTodoRecovery
        ? installedNativeTodoGenesisPrivacyPolicy
        : fixture.nativeKnowledgeMove ? installedNativeKnowledgeMovePrivacyPolicy
        : { schema: 1, private: fixture.nativeRoom ? { notes: ["Chatroom Meetings"] } : {} }), { mode: 0o600 });
    await waitForColdQuiescence("preparation");
    let sourceFixture, memoryFixture, workerFixture, assignmentFixture, taskFixture, adoptionFixture;
    if (fixture.nativeTodoSource || fixture.nativeMemory || fixture.nativeTodoWorker || fixture.nativeTodoAssignment || fixture.nativeManagedTask) {
      const sourcePackage = await readFile(fixture.legacyVsix);
      assert.equal(createHash("sha256").update(sourcePackage).digest("hex"),
        "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27",
        "Source fixture must use the independently pinned original writer package.");
      const writerRoot = join(root, "original-source-writer");
      await mkdir(writerRoot, { mode: 0o700 });
      execFileSync("unzip", ["-q", fixture.legacyVsix, "extension/dist/*", "extension/resources/*",
        "extension/node_modules/*", "extension/package.json",
        ...(fixture.nativeMemory ? ["extension/modules/pkm-memory-engine/src/*"] : []),
        "-d", writerRoot], { env, stdio: "inherit" });
      const writerPath = join(writerRoot, "extension/dist/knowledge/filestore.js");
      const originalWriter = execFileSync("unzip", ["-p", fixture.legacyVsix, "extension/dist/knowledge/filestore.js"], { env });
      if (fixture.nativeTodoSource)
        sourceFixture = await prepareInstalledNativeTodoSourceFixture({ installed, componentFixture,
          legacyWriter: { path: writerPath, sha256: createHash("sha256").update(originalWriter).digest("hex") } });
      if (fixture.nativeTodoWorker)
        workerFixture = await prepareInstalledNativeTodoWorkerFixture({ installed, componentFixture,
          legacyWriter: { path: writerPath, sha256: createHash("sha256").update(originalWriter).digest("hex") } });
      if (fixture.nativeTodoAssignment) {
        const member = "extension/dist/chat/api-chat-store.js";
        assignmentFixture = await prepareInstalledNativeTodoAssignmentFixture({ installed, componentFixture,
          legacyWriter: { path: writerPath, sha256: createHash("sha256").update(originalWriter).digest("hex") },
          legacyChatStore: { path: join(writerRoot, member),
            sha256: createHash("sha256").update(execFileSync("unzip", ["-p", fixture.legacyVsix, member], { env })).digest("hex") },
        });
      }
      if (fixture.nativeManagedTask) {
        const member = "extension/dist/chat/api-chat-store.js";
        const legacyChatStore = { path: join(writerRoot, member),
          sha256: createHash("sha256").update(execFileSync("unzip", ["-p", fixture.legacyVsix, member], { env })).digest("hex") };
        if (fixture.nativeManagedTaskAdoption) {
          const goalMember = "extension/dist/chat/chat-work-goal.js";
          adoptionFixture = await prepareInstalledNativeManagedTaskAdoptionFixture({ installed, componentFixture,
            legacyChatStore, legacyGoal: { path: join(writerRoot, goalMember),
              sha256: createHash("sha256").update(execFileSync("unzip", ["-p", fixture.legacyVsix, goalMember], { env })).digest("hex") },
          });
        } else {
          taskFixture = await prepareInstalledNativeManagedTaskFixture({ installed, componentFixture, legacyChatStore });
        }
      }
      if (fixture.nativeMemory) {
        const member = "extension/dist/chat/api-chat-store.js";
        const moduleRoot = join(writerRoot, "extension/modules/pkm-memory-engine/src");
        const files = Object.fromEntries(["__init__", "engine", "memory"].map(name => {
          const path = `pkm_memory_engine/${name}.py`;
          const bytes = execFileSync("unzip", ["-p", fixture.legacyVsix,
            `extension/modules/pkm-memory-engine/src/${path}`], { env });
          return [path, createHash("sha256").update(bytes).digest("hex")];
        }));
        memoryFixture = await prepareInstalledNativeMemoryFixture({ installed, componentFixture,
          legacyChatStore: { path: join(writerRoot, member),
            sha256: createHash("sha256").update(execFileSync("unzip", ["-p", fixture.legacyVsix, member], { env })).digest("hex") },
          memoryEngine: { python, moduleRoot, files },
        });
      }
    }
    const actionFixture = fixture.nativeActionBusiness || fixture.nativeActionProgram
      ? await (fixture.nativeActionProgram ? prepareInstalledNativeActionProgramFixture : prepareInstalledNativeActionFixture)({
      root, installed, componentFixture, legacyVsix: fixture.legacyVsix,
    }) : undefined;
    const recipeFixture = fixture.nativeRecipe ? await prepareInstalledNativeRecipeFixture({
      installed, componentFixture, legacyVsix: fixture.legacyVsix, python,
    }) : undefined;
    const roomFixture = fixture.nativeRoomLive ? await prepareInstalledNativeRoomLiveFixture({
      root, installed, componentFixture, legacyVsix: fixture.legacyVsix,
      credentialPreparation: roomLiveCredentialPreparation, python,
    }) : fixture.nativeRoom ? await prepareInstalledNativeRoomFixture({
      root, installed, componentFixture, legacyVsix: fixture.legacyVsix, credentialIntent: roomCredentialIntent, python,
    }) : undefined;
    const knowledgeFixture = fixture.nativeKnowledgeMove && !fixture.nativeSkillBasic ? await (fixture.nativeActionPure
      ? prepareInstalledNativeActionPureFixture : fixture.nativeKnowledgeRecovery
      ? prepareInstalledNativeKnowledgeRecovery : fixture.nativeResearchBasic
      ? prepareInstalledNativeResearchBasicFixture : fixture.nativeNotePaperBasic
      ? prepareInstalledNativeNotePaperBasicFixture : fixture.nativeSkillPaperTrash
      ? prepareInstalledNativeSkillPaperTrashFixture : fixture.nativeTodoRecovery
      ? prepareInstalledNativeTodoRecoveryFixture : fixture.nativeTodoLifecycle
      ? prepareInstalledNativeTodoLifecycleFixture : fixture.nativeTodoGenesis
      ? prepareInstalledNativeTodoGenesisFixture : fixture.nativeOriginalTrashLifecycle
      ? prepareInstalledNativeTrashLifecycleFixture : fixture.nativeOriginalTrash
      ? prepareInstalledNativeTrashFixture : fixture.nativePrivateInplace
      ? prepareInstalledNativePrivateInplaceFixture : fixture.nativePrivateResourceRecovery
      ? prepareInstalledNativePrivateResourceRecoveryFixture : fixture.nativePrivateResourceLifecycle
      ? prepareInstalledNativePrivateResourceLifecycleFixture : fixture.nativePrivateResourcePublication
      ? prepareInstalledNativePrivateResourcePublicationFixture : fixture.nativeSharedLegacyAssetsMove
        ? prepareInstalledNativeSharedLegacyAssetsMoveFixture : fixture.nativeLegacyAssetsMove
        ? prepareInstalledNativeLegacyAssetsMoveFixture : prepareInstalledNativeKnowledgeMoveFixture)({
      installed, componentFixture, legacyVsix: fixture.legacyVsix, python,
      heldOldParser: fixture.heldOldParser, heldOldPrivateParser: fixture.heldOldPrivateParser,
      ...(recoveryMount ? { mount: recoveryMount } : {}),
    }) : undefined;
    const heldTrashParser = fixture.nativeSkillPaperTrash ? await prepareInstalledHeldTrashParser({
      directory: componentFixture.directory, heldOldTrashParser: fixture.heldOldTrashParser, python,
    }) : undefined;
    const trashFaultController = fixture.nativeOriginalTrashLifecycle
      ? await createInstalledNativeTrashLifecycleFaultController(knowledgeFixture) : undefined;
    const todoFaultController = fixture.nativeTodoRecovery
      ? createInstalledNativeTodoRecoveryFaultController(knowledgeFixture) : undefined;
    endpoint = join(nativeHome, `.pkm-cold-ipc-${randomUUID().slice(0, 8)}`);
    await mkdir(endpoint, { mode: 0o700 });
    const bootstrapOptions = {
      operatorId: "isolated-genuine-native-component", profileSha256: first.result.profileSha256,
      limits: { maxEntries: 30000, maxDepth: 32, maxBytes: 1073741824, maxFileBytes: 536870912 },
      attachment: { directory: endpoint, identity: JSON.parse(first.publicRecord), identitySha256: first.result.sha256,
        payloadBuildId, hostEntrySha256: createHash("sha256").update(await readFile(join(installed, "dist/extension.cjs"))).digest("hex") },
      ...(trashFaultController ? { experimentalTrashFaultInjector: installedNativeTrashLifecycleFaultInjector(trashFaultController) } : {}),
      ...(todoFaultController ? { experimentalTodoGenesisFaultInjector: installedNativeTodoRecoveryFaultInjector(todoFaultController) } : {}),
      ...(memoryFixture || assignmentFixture || taskFixture || adoptionFixture ? { nativeModels: {
        toolCatalog: taskFixture || adoptionFixture ? installedNativeManagedTaskModelFixture.toolCatalog
          : assignmentFixture ? installedNativeTodoAssignmentModelFixture.toolCatalog
          : [{ name: "get_document", operation: "knowledge.document.get", approvalRequired: true }],
      } } : {}),
    };
    await waitForColdQuiescence("b0");
    component = actionFixture ? await bootstrapInstalledNativeActionComponent({
      ...bootstrapOptions, sourceFixture: actionFixture, python, env, port: fixture.port, payloadBuildId,
    }) : await api.bootstrapOriginalMcpColdComponent(componentFixture, bootstrapOptions);
    const initialLease = { ...component.owner.workspaceLease() };
    await writeFile(join(dirname(first.result.path), "original-mcp-native-bootstrap.json"), JSON.stringify({
      schema: "pkm.original-mcp-native-bootstrap/v1", descriptorPath: component.attachmentDescriptorPath,
      descriptorSha256: component.attachmentDescriptorSha256, profileSha256: first.result.profileSha256,
    }), { mode: 0o600 });
    const coldFixture = { ...fixture, coldComponent: { root: component.root },
      ...(memoryFixture ? { nativeMemoryProvider: installedNativeMemoryProviderOptions(memoryFixture, root) } : {}),
      ...(taskFixture ? { nativeManagedTaskProvider: installedNativeManagedTaskProviderOptions(taskFixture, root) } : {}),
      ...(adoptionFixture ? { nativeManagedTaskAdoptionProvider:
        installedNativeManagedTaskAdoptionProviderOptions(adoptionFixture, root) } : {}),
    };
    const path = join(root, "cold-fixture.json");
    await writeFile(path, JSON.stringify(coldFixture));
    const progress = async stage => writeFile(join(root, "progress.json"), JSON.stringify({ stage }));
    await progress("native-cold-attach");
    const completion = component.complete();
    app = spawn(editor, [join(root, "editor"), ...cliArgs, `--extensionDevelopmentPath=${short}/driver`,
      "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry", "--disable-updates",
      "--skip-welcome", "--skip-release-notes", "--password-store=basic",
      "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=127.0.0.1",
      `--remote-debugging-port=${fixture.port}`, "--remote-allow-origins=http://127.0.0.1"], {
      env: { ...env, ...roomCallerEnvironment, PKM_HOST_INSTALLED_FIXTURE: JSON.stringify(coldFixture) }, stdio: "inherit",
    });
    const appDone = new Promise((resolve, reject) => {
      app.once("error", reject);
      app.once("exit", code => code === 0 ? resolve() : reject(new Error(`Cold native editor exited ${code}`)));
    });
    ui = spawn(python, ["-B", uiScript, path], { env, stdio: "inherit" });
    const uiDone = new Promise((resolve, reject) => {
      ui.once("error", reject);
      ui.once("exit", code => code === 0 ? resolve() : reject(new Error(`Cold native UI failed: ${code}`)));
    });
    const deadline = setTimeout(() => { app.kill("SIGTERM"); ui.kill("SIGTERM"); }, 180000);
    const operations = (async () => {
      await completion;
      if (fixture.nativePrivateResourcePublication) {
        const sourceOnlyHost = await component.complete();
        assert.equal(sourceOnlyHost.nativeChat, undefined);
        for (const provider of ["vscode", "openai-compatible", "azure-openai"])
          assert.equal(sourceOnlyHost.options.providerTransport.supports(provider), false);
      }
      const full = await component.owner.ensureFull();
      assert.equal(full.storage, component.storage);
      assert.deepEqual(component.owner.workspaceLease(), initialLease);
      await progress("native-cold-note-deny");
      await assert.rejects(component.invoke("update_note", { slug: "Entry", content: "Denied cold mutation." }),
        error => error.code === "ACCESS_DENIED");
      assert.equal(await readFile(join(component.root, "notes/Entry.md"), "utf8"), original);
      await progress("native-cold-note-write");
      await component.invoke("update_note", { slug: "Entry", content: "Approved genuine cold Note mutation." });
      await progress("native-cold-skill-create");
      await component.invoke("add_skill", { name: "Created", content: "Genuine cold Skill creation." });
      const readResult = response => {
        assert.notEqual(response.isError, true, JSON.stringify(response));
        return response.structuredContent ?? JSON.parse(response.content[0].text);
      };
      let basicCreated;
      if (fixture.nativeSkillBasic) {
        await progress("native-cold-skill-create-read");
        basicCreated = readResult(await component.invoke("get_skill", { name: "Created" }));
        assert.equal(basicCreated.content, "Genuine cold Skill creation.");
      }
      await progress("native-cold-skill-update");
      await component.invoke("update_skill", { name: "Created", content: "Genuine cold Skill revision." });
      let skillBasicEvidence;
      if (fixture.nativeSkillBasic) {
        await progress("native-cold-skill-read");
        const updated = readResult(await component.invoke("get_skill", { name: "Created" }));
        assert.equal(updated.content, "Genuine cold Skill revision.");
        await progress("native-cold-skill-overwrite");
        await component.invoke("add_skill", { name: "Created", content: "Genuine cold Skill revision. Skill overwrite sentinel." });
        const overwritten = readResult(await component.invoke("get_skill", { name: "Created" }));
        assert.equal(overwritten.content, "Genuine cold Skill revision. Skill overwrite sentinel.");
        await progress("native-cold-skill-list");
        const listed = readResult(await component.invoke("list_skills", {}));
        assert(JSON.stringify(listed).includes('"Created"'), JSON.stringify(listed));
        await progress("native-cold-skill-retrieve");
        const retrieved = readResult(await component.invoke("search_skills", {
          query: "Skill overwrite sentinel", route: "lexical", limit: 5,
        }));
        assert(JSON.stringify(retrieved).includes('"Created"'), JSON.stringify(retrieved));
        const database = component.storage.connectNative();
        let receipts;
        try { receipts = database.prepare("SELECT * FROM receipts WHERE operation IN ('knowledge.skill.create','knowledge.skill.update')").all(); }
        finally { database.close(); }
        assert.equal(receipts.length, 3);
        const createdReceipt = JSON.parse(receipts.find(row => row.operation === "knowledge.skill.create").result);
        const revisions = receipts.map(row => JSON.parse(row.result)).sort((a, b) => a.revision - b.revision);
        assert.deepEqual(revisions.map(value => value.revision), [1, 2, 3]);
        assert(revisions.every(value => value.id === createdReceipt.id));
        const updatedReceipt = revisions.at(-1);
        assert.equal(updatedReceipt.id, createdReceipt.id);
        assert.equal(updatedReceipt.revision, createdReceipt.revision + 2);
        skillBasicEvidence = { passed: true, actualNativeUi: true, createReadUpdateReadListRetrieve: true,
          retrievalRoute: "lexical", createAndUpdateReceipts: 3, stableKnowledgeId: createdReceipt.id,
          revisionBefore: createdReceipt.revision, revisionAfter: updatedReceipt.revision,
          updatedSkillSha256: updatedReceipt.sha256, operationIds: receipts.map(row => row.operation_id),
          overwriteExistingSkillQualified: true, sameNameUpsertScopeOnly: true,
          occupiedOtherIdentityReplacementQualified: false, semanticRetrievalQualified: false, fullCutoverQualified: false };
      }
      assert.match(await readFile(join(component.root, "notes/Entry.md"), "utf8"), /Approved genuine cold Note mutation/);
      assert.match(await readFile(join(component.root, "skills/Created.md"), "utf8"), /Genuine cold Skill revision/);
      const actionEvidence = actionFixture && !fixture.nativeActionProgram ? await verifyInstalledNativeAction({
        sourceFixture: actionFixture, component,
      }) : undefined;
      const programEvidence = actionFixture && fixture.nativeActionProgram ? await verifyInstalledNativeActionProgram({
        sourceFixture: actionFixture, component,
      }) : undefined;
      const memoryEvidence = memoryFixture ? await verifyInstalledNativeMemory({
        root, installed, component, sourceFixture: memoryFixture, payloadBuildId,
        python, env, port: fixture.port,
      }) : undefined;
      const workerEvidence = workerFixture ? await verifyInstalledNativeTodoWorker({
        root, installed, component, host: await component.complete(), workerFixture,
        python, env, port: fixture.port, payloadBuildId,
      }) : undefined;
      const recipeEvidence = recipeFixture ? await verifyInstalledNativeRecipe({
        root, installed, component, sourceFixture: recipeFixture,
        python, env, port: fixture.port, payloadBuildId,
      }) : undefined;
      const assignmentEvidence = assignmentFixture ? await verifyInstalledNativeTodoAssignment({
        root, installed, component, assignmentFixture,
        python, env, port: fixture.port, payloadBuildId,
      }) : undefined;
      const taskEvidence = taskFixture ? await verifyInstalledNativeManagedTask({
        root, installed, component, taskFixture, payloadBuildId,
        python, env, port: fixture.port,
      }) : undefined;
      const adoptionEvidence = adoptionFixture ? await verifyInstalledNativeManagedTaskAdoption({
        root, installed, component, adoptionFixture, payloadBuildId,
        python, env, port: fixture.port,
      }) : undefined;
      const sourceEvidence = sourceFixture ? await verifyInstalledNativeTodoSource({
        root, installed, component, host: await component.complete(), sourceFixture,
        python, env, port: fixture.port, payloadBuildId,
      }) : undefined;
      let roomPort;
      if (fixture.nativeRoomLive) {
        const probe = createServer();
        await new Promise((resolve, reject) => {
          probe.once("error", reject);
          probe.listen(0, "127.0.0.1", resolve);
        });
        roomPort = probe.address().port;
        await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
        roomLiveDirectory = join(nativeHome, `.rl-${randomUUID().slice(0, 8)}`);
        await mkdir(roomLiveDirectory, { mode: 0o700 });
      }
      const roomEvidence = roomFixture ? await (fixture.nativeRoomLive ? verifyInstalledNativeRoomLive : verifyInstalledNativeRoom)({
        root, installed, component, sourceFixture: roomFixture,
        python, env, port: fixture.port, payloadBuildId,
        ...(fixture.nativeRoomLive ? { roomPort, directory: roomLiveDirectory } : {}),
      }) : undefined;
      let knowledgeEvidence = knowledgeFixture ? await (fixture.nativeActionPure
        ? verifyInstalledNativeActionPure : fixture.nativeKnowledgeRecovery
        ? verifyInstalledNativeKnowledgeRecovery : fixture.nativeResearchBasic
        ? verifyInstalledNativeResearchBasic : fixture.nativeNotePaperBasic
        ? verifyInstalledNativeNotePaperBasic : fixture.nativeSkillPaperTrash
        ? verifyInstalledNativeSkillPaperTrash : fixture.nativeTodoRecovery
        ? verifyInstalledNativeTodoRecoveryPending : fixture.nativeTodoLifecycle
        ? verifyInstalledNativeTodoLifecycle : fixture.nativeTodoGenesis
        ? verifyInstalledNativeTodoGenesis : fixture.nativeOriginalTrashLifecycle
        ? verifyInstalledNativeTrashLifecycle : fixture.nativeOriginalTrash
        ? verifyInstalledNativeTrash : fixture.nativePrivateInplace
        ? verifyInstalledNativePrivateInplace : fixture.nativePrivateResourceRecovery
        ? verifyInstalledNativePrivateResourceRecoveryEnospc : fixture.nativePrivateResourceLifecycle
        ? verifyInstalledNativePrivateResourceLifecycle : fixture.nativePrivateResourcePublication
        ? verifyInstalledNativePrivateResourcePublication : fixture.nativeSharedLegacyAssetsMove
          ? verifyInstalledNativeSharedLegacyAssetsMove : fixture.nativeLegacyAssetsMove
          ? verifyInstalledNativeLegacyAssetsMove : verifyInstalledNativeKnowledgeMove)({
        root, installed, component, sourceFixture: knowledgeFixture,
        payloadBuildId, python, env, port: fixture.port,
        ...(todoFaultController ? { faultController: todoFaultController } : {}),
        ...(fixture.nativePrivateResourceLifecycle ? { timeoutMs: 300000 } : {}),
      }) : undefined;
      const heldTrashParserProof = fixture.nativeSkillPaperTrash
        ? heldTrashParser ? { performed: true, ...await verifyInstalledHeldTrashParser(heldTrashParser, {
          sourceFixture: knowledgeFixture, noteV1Control: installedNativeSkillPaperTrashNoteSchemaControl(knowledgeFixture),
        }) } : { performed: false, reason: "An explicit held Trash-parser archive was not requested." }
        : undefined;
      if (trashFaultController) {
        const pending = await verifyInstalledNativeTrashLifecyclePending({
          root, installed, component, sourceFixture: knowledgeFixture, payloadBuildId,
          python, env, port: fixture.port, faultController: trashFaultController,
        });
        knowledgeEvidence = { ...knowledgeEvidence, pending };
      }
      await component.close();
      componentClosed = true;
      const todoStoppedPin = fixture.nativeTodoLifecycle
        ? await pinInstalledNativeTodoLifecycleStopped(knowledgeFixture, component) : undefined;
      const skillPaperStoppedCoreSha256 = fixture.nativeSkillPaperTrash
        ? createHash("sha256").update(await readFile(join(component.root, "core.sqlite"))).digest("hex") : undefined;
      const notePaperStoppedCoreSha256 = fixture.nativeNotePaperBasic
        ? createHash("sha256").update(await readFile(join(component.root, "core.sqlite"))).digest("hex") : undefined;
      const researchStoppedCoreSha256 = fixture.nativeResearchBasic
        ? createHash("sha256").update(await readFile(join(component.root, "core.sqlite"))).digest("hex") : undefined;
      const knowledgeRecoveryStoppedCoreSha256 = fixture.nativeKnowledgeRecovery
        ? createHash("sha256").update(await readFile(join(component.root, "core.sqlite"))).digest("hex") : undefined;
      const actionPureStoppedCoreSha256 = fixture.nativeActionPure
        ? createHash("sha256").update(await readFile(join(component.root, "core.sqlite"))).digest("hex") : undefined;
      await writeFile(join(root, "cold-component-effects-passed.json"), JSON.stringify({
        passed: true, noteAndSkillActualEffects: true, componentClosed: true,
        ...(skillBasicEvidence ? { nativeSkillBasic: skillBasicEvidence } : {}),
        ...(sourceEvidence ? { nativeTodoSource: sourceEvidence } : {}),
        ...(actionEvidence ? { nativeActionBusiness: actionEvidence } : {}),
        ...(programEvidence ? { nativeActionProgram: programEvidence } : {}),
        ...(memoryEvidence ? { nativeMemory: memoryEvidence } : {}),
        ...(workerEvidence ? { nativeTodoWorker: workerEvidence } : {}),
        ...(recipeEvidence ? { nativeRecipe: recipeEvidence } : {}),
        ...(assignmentEvidence ? { nativeTodoAssignment: assignmentEvidence } : {}),
        ...(taskEvidence ? { nativeManagedTask: taskEvidence } : {}),
        ...(adoptionEvidence ? { nativeManagedTaskAdoption: adoptionEvidence } : {}),
        ...(knowledgeEvidence ? fixture.nativeActionPure
          ? { nativeActionPure: knowledgeEvidence, nativeModelChannelUnavailable: true }
          : fixture.nativeKnowledgeRecovery
          ? { nativeKnowledgeRecovery: knowledgeEvidence, nativeModelChannelUnavailable: true }
          : fixture.nativeResearchBasic
          ? { nativeResearchBasic: knowledgeEvidence, nativeModelChannelUnavailable: true }
          : fixture.nativeNotePaperBasic
          ? { nativeNotePaperBasic: knowledgeEvidence, nativeModelChannelUnavailable: true }
          : fixture.nativeSkillPaperTrash
          ? { nativeSkillPaperTrash: knowledgeEvidence, heldTrashParser: heldTrashParserProof, nativeModelChannelUnavailable: true }
          : fixture.nativeTodoRecovery
          ? { nativeTodoRecoveryPending: knowledgeEvidence, nativeModelChannelUnavailable: true }
          : fixture.nativeTodoLifecycle
          ? { nativeTodoLifecycle: knowledgeEvidence, todoStoppedPin, nativeModelChannelUnavailable: true }
          : fixture.nativeTodoGenesis
          ? { nativeTodoGenesis: knowledgeEvidence, nativeModelChannelUnavailable: true }
          : fixture.nativeOriginalTrashLifecycle
          ? { nativeOriginalTrashLifecycle: knowledgeEvidence, nativeModelChannelUnavailable: true }
          : fixture.nativeOriginalTrash
          ? { nativeOriginalTrash: knowledgeEvidence, nativeModelChannelUnavailable: true }
          : fixture.nativePrivateInplace
          ? { nativePrivateInplace: knowledgeEvidence, nativeModelChannelUnavailable: true }
          : fixture.nativePrivateResourceRecovery
          ? { nativePrivateResourceRecoveryEnospc: knowledgeEvidence, nativeModelChannelUnavailable: true }
          : fixture.nativePrivateResourceLifecycle
          ? { nativePrivateResourceLifecycle: knowledgeEvidence, nativeModelChannelUnavailable: true }
          : fixture.nativePrivateResourcePublication
          ? { nativePrivateResourcePublication: knowledgeEvidence, nativeModelChannelUnavailable: true }
          : fixture.nativeSharedLegacyAssetsMove
          ? { nativeSharedLegacyAssetsMove: knowledgeEvidence } : fixture.nativeLegacyAssetsMove
            ? { nativeLegacyAssetsMove: knowledgeEvidence } : { nativeKnowledgeMove: knowledgeEvidence } : {}),
        ...(roomEvidence ? fixture.nativeRoomLive ? { nativeRoomLive: roomEvidence } : { nativeRoom: roomEvidence } : {}),
      }));
      await progress("native-cold-effects-complete");
      await Promise.all([appDone, uiDone]);
      assert.equal(app.exitCode, 0, "The complete actual editor must exit before B1 preservation or retirement.");
      clearTimeout(deadline);
      let todoRecoveryEvidence, todoStoppedCoreSha256;
      if (fixture.nativeTodoRecovery) {
        const { verifyInstalledNativeTodoRecoveryLifecycle } = await import("./installed-native-todo-recovery-runner.mjs");
        todoRecoveryEvidence = await verifyInstalledNativeTodoRecoveryLifecycle({
          root, fixture: coldFixture, installed, payloadBuildId, sourceFixture: knowledgeFixture, first,
          editor, cliArgs, env, short, python, uiScript, nativeHome, stop,
        });
        todoStoppedCoreSha256 = createHash("sha256").update(await readFile(join(component.root, "core.sqlite"))).digest("hex");
      }
      let trashRecoveryEvidence;
      if (fixture.nativeOriginalTrashLifecycle) {
        const { verifyInstalledNativeTrashRecoveryLifecycle } = await import("./installed-native-trash-recovery-runner.mjs");
        trashRecoveryEvidence = await verifyInstalledNativeTrashRecoveryLifecycle({
          root, fixture: coldFixture, installed, payloadBuildId, sourceFixture: knowledgeFixture, first,
          editor, cliArgs, env, short, python, uiScript, nativeHome, stop,
        });
      }
      let privateRecoveryEvidence;
      if (fixture.nativePrivateResourceRecovery) {
        const decisions = [];
        for (const decision of ["deny", "approve"]) {
          await waitForColdQuiescence(`recovery-${decision}`);
          const directory = join(nativeHome, `.pr-ipc-${randomUUID().slice(0, 8)}`);
          await mkdir(directory, { mode: 0o700 });
          recoveryEndpoints.push(directory);
          recoveryEpoch = await reopenInstalledNativePrivateResourceRecovery({
            installed, sourceFixture: knowledgeFixture,
            attachment: { directory, identity: JSON.parse(first.publicRecord), identitySha256: first.result.sha256,
              payloadBuildId, hostEntrySha256: bootstrapOptions.attachment.hostEntrySha256 },
          });
          const bootstrap = recoveryEpoch.bootstrap;
          await writeFile(join(dirname(first.result.path), "original-mcp-native-bootstrap.json"), JSON.stringify({
            schema: "pkm.original-mcp-native-bootstrap/v1", descriptorPath: bootstrap.attachmentDescriptorPath,
            descriptorSha256: bootstrap.attachmentDescriptorSha256, profileSha256: first.result.profileSha256,
          }), { mode: 0o600 });
          const epochFixture = { ...coldFixture, nativePrivateResourceRecoveryEpoch: decision };
          const epochPath = join(root, `private-recovery-${decision}-fixture.json`);
          await writeFile(epochPath, JSON.stringify(epochFixture));
          await progress(`native-recovery-${decision}-attach`);
          app = spawn(editor, [join(root, "editor"), ...cliArgs, `--extensionDevelopmentPath=${short}/driver`,
            "--disable-gpu", "--disable-dev-shm-usage", "--disable-telemetry", "--disable-updates",
            "--skip-welcome", "--skip-release-notes", "--password-store=basic",
            "--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=127.0.0.1",
            `--remote-debugging-port=${fixture.port}`, "--remote-allow-origins=http://127.0.0.1"], {
            env: { ...env, PKM_HOST_INSTALLED_FIXTURE: JSON.stringify(epochFixture) }, stdio: "inherit",
          });
          const epochApp = app, epochAppDone = new Promise((resolve, reject) => {
            epochApp.once("error", reject);
            epochApp.once("exit", code => code === 0 ? resolve() : reject(new Error(`Recovery ${decision} editor exited ${code}`)));
          });
          ui = spawn(python, ["-B", uiScript, epochPath], { env, stdio: "inherit" });
          const epochUi = ui, epochUiDone = new Promise((resolve, reject) => {
            epochUi.once("error", reject);
            epochUi.once("exit", code => code === 0 ? resolve() : reject(new Error(`Recovery ${decision} UI failed: ${code}`)));
          });
          const epochDeadline = setTimeout(() => { epochApp.kill("SIGTERM"); epochUi.kill("SIGTERM"); }, 180000);
          const epochWork = (async () => {
            const evidence = await verifyInstalledNativePrivateResourceRecoveryEpoch({
              root, installed, sourceFixture: knowledgeFixture, epoch: recoveryEpoch, decision,
              payloadBuildId, python, env, port: fixture.port,
            });
            await closeInstalledNativePrivateResourceRecoveryEpoch(recoveryEpoch);
            recoveryEpoch = undefined;
            decisions.push(evidence);
            await writeFile(join(root, `native-recovery-${decision}-effects.json`),
              JSON.stringify({ passed: true, decision, epochClosed: true }), { mode: 0o600, flag: "wx" });
            await progress(`native-recovery-${decision}-complete`);
          })();
          const epochResults = await Promise.allSettled([epochWork, epochAppDone, epochUiDone]);
          clearTimeout(epochDeadline);
          const rejected = epochResults.filter(result => result.status === "rejected").map(result => result.reason);
          if (rejected.length) throw new AggregateError(rejected, `Private recovery ${decision} epoch failed.`);
          assert.equal(epochApp.exitCode, 0, "The complete prior editor must exit before the next recovery epoch.");
        }
        privateRecoveryEvidence = { passed: true, environmentFaultInjection: true, enospc: knowledgeEvidence,
          denial: decisions[0], approval: decisions[1], actualPendingPrivateRecoveryQualified: true,
          completeEditorExitBetweenEpochs: true, fullCutoverQualified: false };
      }
      await waitForColdQuiescence("b1");
      ticket = actionFixture ? await preserveInstalledNativeActionB1(component)
        : await api.preserveOriginalMcpColdComponentB1(component);
      const preserved = { entries: ticket.entries, bytes: ticket.bytes, sqliteChecks: ticket.sqliteChecks,
        ...(fixture.nativeTodoGenesis || fixture.nativeTodoLifecycle || fixture.nativeTodoRecovery || fixture.nativeSkillPaperTrash || fixture.nativeNotePaperBasic || fixture.nativeResearchBasic || fixture.nativeKnowledgeRecovery || fixture.nativeActionPure
          ? { kind: ticket.kind, b1Path: ticket.b1Path, b1Sha256: ticket.b1Sha256 } : {}) };
      const retirement = await api.retireOriginalMcpColdComponent(ticket);
      ticket = undefined;
      if (knowledgeFixture) await (fixture.nativeActionPure
        ? verifyInstalledNativeActionPureB1 : fixture.nativeKnowledgeRecovery
        ? verifyInstalledNativeKnowledgeRecoveryB1 : fixture.nativeResearchBasic
        ? verifyInstalledNativeResearchBasicB1 : fixture.nativeNotePaperBasic
        ? verifyInstalledNativeNotePaperBasicB1 : fixture.nativeSkillPaperTrash
        ? verifyInstalledNativeSkillPaperTrashB1 : fixture.nativeTodoRecovery
        ? verifyInstalledNativeTodoRecoveryB1 : fixture.nativeTodoLifecycle
        ? verifyInstalledNativeTodoLifecycleB1 : fixture.nativeTodoGenesis
        ? verifyInstalledNativeTodoGenesisB1 : fixture.nativeOriginalTrashLifecycle
        ? verifyInstalledNativeTrashLifecycleB1 : fixture.nativeOriginalTrash
        ? verifyInstalledNativeTrashB1 : fixture.nativePrivateInplace
        ? verifyInstalledNativePrivateInplaceB1 : fixture.nativePrivateResourceRecovery
        ? verifyInstalledNativePrivateResourceRecoveryB1 : fixture.nativePrivateResourceLifecycle
        ? verifyInstalledNativePrivateResourceLifecycleB1 : fixture.nativePrivateResourcePublication
        ? verifyInstalledNativePrivateResourcePublicationB1 : fixture.nativeSharedLegacyAssetsMove
          ? verifyInstalledNativeSharedLegacyAssetsMoveB1 : fixture.nativeLegacyAssetsMove
          ? verifyInstalledNativeLegacyAssetsMoveB1 : verifyInstalledNativeKnowledgeMoveB1)(knowledgeFixture,
        { retirement, b1: preserved, stoppedCoreSha256: actionPureStoppedCoreSha256 ?? knowledgeRecoveryStoppedCoreSha256 ?? researchStoppedCoreSha256 ?? notePaperStoppedCoreSha256 ?? skillPaperStoppedCoreSha256 ?? todoStoppedCoreSha256 });
      const restored = await api.restoreOriginalMcpColdComponentB0(retirement);
      if (sourceFixture) await verifyInstalledNativeTodoSourceRestored(sourceFixture, restored.root);
      if (memoryFixture) await verifyInstalledNativeMemoryRestored(memoryFixture, restored.root);
      const actionPreservation = actionFixture && !fixture.nativeActionProgram ? await verifyInstalledNativeActionRestored(
        actionFixture, { restoredRoot: restored.root, archive: retirement.archive }) : undefined;
      const programPreservation = actionFixture && fixture.nativeActionProgram ? await verifyInstalledNativeActionProgramRestored(
        actionFixture, { restoredRoot: restored.root, archive: retirement.archive }) : undefined;
      const workerPreservation = workerFixture ? await verifyInstalledNativeTodoWorkerRestored(
        workerFixture, { restoredRoot: restored.root, archive: retirement.archive }) : undefined;
      const recipePreservation = recipeFixture ? await verifyInstalledNativeRecipeRestored(
        recipeFixture, { retirement, restored }) : undefined;
      const assignmentPreservation = assignmentFixture ? await verifyInstalledNativeTodoAssignmentRestored(
        assignmentFixture, { restoredRoot: restored.root, archive: retirement.archive }) : undefined;
      const roomPreservation = roomFixture ? await (fixture.nativeRoomLive ? verifyInstalledNativeRoomLiveRestored : verifyInstalledNativeRoomRestored)(
        roomFixture, { retirement, restored }) : undefined;
      const taskPreservation = taskFixture ? await verifyInstalledNativeManagedTaskRestored(
        taskFixture, { restoredRoot: restored.root, archive: retirement.archive }) : undefined;
      const adoptionPreservation = adoptionFixture ? await verifyInstalledNativeManagedTaskAdoptionRestored(
        adoptionFixture, { restoredRoot: restored.root, archive: retirement.archive }) : undefined;
      const knowledgePreservation = knowledgeFixture ? await (fixture.nativeActionPure
        ? verifyInstalledNativeActionPureRestored : fixture.nativeKnowledgeRecovery
        ? verifyInstalledNativeKnowledgeRecoveryRestored : fixture.nativeResearchBasic
        ? verifyInstalledNativeResearchBasicRestored : fixture.nativeNotePaperBasic
        ? verifyInstalledNativeNotePaperBasicRestored : fixture.nativeSkillPaperTrash
        ? verifyInstalledNativeSkillPaperTrashRestored : fixture.nativeTodoRecovery
        ? verifyInstalledNativeTodoRecoveryRestored : fixture.nativeTodoLifecycle
        ? verifyInstalledNativeTodoLifecycleRestored : fixture.nativeTodoGenesis
        ? verifyInstalledNativeTodoGenesisRestored : fixture.nativeOriginalTrashLifecycle
        ? verifyInstalledNativeTrashLifecycleRestored : fixture.nativeOriginalTrash
        ? verifyInstalledNativeTrashRestored : fixture.nativePrivateInplace
        ? verifyInstalledNativePrivateInplaceRestored : fixture.nativePrivateResourceRecovery
        ? verifyInstalledNativePrivateResourceRecoveryRestored : fixture.nativePrivateResourceLifecycle
        ? verifyInstalledNativePrivateResourceLifecycleRestored : fixture.nativePrivateResourcePublication
        ? verifyInstalledNativePrivateResourcePublicationRestored : fixture.nativeSharedLegacyAssetsMove
          ? verifyInstalledNativeSharedLegacyAssetsMoveRestored : fixture.nativeLegacyAssetsMove
          ? verifyInstalledNativeLegacyAssetsMoveRestored : verifyInstalledNativeKnowledgeMoveRestored)(
        knowledgeFixture, { retirement, b1: preserved,
          stoppedCoreSha256: actionPureStoppedCoreSha256 ?? knowledgeRecoveryStoppedCoreSha256 ?? researchStoppedCoreSha256 ?? notePaperStoppedCoreSha256 ?? skillPaperStoppedCoreSha256 ?? todoStoppedCoreSha256,
          restored, ...(fixture.nativeResearchBasic ? { freshB0: restored } : {}) }) : undefined;
      assert.equal(await readFile(join(restored.root, "notes/Entry.md"), "utf8"), original);
      await assert.rejects(readFile(join(restored.root, "skills/Created.md")), error => error.code === "ENOENT");
      assert.match(await readFile(join(retirement.archive, "skills/Created.md"), "utf8"), /Genuine cold Skill revision/);
      if (skillBasicEvidence) {
        assert.equal(createHash("sha256").update(await readFile(join(retirement.archive, "skills/Created.md"))).digest("hex"),
          skillBasicEvidence.updatedSkillSha256);
        const preservedDatabase = new DatabaseSync(join(retirement.archive, "core.sqlite"), { readOnly: true });
        try {
          for (const operationId of skillBasicEvidence.operationIds) {
            const receipt = preservedDatabase.prepare("SELECT * FROM receipts WHERE operation_id=?").get(operationId);
            assert(receipt);
            assert.equal(JSON.parse(receipt.result).id, skillBasicEvidence.stableKnowledgeId);
          }
        } finally { preservedDatabase.close(); }
      }
      const evidence = {
        passed: true, scope: "new disposable original-layout fixture only; not production cutover",
        actualEditorFullyClosedBeforeColdBootstrap: true, sameOwnerLease: true, actualNativeUi: true,
        actualEditorFullyClosedBeforeB1: true,
        ...(skillBasicEvidence ? { nativeSkillBasic: skillBasicEvidence,
          skillBasicPreservation: { createdSkillAbsentAtFreshB0: true, updatedSkillAtB1: true } } : {}),
        coldQuiescence: quiescence,
        noteDenialNoWrite: true, noteAndSkillActualEffects: true, b1: preserved,
        typedRetirement: true, originalRootOverwritten: restored.originalRootOverwritten,
        b0FreshRootRestored: restored.newRootIdentity, b1ChangedSkillPreserved: true,
        fullCutoverQualified: false, actualProfileOrKeyringRestored: false,
        ...(sourceEvidence ? { nativeTodoSource: sourceEvidence } : {}),
        ...(actionEvidence ? { nativeActionBusiness: actionEvidence, actionPreservation } : {}),
        ...(programEvidence ? { nativeActionProgram: programEvidence, programPreservation } : {}),
        ...(memoryEvidence ? { nativeMemory: memoryEvidence } : {}),
        ...(workerEvidence ? { nativeTodoWorker: workerEvidence, workerPreservation } : {}),
        ...(recipeEvidence ? { nativeRecipe: recipeEvidence, recipePreservation } : {}),
        ...(assignmentEvidence ? { nativeTodoAssignment: assignmentEvidence, assignmentPreservation } : {}),
        ...(roomEvidence ? fixture.nativeRoomLive
          ? { nativeRoomLive: roomEvidence, roomLivePreservation: roomPreservation }
          : { nativeRoom: roomEvidence, roomPreservation } : {}),
        ...(taskEvidence ? { nativeManagedTask: taskEvidence, taskPreservation } : {}),
        ...(adoptionEvidence ? { nativeManagedTaskAdoption: adoptionEvidence, adoptionPreservation } : {}),
        ...(knowledgeEvidence ? fixture.nativeActionPure
          ? { nativeActionPure: knowledgeEvidence, actionPurePreservation: knowledgePreservation,
            actionPureStoppedCoreSha256, nativeModelChannelUnavailable: true }
          : fixture.nativeKnowledgeRecovery
          ? { nativeKnowledgeRecovery: knowledgeEvidence, knowledgeRecoveryPreservation: knowledgePreservation,
            knowledgeRecoveryStoppedCoreSha256, nativeModelChannelUnavailable: true }
          : fixture.nativeResearchBasic
          ? { nativeResearchBasic: knowledgeEvidence, researchBasicPreservation: knowledgePreservation,
            researchStoppedCoreSha256, nativeModelChannelUnavailable: true }
          : fixture.nativeNotePaperBasic
          ? { nativeNotePaperBasic: knowledgeEvidence, notePaperBasicPreservation: knowledgePreservation,
            notePaperStoppedCoreSha256, nativeModelChannelUnavailable: true }
          : fixture.nativeSkillPaperTrash
          ? { nativeSkillPaperTrash: knowledgeEvidence, heldTrashParser: heldTrashParserProof,
            skillPaperTrashPreservation: knowledgePreservation, skillPaperStoppedCoreSha256, nativeModelChannelUnavailable: true }
          : fixture.nativeTodoRecovery
          ? { nativeTodoRecoveryPending: knowledgeEvidence, nativeTodoRecovery: todoRecoveryEvidence,
            todoStoppedCoreSha256, todoRecoveryPreservation: knowledgePreservation, nativeModelChannelUnavailable: true }
          : fixture.nativeTodoLifecycle
          ? { nativeTodoLifecycle: knowledgeEvidence, todoStoppedPin, todoLifecyclePreservation: knowledgePreservation,
            nativeModelChannelUnavailable: true }
          : fixture.nativeTodoGenesis
          ? { nativeTodoGenesis: knowledgeEvidence, todoGenesisPreservation: knowledgePreservation,
            nativeModelChannelUnavailable: true }
          : fixture.nativeOriginalTrashLifecycle
          ? { nativeOriginalTrashLifecycle: knowledgeEvidence, originalTrashRecovery: trashRecoveryEvidence,
            originalTrashLifecyclePreservation: knowledgePreservation, nativeModelChannelUnavailable: true }
          : fixture.nativeOriginalTrash
          ? { nativeOriginalTrash: knowledgeEvidence, originalTrashPreservation: knowledgePreservation,
            nativeModelChannelUnavailable: true }
          : fixture.nativePrivateInplace
          ? { nativePrivateInplace: knowledgeEvidence, privateInplacePreservation: knowledgePreservation,
            nativeModelChannelUnavailable: true }
          : fixture.nativePrivateResourceRecovery
          ? { nativePrivateResourceRecovery: privateRecoveryEvidence, privateResourceRecoveryPreservation: knowledgePreservation,
            nativeModelChannelUnavailable: true }
          : fixture.nativePrivateResourceLifecycle
          ? { nativePrivateResourceLifecycle: knowledgeEvidence, privateResourceLifecyclePreservation: knowledgePreservation,
            nativeModelChannelUnavailable: true }
          : fixture.nativePrivateResourcePublication
          ? { nativePrivateResourcePublication: knowledgeEvidence, privateResourcePublicationPreservation: knowledgePreservation,
            nativeModelChannelUnavailable: true }
          : fixture.nativeSharedLegacyAssetsMove
          ? { nativeSharedLegacyAssetsMove: knowledgeEvidence, sharedLegacyAssetsPreservation: knowledgePreservation }
          : fixture.nativeLegacyAssetsMove
            ? { nativeLegacyAssetsMove: knowledgeEvidence, legacyAssetsPreservation: knowledgePreservation }
            : { nativeKnowledgeMove: knowledgeEvidence, knowledgePreservation } : {}),
      };
      await writeFile(join(root, "cold-component-passed.json"), JSON.stringify(evidence));
      await progress("native-cold-restored");
    })().catch(async error => {
      const errors = [error];
      try {
        await writeFile(join(root, "progress.json"), JSON.stringify({
          stage: "failed", error: "Cold native component verification failed; inspect the retained component error.",
        }));
      } catch (notificationError) {
        errors.push(notificationError);
      }
      for (const result of await Promise.allSettled([stop(ui), stop(app)]))
        if (result.status === "rejected") errors.push(result.reason);
      if (errors.length > 1)
        throw new AggregateError(errors, "Cold component verification, failure notification or child shutdown failed.");
      throw error;
    });
    const results = await Promise.allSettled([operations, appDone, uiDone]);
    clearTimeout(deadline);
    for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, "Cold installed native component failed.");
    passed = true;
    return await waitJson(join(root, "cold-component-passed.json"));
  } finally {
    for (const close of [() => stop(ui), () => stop(app), () => ticket?.close(),
      async () => { if (recoveryEpoch) { await closeInstalledNativePrivateResourceRecoveryEpoch(recoveryEpoch); recoveryEpoch = undefined; } },
      async () => {
      if (component) { await component.close(); componentClosed = true; }
    }])
      try { await close(); } catch (error) { failures.push(error); }
    if (endpoint && (!component || componentClosed))
      try { await rm(endpoint, { recursive: true }); } catch (error) { failures.push(error); }
    if (roomLiveDirectory && componentClosed)
      try { await rm(roomLiveDirectory, { recursive: true }); } catch (error) { failures.push(error); }
    for (const directory of recoveryEndpoints)
      if (!recoveryEpoch) try { await rm(directory, { recursive: true }); } catch (error) { failures.push(error); }
    if (recoveryMount && (!component || componentClosed) && !recoveryEpoch) {
      if (!passed && componentFixture)
        try { await cp(componentFixture.directory, join(root, "private-recovery-failure-evidence"),
          { recursive: true, force: false, errorOnExist: true }); } catch (error) { failures.push(error); }
      try { await releaseInstalledNativePrivateResourceRecoveryMount(recoveryMount); } catch (error) { failures.push(error); }
      componentFixture = undefined;
    }
    if (passed && !failures.length && componentFixture)
      try { await rm(componentFixture.directory, { recursive: true }); } catch (error) { failures.push(error); }
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (failures.length) throw new AggregateError(failures, "Cold component cleanup or verification failed; retain private evidence.");
  }
}
