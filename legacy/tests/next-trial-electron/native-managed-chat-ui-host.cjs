"use strict";
const fs = require("node:fs"), path = require("node:path"), { pathToFileURL } = require("node:url");
const assert = require("node:assert/strict"), { createHash } = require("node:crypto");
async function main() {
  const [fixture, root, extension, nonce] = process.argv.slice(2);
  assert.equal(fs.realpathSync(root), path.join(fs.realpathSync(fixture), "knowledge"));
  assert.equal(fs.readFileSync(path.join(fixture, "native-ui-fixture-token"), "utf8"), nonce);
  assert.equal(process.env.PKM_NATIVE_UI_PRIVATE_FIXTURE, nonce);
  const config = JSON.parse(fs.readFileSync(path.join(fixture, "native-managed-host.json")));
  assert.equal(config.root, root); assert.equal(config.nonce, nonce);
  const load = name => import(pathToFileURL(path.join(extension, "next-runtime/server/dist", `${name}.js`)).href);
  const { Storage } = await load("storage"), { createNativeRuntime } = await load("native-runtime");
  const { startLegacyApiChatUiHost } = await load("legacy-api-chat-ui-host");
  const { createLegacyManagedChatLocalModel } = await load("legacy-api-chat-managed-provider");
  const { ChatTurnToolError } = await load("chat-turn");
  const storage = await Storage.open(root, { deferRecovery: true });
  let native, ui, memory, recipes, lazy, pythonComposition, publicRecipes, publicHttp, publicMcp, stopping, recipeKnowledgeDatabase,
    recipeHost, reflectionSkills;
  const close = () => stopping ??= (async () => {
    try { await reflectionSkills?.close(); await publicMcp?.close();
      if (publicHttp) { publicHttp.server.closeAllConnections(); await new Promise(resolve => publicHttp.server.close(resolve)); }
      await ui?.close(); } finally {
      try { await memory?.close(); } finally {
        try { await pythonComposition?.close(); } finally {
          if (recipeHost) recipeHost.close(); else { lazy?.close(); recipes?.close(); }
          recipeKnowledgeDatabase?.close();
          try { await native?.close(); } finally { await storage.close(); }
        }
      }
    }
  })();
  try {
    assert.equal(await storage.workspaceId(), config.workspaceId);
    const base = async binding => binding.root === root && binding.actorId === config.actorId
      && binding.workspaceId === config.workspaceId && binding.sourceFingerprint === config.sourceFingerprint
      && fs.readFileSync(path.join(fixture, "native-ui-fixture-token"), "utf8") === nonce;
    const authorize = async binding => await base(binding)
      && binding.chatId === config.chat.chatId && binding.namespace === config.chat.namespace;
    if (config.recipeReflectionGates) {
      const { composeLegacyRecipeHost } = await load("legacy-recipe-host");
      const { canonicalJson } = await load("domain/project-recipes-workflow-contracts");
      const binding = { ...config.chat, root, workspaceId: config.workspaceId, actorId: config.actorId,
        sourceFingerprint: config.sourceFingerprint };
      recipeHost = await composeLegacyRecipeHost(storage, {
        ...config.chat, actorId: config.actorId, sourceFingerprint: config.sourceFingerprint, authorize,
        externalReports: require("./native-recipe-reflection-gate-installed-fixture.cjs").policy({ fixture, binding, canonicalJson }),
      });
      recipes = recipeHost.recipes; publicRecipes = recipeHost.publicApi;
    }
    if (config.chatRecipe && !config.recipeReflectionGates) {
      const { LegacyApiChatRecipes } = await load("legacy-api-chat-recipes");
      const { canonicalJson, compileWorkflowDefinitionV1 } = await load("domain/project-recipes-workflow-contracts");
      const evidence = JSON.parse(fs.readFileSync(path.join(fixture, "original-recipe-evidence.json")));
      const compiled = compileWorkflowDefinitionV1(evidence.definition);
      assert.equal(compiled.ok, true);
      const trusted = require("./trusted-local-recipe-adapter.cjs").create({ fixture, nonce, actorId: config.actorId,
        recipeId: evidence.recipeId, executableDigest: evidence.recipeExecutableDigest, definition: compiled.model,
        inputSha256: evidence.inputSha256, canonicalJson,
        allowNativeCopies: !!config.recipeLibrary,
        onHeld: value => {
          fs.writeFileSync(path.join(fixture, `native-recipe-held-${value.runId}.json`), JSON.stringify(value),
            { flag: "wx", mode: 0o600 });
          process.send({ type: "actual-recipe-held", ...value });
        } });
      if (config.recipePython) pythonComposition = await require("./native-python-recipe-host.cjs").create({
        fixture, extension, storage, recipes: () => recipes,
        binding: { ...config.chat, root, workspaceId: config.workspaceId, actorId: config.actorId, sourceFingerprint: config.sourceFingerprint },
        recover: config.recipePythonRecover === true,
        jobCreated(runId, jobId, phase) { process.send({ type: "actual-python-recipe-job", runId, jobId, phase }); },
      });
      let knowledgeDocuments;
      if (config.recipeKnowledgeDocumentIds !== undefined) {
        assert(Array.isArray(config.recipeKnowledgeDocumentIds));
        const documentIds = Object.freeze([...config.recipeKnowledgeDocumentIds]);
        const { readIndexedRecipeKnowledgeDocuments } = await load("recipe-knowledge-reader");
        recipeKnowledgeDatabase = storage.connectNative();
        knowledgeDocuments = () => readIndexedRecipeKnowledgeDocuments({ root, database: recipeKnowledgeDatabase,
          documentIds, assertLease: () => storage.assertWorkspaceLease() });
      }
      const recipeAdapters = knowledgeDocuments ? Object.fromEntries(Object.entries(trusted.adapters).map(([key, adapter]) =>
        [key, { ...adapter, execute(invocation, context) {
          assert(invocation.recipeKnowledge, "Bound execution must receive the admitted data-only context.");
          fs.appendFileSync(path.join(fixture, "native-recipe-knowledge-context.jsonl"), JSON.stringify({
            runId: invocation.runId, nodeId: invocation.node.nodeId, context: invocation.recipeKnowledge }) + "\n", { mode: 0o600 });
          return adapter.execute(invocation, context);
        } }])) : trusted.adapters;
      recipes = new LegacyApiChatRecipes({ root, workspaceId: config.workspaceId, actorId: config.actorId,
        ...(knowledgeDocuments ? { knowledgeDocuments } : {}),
        sourceFingerprint: config.sourceFingerprint, adapters: { ...recipeAdapters, ...pythonComposition?.adapters },
        ...(config.recipeLibrary ? { library: { database: storage.connectNative(), fault(point, operationId) {
          if (config.recipeLibraryCrash === point) {
            const file = path.join(fixture, "native-recipe-library-committed.json");
            const fd = fs.openSync(file, "wx", 0o600);
            try { fs.writeSync(fd, JSON.stringify({ point, operationId })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            process.send({ type: "actual-library-commit", point, operationId });
            process.kill(process.pid, "SIGKILL");
          }
        } } } : {}),
        assertLease: () => storage.assertWorkspaceLease(),
        authorize: async (binding, operation, approval) => await authorize(binding)
          && (operation !== "create" || !pythonComposition?.usesPython(approval)
            || pythonComposition.authorizeCreate(binding, approval) === true) });
    }
    if (config.recipePublic && !config.recipeReflectionGates) {
      assert(recipes && config.recipeLibrary);
      const { NativeRecipePublicApi } = await load("native-recipe-public-api");
      const binding = { ...config.chat, root,
        workspaceId: config.workspaceId, actorId: config.actorId, sourceFingerprint: config.sourceFingerprint };
      if (config.recipeLazy || config.recipeReports || config.recipeBranches) {
        const { LegacyRecipeLazyRuntime } = await load("legacy-recipe-lazy-runtime");
        const { canonicalJson } = await load("domain/project-recipes-workflow-contracts");
        const trusted = config.recipeLazy
          ? require("./controlled-lazy-recipe-fixture.cjs").adapter({ fixture, actorId: config.actorId, canonicalJson })
          : { adapters: {}, requestCancel() { throw Error("External callers have no command cancellation authority."); } };
        const externalReports = config.recipeReports || config.recipeBranches
          ? new (await load("legacy-recipe-external-reports")).LegacyRecipeExternalReports(
            require(config.recipeBranches ? "./native-recipe-branch-installed-fixture.cjs"
              : "./native-recipe-report-installed-fixture.cjs").policy({ fixture, binding, canonicalJson }))
          : undefined;
        lazy = new LegacyRecipeLazyRuntime(storage.connectNative(), {
          actorId: config.actorId, root, bindingFingerprint: createHash("sha256").update(canonicalJson(binding)).digest("hex"),
          ownerId: require("node:crypto").randomUUID(), adapters: trusted.adapters,
          catalog: () => recipes.catalog(binding), resolveRecipe: recipes.resolveRecipe,
          assertOwner: () => storage.assertWorkspaceLease(), requestCancel: trusted.requestCancel,
          ...(externalReports ? { externalReports } : {}),
        });
      }
      publicRecipes = new NativeRecipePublicApi({ recipes, uiApprovals: true, binding, ...(lazy ? { lazy } : {}) });
    }
    native = await createNativeRuntime({ storage, workspaceId: config.workspaceId,
      ...(publicRecipes ? { recipeApi: publicRecipes } : {}),
      ...(recipes ? { workflow: { adapters: recipes.adapters, leaseMs: 30000,
        ...(config.recipeLibrary ? { resolveRecipe: recipes.resolveRecipe } : {}) } } : {}) });
    if (recipeHost) {
      recipeHost.bindRuntime(native);
      reflectionSkills = await require("./native-recipe-reflection-gate-installed-fixture.cjs").startSkills({
        fixture, extension, storage, core: native.core, actor: { id: config.actorId, canWrite: true },
      });
    } else if (recipes) recipes.bindRuntime(native.core, native.services.workflow);
    if (publicRecipes) {
      const token = require("node:crypto").randomBytes(32).toString("hex"), actor = {
        id: config.actorId, canWrite: true, recipeProtocol: true };
      const { startHttp } = await load("http"), { legacyRecipeHttp } = await load("legacy-recipe-http");
      publicHttp = await startHttp(native.core, token, actor, 0, undefined, legacyRecipeHttp({
        core: native.core, actor, scope: config.chat, recipeId: () => {
          const file = path.join(fixture, "native-library-ui-state.json");
          return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)).recipeId
            : JSON.parse(fs.readFileSync(path.join(fixture, "original-recipe-evidence.json"))).recipeId;
        } }));
      publicMcp = await (await load("recipe-mcp-http")).startRecipeMcpHttp(native.core, actor, token);
      fs.writeFileSync(path.join(fixture, "native-recipe-public-endpoints.json"),
        JSON.stringify({ token, http: publicHttp.url, mcp: publicMcp.url, extension, actorId: config.actorId }), { mode: 0o600 });
    }
    if (config.chatMemory) {
      const { LegacyApiChatMemory } = await load("legacy-api-chat-memory");
      memory = await LegacyApiChatMemory.open({ root, workspaceId: config.workspaceId, actorId: config.actorId,
        sourceFingerprint: config.sourceFingerprint,
        profileStorage: path.join(fixture, "u/User/globalStorage/uone.personal-knowledge"), authorize });
    }
    const model = createLegacyManagedChatLocalModel({ endpoint: config.providerEndpoint,
      apiKey: "synthetic-fresh-managed-provider", model: "synthetic-managed-provider",
      tools: async (_actor, turnId) => {
        const scope = await ui.managed.scope(turnId);
        if (memory) return memory.catalog();
        return [{ name: "read_file", description: "Read one exact fresh synthetic fixture file.",
          parameters: { type: "object", properties: { path: { type: "string", enum: ["native-input.txt", "native-crash.txt",
            ...(config.chatWorkflows ? ["native-denied.txt"] : [])] } },
            required: ["path"], additionalProperties: false } },
        ...(!scope.parentTurnId ? [{ name: "spawn_workers", description: "Dispatch one independent read-only native worker.",
          parameters: { type: "object", properties: { tasks: { type: "array", minItems: 1, maxItems: 1,
            items: { type: "object", properties: { title: { type: "string" }, question: { type: "string" } },
              required: ["title", "question"], additionalProperties: false } } }, required: ["tasks"], additionalProperties: false } }] : [])];
      },
    });
    ui = await startLegacyApiChatUiHost({ storage, actorId: config.actorId, chats: [config.chat],
      authorize, authorizeLibrary: base, ...(memory ? { memory } : {}),
      ...(recipes ? { recipes } : {}),
      ...(publicRecipes ? { publicRecipes } : {}),
      ...(pythonComposition ? { pythonRecipes: pythonComposition.pythonRecipes } : {}),
      provider: async () => { throw new Error("Managed UI must never fall back to a text-only provider."); },
      managed: { model, authorize: async binding => await authorize(binding)
        && binding.sourceSessionId === config.sourceSessionId
        && (!binding.tool || binding.tool === "read_file" || binding.tool === "spawn_workers" && !binding.parentTurnId
          || config.chatMemory && memory.catalog().some(item => item.name === binding.tool)),
      ...(memory ? { memoryContext: (binding, request) => memory.context(binding, request) } : {}),
      ...(config.chatWorkflows || config.chatMemory ? {
        authorizeQueue: authorize,
        authorizeUserReview: async binding => {
          assert.equal(binding.userRequired, true);
          assert.equal(binding.decision, "abandon-without-replay");
          const granted = await authorize(binding);
          if (granted) fs.appendFileSync(path.join(fixture, "native-workflow-user-required.jsonl"),
            JSON.stringify({ operationId: binding.operationId, decision: binding.decision, userRequired: true }) + "\n", { mode: 0o600 });
          return granted;
        },
      } : {}),
      tools: { available: true, async execute(request) {
        if (memory) {
          const result = await memory.execute(request.binding, request);
          process.send({ type: "actual-memory-operation", name: request.call.name, operationId: request.operationId,
            result: JSON.parse(result.content) });
          if (request.call.name === "memory_record_confirm" && JSON.parse(result.content).content.includes("SATURN unacknowledged")) {
            fs.writeFileSync(path.join(fixture, "native-memory-committed-unack.json"), JSON.stringify({
              turnId: request.turnId, operationId: request.operationId, result: JSON.parse(result.content) }), { flag: "wx", mode: 0o600 });
            return new Promise(() => {});
          }
          return result;
        }
        if (request.call.name === "spawn_workers") {
          assert.equal(request.call.arguments.tasks.length, 1);
          const worker = await ui.managed.delegate(request.turnId, request.operationId, 0);
          if (worker.status !== "completed") throw new ChatTurnToolError("unknown", "CHILD_NOT_COMPLETED");
          return { executionId: request.operationId, content: JSON.stringify({
            workers: [{ id: worker.id, status: worker.status, output: worker.output }],
          }) };
        }
        assert.equal(request.call.name, "read_file");
        const name = request.call.arguments.path;
        if (config.chatWorkflows && name === "native-denied.txt") {
          fs.writeFileSync(path.join(fixture, "native-workflow-denial-observed.json"), JSON.stringify({ inputId: request.binding.inputId }), { flag: "wx", mode: 0o600 });
          const deadline = Date.now() + 20000;
          while (!fs.existsSync(path.join(fixture, "native-workflow-denial-release")) && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 25));
          assert(fs.existsSync(path.join(fixture, "native-workflow-denial-release")));
          throw new ChatTurnToolError("not-committed", "FRESH_FIXTURE_PATH_DENIED_BEFORE_FILESYSTEM_ACCESS");
        }
        assert(["native-input.txt", "native-crash.txt"].includes(name));
        const file = path.join(fixture, "workspace", name), stat = fs.lstatSync(file);
        assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid()
          && stat.size <= 65536 && (stat.mode & 0o077) === 0);
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let content;
        try {
          const opened = fs.fstatSync(fd);
          assert.equal(opened.ino, stat.ino); assert.equal(opened.dev, stat.dev);
          content = fs.readFileSync(fd, "utf8");
        } finally { fs.closeSync(fd); }
        process.send({ type: "actual-file-read", path: name, child: !!request.binding.parentTurnId,
          inputId: request.binding.inputId, sha256: createHash("sha256").update(content).digest("hex") });
        if (config.chatWorkflows && name === "native-crash.txt")
          fs.writeFileSync(path.join(fixture, "native-workflow-crash-observed.json"), JSON.stringify({ inputId: request.binding.inputId }), { flag: "wx", mode: 0o600 });
        if (config.chatWorkflows && !request.binding.parentTurnId
          && (await ui.managed.history(config.chat)).nativeTurns.find(turn => turn.id === request.binding.inputId)?.text.includes("NATIVE_WORKFLOW_STEER:")) {
          fs.writeFileSync(path.join(fixture, "native-workflow-steer-observed.json"), JSON.stringify({ inputId: request.binding.inputId }), { flag: "wx", mode: 0o600 });
          const deadline = Date.now() + 20000;
          while (!fs.existsSync(path.join(fixture, "native-workflow-steer-release")) && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 25));
          assert(fs.existsSync(path.join(fixture, "native-workflow-steer-release")));
        }
        if (name === "native-crash.txt") return new Promise(() => {});
        return { executionId: request.operationId, content: JSON.stringify({ path: name, content }) };
      } } },
    });
    process.send({ type: "ready", endpoint: ui.endpoint, bearer: ui.bearer });
    const stop = () => void close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
    process.on("message", () => {});
    process.once("SIGTERM", stop); process.once("SIGINT", stop); process.once("disconnect", stop);
  } catch (error) { await close(); throw error; }
}
main().catch(error => { console.error("PRIVATE_MANAGED_UI_REFUSED", error); process.exitCode = 1; process.disconnect?.(); });
