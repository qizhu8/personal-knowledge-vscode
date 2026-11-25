"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "../..");
const MATRIX = "tests/framework/operation-parity.json";
const ORIGINAL = "tests/fixtures/original-public-mcp-discovery.json";
const ORIGINAL_FIXTURE_SHA256 = "aba1658ee8098355cfbe08b29ae1190cba1f4b803beef723f863f9cd4a8c210e";
const ORIGINAL_METADATA_SHA256 = "696d70e87c1b56697de21d0ab545eb161fed46ae11b34fce6a1f1179198d6a21";
const ORIGINAL_REVISION = "8f4de8526bc2b4a043cfb493c180709292ed245bbf97bef8b7e9e4b4891a76a5";
const sha = value => createHash("sha256").update(value).digest("hex");
const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");
const id = name => `mcp.tool.${name}`;

function originalContracts(root) {
  const bytes = read(root, ORIGINAL);
  assert.equal(sha(bytes), ORIGINAL_FIXTURE_SHA256, "Independently pinned original discovery bytes changed");
  const fixture = JSON.parse(bytes);
  assert.equal(fixture.metadataSha256, ORIGINAL_METADATA_SHA256);
  assert.equal(fixture.producer.revision, ORIGINAL_REVISION);
  const contracts = fixture.describes.map(entry => {
    assert.equal(entry.response.isError, false);
    const contract = JSON.parse(entry.response.content.find(part => part.type === "text").text);
    assert.equal(contract.id, entry.operation);
    assert.equal(contract.id, id(contract.transportName));
    assert.equal(contract.revision, ORIGINAL_REVISION);
    return contract;
  });
  assert.equal(contracts.length, 151);
  assert.equal(new Set(contracts.map(contract => contract.id)).size, 151);
  const generated = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText() === "JSON.parse") {
      assert.equal(node.arguments.length, 1);
      assert(ts.isStringLiteral(node.arguments[0]), "Original generated metadata must remain literal data");
      generated.push(JSON.parse(node.arguments[0].text));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceTree(root, "src/native-public-original-mcp-contracts.ts"));
  assert.equal(generated.length, 1);
  assert.deepEqual(generated[0].contracts, contracts.map(({ revision, ...contract }) => contract),
    "Generated original catalog differs from the independent original oracle");
  return { fixture, contracts };
}

function sourceTree(root, file) {
  const tree = ts.createSourceFile(file, read(root, file), ts.ScriptTarget.Latest, true);
  assert.equal(tree.parseDiagnostics.length, 0, file);
  return tree;
}

// Inspect literal declarations only. Do not import dispatchers, open roots or execute fixture producers.
function literalStrings(root, file, variable) {
  const values = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText() === variable && node.initializer) {
      function strings(child) {
        if (ts.isStringLiteral(child)) values.push(child.text);
        ts.forEachChild(child, strings);
      }
      strings(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceTree(root, file));
  assert(values.length, `${file}#${variable} needs explicit parity review`);
  return values;
}

function importedLiteralStrings(root, file, local, module, exported, declarationName = exported) {
  const tree = sourceTree(root, file);
  const bindings = tree.statements.filter(node => ts.isImportDeclaration(node)
    && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === module)
    .flatMap(node => node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
      ? [...node.importClause.namedBindings.elements] : []);
  assert(bindings.some(binding => binding.name.text === local
    && (binding.propertyName ?? binding.name).text === exported),
  `${file}#${local} imported source binding needs explicit parity review`);
  const target = path.posix.join(path.posix.dirname(file), module.replace(/\.js$/, ".ts"));
  const declarations = sourceTree(root, target).statements.filter(ts.isVariableStatement)
    .filter(statement => statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
    .flatMap(statement => [...statement.declarationList.declarations])
    .filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === declarationName);
  assert.equal(declarations.length, 1, `${target}#${declarationName} must be an explicit exported declaration`);
  let initializer = declarations[0].initializer;
  if (ts.isCallExpression(initializer) && initializer.expression.getText() === "Object.freeze"
    && initializer.arguments.length === 1) initializer = initializer.arguments[0];
  if (ts.isAsExpression(initializer)) initializer = initializer.expression;
  assert(ts.isArrayLiteralExpression(initializer) && initializer.elements.every(ts.isStringLiteral),
    `${target}#${declarationName} must remain a literal tool selection`);
  const values = initializer.elements.map(element => element.text);
  assert(values.length && new Set(values).size === values.length, `${target}#${declarationName} duplicate/empty tool selection`);
  return values;
}

const compact = value => value.replace(/\s+/g, "");
function assertSourceBranch(tree, condition, call) {
  const found = [];
  function visit(node) {
    if (ts.isIfStatement(node) && compact(node.expression.getText()) === compact(condition)) {
      let matched = false;
      function branch(child) {
        if (call === undefined && ts.isReturnStatement(child) && child.expression?.getText() === "undefined") matched = true;
        if (call !== undefined && ts.isCallExpression(child) && child.expression.getText() === call) matched = true;
        ts.forEachChild(child, branch);
      }
      branch(node.thenStatement);
      assert(matched, `${tree.fileName}: ${condition} producer/readiness binding needs explicit parity review`);
      found.push(node.pos);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(found.length, 1, `${tree.fileName}: ${condition} route needs explicit parity review`);
  return found[0];
}

function assertSourceCalls(root, file, name, calls) {
  const tree = sourceTree(root, file), functions = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) functions.push(node);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(functions.length, 1, `${file}#${name} producer missing`);
  const found = new Set();
  function inspect(node) {
    if (ts.isCallExpression(node)) found.add(node.expression.getText());
    ts.forEachChild(node, inspect);
  }
  inspect(functions[0]);
  for (const call of calls) assert(found.has(call), `${file}#${name}: ${call} source/effect binding missing`);
}

function sourceFacts(root) {
  const publicFile = "src/original-mcp-public.ts";
  const knowledge = literalStrings(root, publicFile, "publicKnowledge");
  const indexed = literalStrings(root, publicFile, "indexedKnowledge");
  const state = literalStrings(root, publicFile, "stateReads");
  const action = importedLiteralStrings(root, "src/original-mcp-action-runtime.ts", "tools",
    "./original-mcp-action-tools.js", "originalMcpActionRuntimeTools");
  const authoring = importedLiteralStrings(root, publicFile, "originalMcpActionAuthoringOperationIds",
    "./original-mcp-action-tools.js", "originalMcpActionAuthoringOperationIds", "originalMcpActionAuthoringTools");
  assert.deepEqual(action, importedLiteralStrings(root, publicFile, "originalMcpActionOperationIds",
    "./original-mcp-action-tools.js", "originalMcpActionOperationIds", "originalMcpActionRuntimeTools"));
  const pureActionFile = "src/original-mcp-action-pure.ts", pureAction = [];
  function pureTools(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "originalMcpPureActionTool") {
      const statements = node.body?.statements;
      assert.equal(statements?.length, 1, "Pure Action routing needs explicit parity review");
      const expression = statements[0].expression;
      assert(ts.isReturnStatement(statements[0]) && ts.isCallExpression(expression)
        && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "includes"
        && ts.isArrayLiteralExpression(expression.expression.expression) && expression.arguments[0]?.getText() === "tool",
      "Pure Action tools must remain an explicit literal routing selection");
      assert(expression.expression.expression.elements.every(ts.isStringLiteral));
      pureAction.push(...expression.expression.expression.elements.map(element => element.text));
    }
    ts.forEachChild(node, pureTools);
  }
  pureTools(sourceTree(root, pureActionFile));
  assert(pureAction.length, "Pure Action routing selection missing");
  const pureActionComplete = literalStrings(root, pureActionFile, "originalMcpPureActionOperationIds")
    .map(operation => {
      assert(operation.startsWith("mcp.tool.") && pureAction.includes(operation.slice(9)));
      return operation.slice(9);
    });
  const publicSource = read(root, publicFile);
  assert(publicSource.includes("if (originalMcpPureActionOperationIds.includes(contract.id)) return undefined;")
    && /if \(originalMcpPureActionTool\(request\.tool\)\)\s+return result\(invokeOriginalMcpPureAction\(request\.tool, request\.arguments\)\)/.test(publicSource),
  "Pure Action readiness and dispatcher bindings need explicit review");
  const chat = literalStrings(root, "src/original-mcp-api-chat.ts", "names").map(name => `api_chat_${name}`);
  const room = literalStrings(root, "src/original-mcp-room-live-session.ts", "originalMcpRoomLivePublicTools");
  const updates = literalStrings(root, "src/original-mcp-broker.ts", "conditional").map(operation => operation.slice(9));
  const publicTree = sourceTree(root, publicFile);
  const actionToolDeclarations = sourceTree(root, "src/original-mcp-action-tools.ts").statements
    .filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]);
  for (const [ids, tools] of [["originalMcpActionAuthoringOperationIds", "originalMcpActionAuthoringTools"],
    ["originalMcpActionOperationIds", "originalMcpActionRuntimeTools"]]) {
    const declaration = actionToolDeclarations.find(node => node.name.getText() === ids);
    assert.equal(compact(declaration?.initializer?.getText() ?? ""),
      `Object.freeze(${tools}.map(tool=>\`mcp.tool.\${tool}\`))`, `${ids} derivation needs explicit parity review`);
  }
  assertSourceCalls(root, "src/original-mcp-action-tools.ts", "originalMcpActionAuthoringTool",
    ["(originalMcpActionAuthoringTools as readonly string[]).includes"]);
  assertSourceBranch(publicTree, "originalMcpActionAuthoringOperationIds.includes(contract.id)");
  assertSourceBranch(publicTree, "originalMcpActionOperationIds.includes(contract.id)");
  const authoringRoute = assertSourceBranch(publicTree, "originalMcpActionAuthoringTool(request.tool)", "dispatchOriginalMcpActionAuthoring");
  const pureRoute = assertSourceBranch(publicTree, "originalMcpPureActionTool(request.tool)", "invokeOriginalMcpPureAction");
  assert(authoringRoute < pureRoute, "Registry-aware Action authoring must precede the historical bounded pure fallback");
  assertSourceBranch(publicTree, "adapter.originalMcpActionOperationIds.some(id => id === operation.id)", "(await action).invoke");
  assertSourceCalls(root, "src/original-mcp-action-authoring.ts", "dispatchOriginalMcpActionAuthoring",
    ["assertRootOwner", "assertOriginalMcpNativeHost", "originalMcpPublicRequestMatches", "readOriginalMcpActionAuthoringSources",
      "legacyActionWrite", "legacyActionRead", "legacyActionCatalog", "legacyActionArtifact",
      "approveOriginalMcpActionPackageSource", "approveOriginalMcpActionPackageDestination"]);
  assertSourceCalls(root, "src/original-mcp-action-runtime.ts", "createOriginalMcpActionRuntime",
    ["assertOriginalMcpNativeHost", "originalMcpPublicRequestMatches", "withOriginalMcpPublicRequest",
      "assertOriginalMcpActionDomainSession", "invokeOriginalMcpAction"]);
  const subscription = importedLiteralStrings(root, publicFile, "originalSubscriptionTools",
    "./original-mcp-subscription-contracts.js", "originalSubscriptionTools");
  assertSourceBranch(publicTree, "originalSubscriptionTools.some(tool => tool === name)");
  assertSourceBranch(publicTree, "originalSubscriptionTools.some(tool => tool === request.tool)", "readOriginalMcpSubscriptions");
  assertSourceCalls(root, "src/original-mcp-subscription.ts", "readOriginalMcpSubscriptions",
    ["originalMcpPublicRequestActive", "assertOriginalMcpNativeHost", "host.captureSubscriptionSource",
      "host.authorizeSubscriptionRead", "host.assertSubscriptionSource", "readSubscriptions"]);
  const maintenance = ["skill_feedback", "propose_skill_update"];
  assertSourceBranch(publicTree, 'name === "skill_feedback" || name === "propose_skill_update"');
  assertSourceBranch(publicTree, 'request.tool === "skill_feedback" || request.tool === "propose_skill_update"',
    "dispatchOriginalMcpSkillMaintenance");
  assertSourceCalls(root, "src/original-mcp-skill-maintenance.ts", "dispatchOriginalMcpSkillMaintenance",
    ["assertOriginalMcpNativeHost", "originalMcpPublicRequestMatches", "readLegacySkillMaintenanceGenesis", "legacySkillMaintenance"]);
  for (const [name, call] of [["portal_control", "adapter.createOriginalMcpPortalRuntime"],
    ["diagnostics_latest", "readNativeCurrentProcessDiagnostics"]]) {
    assertSourceBranch(publicTree, `name === "${name}"`);
    assertSourceBranch(publicTree, `request.tool === "${name}"`, call);
  }
  assertSourceCalls(root, "src/original-mcp-portal.ts", "createOriginalMcpPortalRuntime",
    ["assertOriginalMcpNativeHost", "originalMcpPublicRequestMatches", "requestOriginalMcpNative"]);
  assertSourceCalls(root, "src/native-current-process-diagnostics.ts", "readNativeCurrentProcessDiagnostics",
    ["assertOriginalMcpNativeHost", "originalMcpPublicRequestMatches", "sources.get", "source.writer.latest"]);
  const recipeExecution = literalStrings(root, publicFile, "nativeRecipeExecutionTools");
  assert.deepEqual(recipeExecution, literalStrings(root, "src/original-mcp-recipe-execution.ts", "operations"),
    "Recipe public selection and execution producer differ");
  assertSourceBranch(publicTree,
    'name === "recipe_create_from_skill" || name === "recipe_capabilities" || nativeRecipeExecutionTools.has(name)');
  assertSourceBranch(publicTree, 'request.tool === "recipe_create_from_skill"', "author.dispatchOriginalMcpRecipeFromSkill");
  assertSourceBranch(publicTree, 'request.tool === "recipe_capabilities"', "recipe.originalMcpRecipeCapabilities");
  assertSourceBranch(publicTree, "nativeRecipeExecutionTools.has(request.tool)", "recipe.dispatchOriginalMcpRecipeExecution");
  assertSourceCalls(root, "src/original-mcp-recipe-execution.ts", "dispatchOriginalMcpRecipeExecution",
    ["prepareOriginalMcpRecipeAdhoc", "prepareOriginalMcpRecipeLibraryRun", "createOriginalMcpRecipeExecution"]);
  assertSourceCalls(root, "src/original-mcp-recipe-execution.ts", "createOriginalMcpRecipeExecution",
    ["originalMcpPublicRequestMatches", "createOriginalMcpRecipeEffects"]);
  const gate = new Set([...knowledge.filter(name => !updates.includes(name)), ...indexed, "recipe_search", ...pureActionComplete,
    ...authoring, ...action, ...subscription, ...maintenance, "portal_control", "diagnostics_latest",
    ...recipeExecution, "recipe_create_from_skill", "recipe_capabilities"]);
  assertSourceCalls(root, publicFile, "createOriginalMcpPublicDispatcher",
    ["assertOriginalMcpNativeHost", "assertLegacyNoteBackendBinding", "withOriginalMcpPublicRequest"]);
  const lazy = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText() === "legacyRecipeLazyInputs") {
      let initializer = node.initializer;
      if (ts.isAsExpression(initializer)) initializer = initializer.expression;
      assert(ts.isObjectLiteralExpression(initializer));
      lazy.push(...initializer.properties.map(property => property.name.text.slice(9)));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceTree(root, "src/legacy-recipe-lazy-contracts.ts"));
  assert.equal(lazy.length, 6);
  const conditionalTrash = [], supplementalTrash = [], recovery = [];
  function includesArray(node, argument) {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
      || node.expression.name.text !== "includes" || !ts.isArrayLiteralExpression(node.expression.expression)
      || node.arguments[0]?.getText() !== argument) return [];
    assert(node.expression.expression.elements.every(ts.isStringLiteral), "Trash source scope must be a literal operation selection");
    return node.expression.expression.elements.map(element => element.text);
  }
  function trashBranches(node) {
    if (ts.isIfStatement(node)) {
      if (ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        const terms = [node.expression.left, node.expression.right];
        if (terms.every(term => ts.isBinaryExpression(term) && term.left.getText() === "request.tool"
          && term.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken && ts.isStringLiteral(term.right))) {
          let invokesRecovery = false;
          function dispatch(child) {
            if (ts.isCallExpression(child) && child.expression.getText() === "dispatchOriginalKnowledgeRecovery")
              invokesRecovery = true;
            ts.forEachChild(child, dispatch);
          }
          dispatch(node.thenStatement);
          if (invokesRecovery) recovery.push(...terms.map(term => term.right.text));
        }
      }
      if (ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        && node.expression.left.getText() === "trashPort" && /limitation\s*=\s*undefined/.test(node.thenStatement.getText()))
        conditionalTrash.push(...includesArray(node.expression.right, "request.tool"));
      function canonical(child) {
        supplementalTrash.push(...includesArray(child, "operation").filter(operation => operation.startsWith("knowledge.trash.")));
        ts.forEachChild(child, canonical);
      }
      canonical(node.expression);
    }
    ts.forEachChild(node, trashBranches);
  }
  trashBranches(sourceTree(root, publicFile));
  return { knowledge, indexed, state, action, authoring, subscription, maintenance, recipeExecution,
    pureAction, pureActionComplete, chat, room, updates, gate, lazy,
    conditionalTrash: [...new Set(conditionalTrash)], supplementalTrash: [...new Set(supplementalTrash)],
    recovery: [...new Set(recovery)] };
}

function moduleFor(name) {
  if (name.startsWith("action_")) return "Action";
  if (name.startsWith("api_chat_")) return "ApiChat";
  if (name.startsWith("chat_") || name === "check_chat_version") return "Room";
  if (name.startsWith("recipe_")) return "Recipe";
  if (name.startsWith("agent_session_")) return "AgentSnapshot";
  if (/(?:subscrib|subscription)/.test(name)) return "Subscription";
  if (name.startsWith("knowledge_snapshot_")) return "Snapshot";
  if (name.startsWith("knowledge_recovery_")) return "Recovery";
  if (name.startsWith("asset_classify_")) return "AssetClassification";
  if (/^(?:delete_note|delete_skill|delete_paper|knowledge_file_trash)$/.test(name)) return "Trash";
  if (/(?:userstor|workitem|work_item|work_items|board)/.test(name) || name === "list_agents") return "Todo";
  if (name.includes("skill")) return "Skill";
  if (name.includes("script")) return "Script";
  if (name.includes("paper") || name.includes("research")) return "Research";
  if (name.includes("note")) return "Note";
  if (name.includes("knowledge") || name.startsWith("retrieval_")) return "Retrieval";
  if (name === "portal_control") return "Portal";
  if (name === "diagnostics_latest") return "Diagnostics";
  throw new Error(`Unclassified original operation: ${name}`);
}

const blockers = {
  Action: ["ACTION_FULL_RUNTIME_REQUIRED", "Qualify original source/runs/queue/history and exact effect/toolchain authority; bounded pure/Program paths are not arbitrary Action or Cosmos parity."],
  ApiChat: ["API_CHAT_CONTROL_ADAPTER_REQUIRED", "Qualify source/Host/context/model/tool/Harness bindings; fresh TEXT Task and explicit archived Task adoption do not cover all files/images/history."],
  Room: ["ROOM_MCP_SESSION_ADAPTER_REQUIRED", "Qualify the original identity/cursor/standby/member/history API and native credentials beyond bounded loopback Magic Link sessions."],
  Recipe: ["FULL_RECIPE_PROTOCOL_REQUIRED", "Qualify pinned execution, progress/human gates, from-Skill/adhoc and autonomous Script/native/subflow constraints beyond NoOp."],
  Snapshot: ["LARGE_ROOT_PRIVATE_DOMAIN_ADMISSION_REQUIRED", "Admit exact snapshot scheduler/private source and immutable plan; preserve user Git index and privacy, never implicitly push."],
  Recovery: ["LARGE_ROOT_PRIVATE_DOMAIN_ADMISSION_REQUIRED", "Admit hash-verified recovery source/plan and write custody; prove no overwrite and audited restoration."],
  AssetClassification: ["LARGE_ROOT_PRIVATE_DOMAIN_ADMISSION_REQUIRED", "Admit exact classification preview/approval/write ownership; exclude private assets and preserve concurrent edits on rollback."],
  Trash: ["ORIGINAL_TRASH_CUSTODY_ADMISSION_REQUIRED", "Full original Trash readiness and reduced-broker exposure remain blocked. The conditional Note-only source increment does not implement original delete_skill/delete_paper; require separate exact custody/admission and successful lifecycle/installed proof, not intentional read-only claims. Preserve original buckets, never permanently unlink; supplemental native IDs are not extra original operations."],
  Todo: ["ORIGINAL_BOARD_AND_WORKER_REBIND_REQUIRED", "Admit original Note/Board pairs, CAS/audit publication and fresh actor/worker authority; canonical todo.* assignment/worker lanes do not enable all original mcp.tool.* leaves."],
  Subscription: ["NATIVE_SUBSCRIPTION_PROFILE_ADMISSION_REQUIRED", "Admit isolated subscription identity/cache/provenance and native SecretStorage; no local knowledge writes or copying old keys."],
  AgentSnapshot: ["ORIGINAL_STATE_DOMAIN_RECEIPT_REQUIRED", "Admit typed Agent Snapshot state/source receipts; generic archive preservation is not captured-state read authority."],
  Skill: ["ORIGINAL_STATE_DOMAIN_RECEIPT_REQUIRED", "Admit typed Skill-maintenance feedback/proposal receipts; observations/proposals must not mutate the formal Skill."],
  Portal: ["NATIVE_PORTAL_CONTROL_ADAPTER_REQUIRED", "Compose exact native portal ownership, saved-endpoint and per-operation approvals; QBR connection is deferred, no repair or send."],
  Diagnostics: ["DIAGNOSTICS_SOURCE_ADAPTER_REQUIRED", "Compose bounded metadata-only redacted diagnostic reads; no transcript/raw telemetry exposure."],
};

function nativeFor(contract, facts) {
  const name = contract.transportName, module = moduleFor(name);
  let implemented = facts.gate.has(name) || facts.updates.includes(name);
  let source = "src/original-mcp-public.ts#createOriginalMcpPublicDispatcher";
  let constraint = "Exact root/actor/profile/epoch/public approval; private source and semantic/model corpus admission are independent.";
  if (facts.authoring.includes(name)) {
    implemented = true; source = "src/original-mcp-action-authoring.ts#dispatchOriginalMcpActionAuthoring";
    constraint = "Typed original authoring/discovery, ModuleSet and artifact producer is wired before the historical pure fallback. Exact fresh public request, current source snapshots, proposal admission and native picker/destination/effect authority remain independent; registration or source readiness is not execution approval or installed/full Action qualification.";
    if (facts.pureAction.includes(name))
      constraint += " Historical sealed pure diagnostics/graph evidence remains restricted to its original bounded inputs; it is not evidence for the newly integrated registry-aware authoring path.";
  } else if (facts.pureAction.includes(name)) {
    implemented = true; source = "src/original-mcp-action-pure.ts#invokeOriginalMcpPureAction";
    constraint = name === "action_templates"
      ? "Complete source-pure sealed Original template catalogue; exact nonempty installed output under the same genuine Root/owner/Host/PublicRequest, without Action source/runtime/execution or credential grants. This does not qualify whole Action or full151."
      : name === "action_graph_check"
        ? "Bounded component-only constant and typed graph compiled outputs match closed sealed Original22 in the installed profile. Private or nested Action references still require ACTION_FULL_RUNTIME_REQUIRED; no registry, Action source, execution, Cosmos or full graph/runtime qualification."
        : "Source-pure invalid-schema diagnostics match closed sealed Original22 only; this supplemental result is NOT installed basic qualification. Schema-valid definitions still require the original registry/dependency closure and ACTION_FULL_RUNTIME_REQUIRED; no source/runtime admission.";
  } else if (facts.action.includes(name)) {
    implemented = true; source = "src/original-mcp-action-runtime.ts#createOriginalMcpActionRuntime";
    constraint = "Current typed native runtime producer is implemented, not an unconditional ACTION_FULL_RUNTIME_REQUIRED stub. Exact current source/run/domain/revision, checkpoint and effect/toolchain approvals remain mandatory; source gate readiness does not qualify every arbitrary Action/Cosmos history or installed effect sequence.";
  } else if (facts.chat.includes(name)) {
    implemented = true; source = "src/original-mcp-api-chat.ts#createOriginalMcpApiChatRuntime";
    constraint = blockers.ApiChat[1];
  } else if (facts.room.includes(name)) {
    implemented = true; source = "src/original-mcp-room-live-session.ts#originalMcpRoomLivePublicTools";
    constraint = blockers.Room[1];
  } else if (facts.recipeExecution.includes(name) || ["recipe_capabilities", "recipe_create_from_skill"].includes(name)) {
    implemented = true;
    source = name === "recipe_create_from_skill"
      ? "src/original-mcp-recipe-authoring.ts#dispatchOriginalMcpRecipeFromSkill"
      : `src/original-mcp-recipe-execution.ts#${name === "recipe_capabilities" ? "originalMcpRecipeCapabilities" : "dispatchOriginalMcpRecipeExecution"}`;
    constraint = "Current native Recipe authoring/execution producer has an explicit public gate and dispatcher. Exact library/source, current public request and independent per-process effects remain required; get may mutate, cancellation fences unknown outcomes, and no restart replay or full Recipe/installed qualification follows from this source mapping.";
  } else if (facts.subscription.includes(name)) {
    implemented = true; source = "src/original-mcp-subscription.ts#readOriginalMcpSubscriptions";
    constraint = "Typed bounded original Subscription read producer is wired, including list_subscriptions. It captures exact current membership/provider/key/corpus provenance, requires separate per-call native read consent and rechecks the source; public/profile admission alone is insufficient. No copied keys, local knowledge writes or installed/history qualification inferred.";
  } else if (facts.maintenance.includes(name)) {
    implemented = true; source = "src/original-mcp-skill-maintenance.ts#dispatchOriginalMcpSkillMaintenance";
    constraint = "Current advisory maintenance producer binds the exact external actor/public mutation to the typed genesis/current source. Feedback/proposals must not mutate formal Skills; implemented source gate is not historical state authority or installed evidence.";
  } else if (name === "portal_control") {
    implemented = true; source = "src/original-mcp-portal.ts#createOriginalMcpPortalRuntime";
    constraint = "Original queued Portal protocol has a native producer and same-owner public route. Exact current local Portal consent, endpoint/task/process/file authority and immutable request linkage remain required; this source mapping neither grants credentials nor qualifies all Portal operations or historical effects.";
  } else if (name === "diagnostics_latest") {
    implemented = true; source = "src/native-current-process-diagnostics.ts#readNativeCurrentProcessDiagnostics";
    constraint = "Bounded metadata-only current-process writer is bound to the exact Storage/native Host and public read approval. No persisted diagnostic history, transcripts, raw telemetry or installed qualification is inferred.";
  } else if (facts.lazy.includes(name)) {
    implemented = true; source = "src/legacy-recipe-lazy-contracts.ts#legacyRecipeLazyInputs";
    constraint = blockers.Recipe[1] + " Lazy get may mutate despite original readOnly=true; reject missing host authority.";
  } else if (facts.state.includes(name)) {
    implemented = true; source = "src/original-mcp-public.ts#stateReads";
    constraint = "Exact typed imported state/source receipt required, not a generic archived .pkm directory.";
  } else if (facts.conditionalTrash.includes(name)) {
    implemented = true;
    source = "src/original-mcp-public.ts#createOriginalMcpPublicDispatcher";
    constraint = name === "delete_note"
      ? "Conditional Note-only native port now has exact installed post-admission public Note/owned-pair delete/list/restore/receipt-successor/B1-B0 proof. This is not full Trash parity: prior readonly-bucket restore, installed transport cancellation/destination collision/pending recovery remain unqualified. Full ORIGINAL_TRASH_CUSTODY_ADMISSION_REQUIRED and reduced-broker disabled status stay unchanged."
      : ["delete_skill", "delete_paper"].includes(name)
        ? "Conditional Skill/Paper v2 port has pinned installed post-admission public unshared owned-pair delete/canonical-restore, exact receipt/UI/custody and separate stopped-B1/fresh-B0 proof. Exact current Host/Storage/Core/Root and homogeneous area/public/per-target authority remain required. This does not qualify list_papers, generic file Trash, prior readonly-bucket restore, pending recovery/destination collision or full Trash readiness; reduced broker stays disabled. Historical Note v1 receipts remain separate and immutable."
        : "Conditional typed native original-Trash source now supports Note v1, Skill/Paper v2 and opaque Prompt/Script v3 with fresh per-target custody/context. Historical installed delete_note and Skill/Paper evidence does not qualify the new generic Prompt/Script route; no new installed evidence is registered. Full readiness/reduced broker and original readonly-bucket recovery remain gated.";
  } else if (TODO_OPERATIONS.includes(id(name))) {
    implemented = true;
    constraint = "Exact installed first-Board/owned Team namespace slice has genuine public+GENESIS choices, same Storage/Host, Planning/CAS/claim/OnHold/audit and B1-image/fresh-B0 proof. Conditional fresh source/namespace authority is not general old-Board/worker/reviewer/full34 parity; readiness and reduced-broker exposure remain blocked.";
  } else if (facts.recovery.includes(name)) {
    implemented = true;
    constraint = "Conditional native Recovery dispatcher qualifies only one already-registered PUBLIC/unshared/asset-free baseline Note at retained Original0644: separate default-deny native-selected Source, ordinary PUBLIC and exact-owner repair authority, sealed Original preview/counts, no-overwrite and same raw ID/revision/index/custody lineage. Independent stopped-B1/fresh-B0 proof is not full arbitrary-file Recovery; private/Paper/assets/unknown owners/referrers/unproven modes/arbitrary crashes/multiple owners/Root replacement remain unqualified.";
  }
  if (name === "recipe_usage_summary") {
    source = "src/original-mcp-recipe-usage.ts#readOriginalMcpRecipeUsage";
    constraint = "Exact sealed native usage source; accounting grants no execution.";
  }
  if (facts.updates.includes(name))
    constraint = "Content/CAS update handler exists. Full readiness still blocks private-reference rename/category parity; separately scoped installed proofs do not promote the gate.";
  if (name === "add_skill") {
    constraint += " Matching same-name add_skill upsert has scoped installed create/update/upsert proof (same ID, revisions 1/2/3). Current source additionally resolves a sanitized destination collision to canonical existing-identity update; this new producer path has no additional installed evidence here. Historical same-name proof is not other-identity replacement qualification.";
  }
  if (["get_script", "search_scripts"].includes(name))
    constraint += " Exact installed v2 frozen Script initial get/search/private exclusion and two-editor Host admission/B1-image/fresh-B0 scope is qualified by its pinned artifact. Historical v1 auxiliary-only custody requires explicit upgrade and is not reinterpreted; no installed write/refresh/recapture, genuine v1 serving or general private-source/full151 acceptance is inferred.";
  const readiness = facts.gate.has(name) ? "implemented" : "blocked";
  const block = facts.updates.includes(name)
    ? ["PRIVATE_REFERENCE_MOVE_COMPATIBILITY_REQUIRED", constraint]
    : blockers[module];
  if (readiness === "blocked") assert(block, `${name}: missing blocker`);
  return {
    implementation: implemented ? "partial" : "missing",
    dispatch: facts.conditionalTrash.includes(name) || TODO_OPERATIONS.includes(contract.id) || facts.recovery.includes(name)
      ? "conditional" : implemented ? "implemented" : "refused",
    ...(facts.recovery.includes(name) ? {
      developmentStatus: "installed-registered-public-note-0644-slice-qualified-full-recovery-unqualified",
      sourceCondition: "current getOriginalRecoveryPhase1Port with same Storage/Host/root/actor/epoch; separate genuine native Source and repair grants with defaultDecision=deny",
    } : {}),
    ...(facts.conditionalTrash.includes(name) ? { developmentStatus: name === "delete_note"
      ? "installed-public-note-slice-qualified-full-parity-unqualified"
      : ["delete_skill", "delete_paper"].includes(name)
        ? "installed-public-skill-paper-v2-slice-qualified-full-parity-unqualified" : "source-conditional-unqualified",
      sourceCondition: ["delete_skill", "delete_paper"].includes(name)
        ? `current getNativeOriginalTrashPort + withNativeOriginalTrashContext, strict v2 area=${name === "delete_skill" ? "skills" : "papers"} and homogeneous selections; Note v1 remains separate`
        : name === "delete_note" ? "current getNativeOriginalTrashPort + withNativeOriginalTrashContext, notes only"
          : "current getNativeOriginalTrashPort + withNativeOriginalTrashContext; separate Note v1, Skill/Paper v2 and Prompt/Script v3 contracts" } : {}),
    reason: implemented ? constraint : block[1],
    sourceRefs: [source, ...(facts.pureAction.includes(name) ? ["src/original-mcp-public.ts#createOriginalMcpPublicDispatcher",
      ...(facts.authoring.includes(name) ? ["src/original-mcp-action-pure.ts#invokeOriginalMcpPureAction"] : [])] : []),
      ...(facts.authoring.includes(name) || facts.action.includes(name) ? ["src/original-mcp-action-tools.ts"] : []),
      ...(name === "add_skill" ? ["src/legacy-knowledge-write.ts#legacyKnowledgeWrite"] : []),
      ...(facts.conditionalTrash.includes(name) ? ["src/original-native-trash-native.ts#getNativeOriginalTrashPort",
        "src/original-native-trash-planning.ts", "src/original-native-trash-custody.ts"] : []),
      ...(facts.recovery.includes(name) ? ["src/original-knowledge-recovery-runtime.ts#dispatchOriginalKnowledgeRecovery",
        "src/original-knowledge-recovery-native.ts#getOriginalRecoveryPhase1Port"] : []),
      ...(facts.conditionalTrash.includes(name) && ["delete_skill", "delete_paper"].includes(name)
        ? ["src/original-native-trash-contracts.ts#originalNativeTrashRequestV2Schema",
          "src/native-public-mcp-owner.ts#createNativePublicOwnerBackend"] : [])],
    fullOriginalReadiness: readiness,
    blockerCode: readiness === "blocked" ? block[0] : null,
    nativeDogfoodWritable: facts.gate.has(name) ? "enabled" : facts.updates.includes(name) ? "conditional" : "disabled",
    nativeDogfoodReadOnly: (facts.gate.has(name) || facts.updates.includes(name)) && contract.readOnly ? "enabled" : "disabled",
  };
}

const step = (operation, stage, oracle) => ({ operation: id(operation), stage, oracle });
const call = (name, oracle) => step(name, "operation-success", oracle);
const inspect = (name, oracle) => step(name, "read", oracle);
const SKILL_OPERATIONS = ["add_skill", "get_skill", "update_skill", "list_skills", "search_skills"].map(id);
const NOTE_PAPER_OPERATIONS = ["add_note", "get_note", "update_note", "list_notes", "search_notes",
  "add_paper", "get_paper", "update_paper", "list_papers", "search_papers"].map(id);
const SKILL_CASE_ID = "compatibility-a-skill-basic-roundtrip";
const NOTE_PAPER_CASE_ID = "compatibility-a-note-paper-basic-roundtrip";
const COMPATIBILITY_CASE_FILE_SHA256 = "632d1a6b12941b804937cc06fddde632e8f4c8a58301ce4908384df82b4b1d63";
const COMPATIBILITY_CASE_SOURCE_FILES = [
  { file: "tests/compatibility-mcp.test.mjs", sha256: COMPATIBILITY_CASE_FILE_SHA256 },
  { file: "tests/compatibility-mcp-fixture.mjs", sha256: "a7880c646f313207473b2732edc081200188713bc1335e7ca6fcd01d9f69f637" },
];
const INSTALLED_SKILL_CASE_ID = "installed-native-skill-basic-roundtrip";
const INSTALLED_SKILL_EVIDENCE_ID = "installed-skill-upsert-preservation-final-2026-11-21";
const SOURCE_SKILL_CASE_ID = "native-cold-source-skill-upsert-roundtrip";
const SCRIPT_OPERATIONS = ["get_script", "search_scripts"].map(id);
const SCRIPT_REFUSAL_CASE_ID = "compatibility-a-script-offline-refusal";
const SCRIPT_ALGORITHM_CASE_ID = "pinned-reader-source-python-script-lexical";
const SCRIPT_BASIC_CASE_ID = "compatibility-a-script-real-worker-basic";
const SCRIPT_LIFECYCLE_CASE_ID = "original-script-worker-interrupted-cleanup";
const INSTALLED_TRASH_CASE_ID = "installed-native-public-note-trash-basic";
const INSTALLED_TRASH_EVIDENCE_ID = "installed-public-note-trash-2026-11-21T220838";
const INSTALLED_SCRIPT_CASE_ID = "installed-native-frozen-script-initial-read";
const INSTALLED_SCRIPT_EVIDENCE_ID = "installed-frozen-script-008de6-attempt3";
const INSTALLED_TODO_CASE_ID = "installed-native-first-board-planning-basic";
const INSTALLED_TODO_EVIDENCE_ID = "installed-todo-genesis-b1-qualified";
const INSTALLED_INPLACE_CASE_ID = "installed-native-existing-note-paper-inplace-read";
const INSTALLED_INPLACE_EVIDENCE_ID = "installed-note-paper-inplace-6367-parent-reviewed";
const INSTALLED_INPLACE_OPERATIONS = ["update_note", "get_note", "update_paper", "get_paper"].map(id);
const INSTALLED_SKILL_PAPER_TRASH_CASE_ID = "installed-native-public-skill-paper-trash-v2";
const INSTALLED_SKILL_PAPER_TRASH_EVIDENCE_ID = "installed-public-skill-paper-trash-v2-b4a693-parent-reviewed";
const INSTALLED_SKILL_PAPER_TRASH_OPERATIONS = ["delete_skill", "delete_paper"].map(id);
const INSTALLED_NOTE_PAPER_CASE_ID = "installed-native-public-note-paper-create-list-lexical";
const INSTALLED_NOTE_PAPER_EVIDENCE_ID = "installed-public-note-paper-basic-5948-parent-reviewed";
const INSTALLED_NOTE_PAPER_OPERATIONS = ["add_note", "list_notes", "search_notes", "add_paper", "list_papers", "search_papers"].map(id);
const INSTALLED_RESEARCH_CASE_ID = "installed-native-research-read-list-lexical-graph";
const INSTALLED_RESEARCH_EVIDENCE_ID = "installed-research-basic-994eb9-final-parent-reviewed";
const RESEARCH_OPERATIONS = ["get_research", "list_research", "search_research", "paper_graph"].map(id);
const RECOVERY_OPERATIONS = ["knowledge_recovery_preview", "knowledge_recovery_apply"].map(id);
const INSTALLED_RECOVERY_CASE_ID = "installed-native-recovery-registered-public-note-0644";
const INSTALLED_RECOVERY_EVIDENCE_ID = "installed-recovery-public-note-0644-20261123-parent-reviewed";
const INSTALLED_RECOVERY_PROFILE = "installed-native-recovery-registered-public-note-0644-isolated";
const RECOVERY_STAGES = ["recovery-deny-source", "recovery-preview", "recovery-deny-repair",
  "recovery-wrong-hash", "recovery-apply", "recovery-after-preview", "recovery-occupied"];
const INSTALLED_ACTION_PURE_CASE_ID = "installed-native-action-pure-templates-bounded-component-graph";
const INSTALLED_ACTION_PURE_EVIDENCE_ID = "installed-action-pure-3b068761-20261123-parent-reviewed";
const INSTALLED_ACTION_PURE_PROFILE = "installed-native-action-pure-no-source-runtime-isolated";
const ACTION_PURE_OPERATIONS = ["action_templates", "action_graph_check"].map(id);
const ACTION_PURE_STAGES = ["templates", "definition-invalid", "graph-constant", "graph-typed",
  "capabilities-denied", "definition-registry-denied", "graph-private-denied", "graph-nested-private-denied"]
  .map(stage => `native-action-pure-${stage}`);
const A_TRASH_OPERATIONS = ["delete_skill", "delete_paper", "knowledge_file_trash"].map(id);
const A_TRASH_SOURCE_FILES = [
  { file: "tests/skill-paper-trash-basic.test.mjs", sha256: "25839c2b2cd20d7dc5b4d9331e515f3b25363aecead2696f9c512a4720648cf1" },
  { file: "tests/skill-paper-trash-basic-fixture.mjs", sha256: "607a5ea3366eb42d9205002f5a0bb9f6b7c47ea3bd33be6b65c0edb9336cb5ef" },
  { file: "tests/original-knowledge-writer-fixture.mjs", sha256: "f4151aa28df50ec1ab2593e5aa94248ce7c409053a0477102cfa4e3c1601892d" },
  COMPATIBILITY_CASE_SOURCE_FILES[1],
];
const SCRIPT_ALGORITHM_PROFILE = "pinned-original-reader-source-python-lexical";
const SCRIPT_SOURCE_FILES = [
  { file: "tests/script-basic-acceptance.test.mjs", sha256: "341a443bc0fbb02d2827fb1265aa913aff2d64a343126c98d7675ed74038d6e0" },
  { file: "tests/script-basic-fixture.mjs", sha256: "06cd6a87f92adae396c96c3211b6375714ef06a6a9a44bfff2dbe08f36c42e08" },
  { file: "tests/script-original-worker-fixture.mjs", sha256: "93e8f1c20b85cc810a9fac7b1bfbc32e6e49cdc8524aad4820af32efe76c3575" },
  COMPATIBILITY_CASE_SOURCE_FILES[1],
];
const TODO_OPERATIONS = ["todo_board_create", "add_workitem", "get_board", "get_workitem", "update_workitem",
  "claim_workitem", "change_workitem_state", "list_boards", "list_workitems", "list_workitem_history",
  "list_board_changes", "note_work_items"].map(id);
const TODO_REFUSAL_OPERATIONS = ["note_work_item_command", "accept_workitem"].map(id);
const TODO_BASIC_CASE_ID = "compatibility-a-todo-planning-state-basic";
const TODO_DRAIN_CASE_ID = "compatibility-a-todo-cancelled-wait-drain";
const HELD_SCHEMA_CASE_ID = "held-v1-parser-actual-v2-schema-refusal";
const TODO_SOURCE_FILES = [
  { file: "tests/todo-basic-acceptance.test.mjs", sha256: "572f3021ed45adcff17a0fb4856250426de9cf7e849ea356b05fe36e4fa496f9" },
  { file: "tests/todo-basic-fixture.mjs", sha256: "bbd68c1afb3c123c50e6412777ac01ed7bd1eadeb5d322a2ed83c5d04b3907a2" },
  COMPATIBILITY_CASE_SOURCE_FILES[1],
];

function installedSkillEvidence() {
  return {
    level: "installed", executionProfile: "installed-native-isolated", operations: SKILL_OPERATIONS,
    review: "parent coordinator explicitly attests the final persistent assertions, complete receipt/hash preservation and exact artifact digest; not a caller-supplied readiness flag or static-file-presence proof",
    uri: "file:///home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-skill-basic-upsert-preservation-installed.json",
    sha256: "dc10183355d7ace8b47dd74794ce6ede4434abf90829fb1dd93da7ad4d1ec196",
    reportSchema: "pkm.installed-host-acceptance/v1", runIdentity: "final upsert + independent B1 byte/hash/all-three-receipt preservation run, not earlier two-receipt or intermediate upsert reports",
    candidateVsixSha256: "ba4afb9aad4c54d77ed0c63c09ed1920be56df71a0c40698ea4d5186731902c2",
    payloadBuildId: "d6cd57d4cb1b7cfc84277eaabaaf20d0f44d3a1a8b081e282d63c9d95f1f8c88",
    selectors: {
      basicSequence: "/coldComponent/nativeSkillBasic/createReadUpdateReadListRetrieve",
      nativeUi: "/coldComponent/nativeSkillBasic/actualNativeUi",
      canonicalReceipts: "/coldComponent/nativeSkillBasic/createAndUpdateReceipts",
      stableId: "/coldComponent/nativeSkillBasic/stableKnowledgeId",
      revisions: ["/coldComponent/nativeSkillBasic/revisionBefore", "/coldComponent/nativeSkillBasic/revisionAfter"],
      sameNameUpsert: "/coldComponent/nativeSkillBasic/overwriteExistingSkillQualified",
      upsertScope: "/coldComponent/nativeSkillBasic/sameNameUpsertScopeOnly",
      B1: "/coldComponent/skillBasicPreservation/updatedSkillAtB1",
      freshB0: "/coldComponent/skillBasicPreservation/createdSkillAbsentAtFreshB0",
      exit: "/electronExitCode", profileRemoval: "/profileRemoved", productionCutover: "/productionCutover",
    },
    observations: {
      actualInstalledNativeUi: true, createReadUpdateReadListRetrieve: true, retrievalRoute: "lexical",
      canonicalCreateUpdateUpsertReceipts: 3, sameKnowledgeIdentityAcrossReceipts: true, uniqueOperationIds: 3,
      revisions: [1, 2, 3], updatedSkillPreservedAtB1: true, createdSkillAbsentAtFreshB0: true,
      retrievalQuery: "Skill overwrite sentinel",
      updatedSkillB1BytesAndHashIndependentlyVerified: true, allThreeCanonicalReceiptsIndependentlyPreservedAtB1: true,
      actualEditorClosedBeforeB1: true, electronExitCode: 0, privateProfileRemoved: true,
      overwriteExistingSkillQualified: true, sameNameUpsertScopeOnly: true,
      occupiedOtherIdentityReplacementQualified: false, semanticRetrievalQualified: false, productionCutover: false,
    },
    canonicalReceiptHashAvailability: "Final pinned artifact attests independently verified updated Skill bytes/hash and all three canonical receipts at B1, with unique operation IDs and same knowledge identity/revisions. Exact receipt IDs/hashes remain in that artifact; no truncated hash or intermediate run identity is copied as a full digest.",
    approvalScope: "Independent genuine host attachment/admission and five public mutation dialogs: Note denial/update and Skill create/update/same-name upsert. Reads use the existing native handler's automatic approval; no newly named read modal or changed UX/policy.",
    sourceReferenceScope: "Installed-test/cold-component source is a navigation reference, not the immutable evidence authority; only this report's exact candidate/payload and observed stages are accepted.",
    remainingGaps: ["occupied-other-identity replacement",
      "semantic Retrieval", "Skill-specific guarded denial/expiry/cancellation",
      "installed same-root restart/read after reconnect", "general private/asset/omitted-field preservation", "full151 native or production acceptance"],
    portability: "External receipt URI is optional in CI and is not opened by the static checker. Hash pin remains authoritative if the file is relocated; changed bytes require a new explicit evidence record, never regeneration of this attestation.",
  };
}

function installedTrashEvidence() {
  return {
    level: "installed", executionProfile: "installed-native-isolated", operations: [id("delete_note")],
    review: "parent-qualified real installed profile passed twice; bounded report/actual helper assertion review, not registration, Source test counts or caller boolean proof",
    uri: "file:///home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-public-trash-installed-qualified.json",
    sha256: "9d9369323f3e9fb81a8773e4f8c40661d5cca00464a9dbcdec824897ef3e1fdb",
    reportSchema: "pkm.installed-host-acceptance/v1", timestamp: "2026-11-21T22:08:38.267Z",
    candidateVsixSha256: "e87602ed6ef34660c0af0c577ad33d5e9cd841b3a6b0d8e47a69763e20d71725",
    payloadBuildId: "6116952f74b1087cd364a21dbaad8908f7193245ae8bf6de7c239d0d0d0b63cf",
    scope: "one fresh post-admission public Note/owned-pair lifecycle; original delete_note only, not knowledge_file_trash/delete_skill/delete_paper",
    selectors: { live: "/coldComponent/nativeOriginalTrash", preservation: "/coldComponent/originalTrashPreservation",
      exit: "/electronExitCode", profileRemoval: "/profileRemoved", productionCutover: "/productionCutover" },
    observations: {
      actualNativeUi: true, publicDeleteNoteChoices: 3, separateMethod25TrashChoices: 8,
      defaultEnterTrashDenials: 3, modalEscapeDismissalRefused: true, staleSourceCasRefused: true,
      canonicalRestoreUuidReplayNoEffectsOrReview: true, exactRawKnowledgeIdRevisionPairHistory: true,
      priorReadonlyBucketPreserved: true, privateDataAndControlsPreserved: true,
      originalReadonlyBucketRestoreQualified: false, installedTransportCancellationQualified: false,
      installedDestinationCollisionQualified: false, installedPendingRecoveryQualified: false, interruptionInjectionUsed: false,
      mutationOperationIds: ["9d96067b-53c4-4c8d-9def-c11f9482cef4", "c5771893-dbb9-4ca5-99bf-6ecf967b9e52"],
      custodySuccessorDigests: ["94d27f80fb2913e5002b970767f54b75c5df1f2ec5e3bf347f1fcdb3744153fd",
        "9b5697fddb699322fdad4cab47116c01dbc20c64eb074bbd34f50ab84c232b17"],
      liveHelperB1AndB0Qualified: false,
      independentPreservation: { notePairReadonlyBucketPrivateAndHistoryAtB1: true,
        exactReceiptsAndSuccessorsAtB1: true, allOriginalTrashB0BytesRestored: true,
        freshB0NoNativeDatabaseOrGrant: true, historicalDecisionsNotCurrentGrant: true },
      sourceOnlyNativeModelChannelUnavailable: true, helperInitiatedModelRequests: 0,
      coordinatorExitCode: 0, privateProfileRemoved: true, originalRootOverwritten: false,
      fullTrashParityQualified: false, fullCutoverQualified: false,
    },
    assertionRefs: ["clients/vscode-host/installed-native-trash.mjs#verifyInstalledNativeTrash",
      "clients/vscode-host/installed-native-trash.mjs#verifyInstalledNativeTrashB1",
      "clients/vscode-host/installed-native-trash.mjs#verifyInstalledNativeTrashRestored"],
    referenceSourcePins: [
      { file: "clients/vscode-host/installed-native-trash.mjs", sha256: "3ebcc6b84e562155ac0afcac20bde367c42d3c5053ace7ca84d1a8019676f3b9" },
      { file: "clients/vscode-host/installed-native-trash-ui.mjs", sha256: "5a5810b563f870c47fac78a8621954dab431e1f7333ab85838c1267866805c99" },
    ],
    sourceReferenceScope: "Historical assertion snapshots/navigation only. The exact sealed candidate/payload/report is the evidence authority; current runner changes do not silently refresh or invalidate historical Skill/Trash artifact pins.",
    rawOracleScope: "Original public get_note omits knowledgeId/revision: raw Markdown projection, exact Note/pair bytes, deletion-history bytes and SQL receipt/successor rows establish identity/revision 2 and preservation.",
    modelCounterScope: "Zero is helper-initiated requests only, not a global model/provider audit.",
    remainingGaps: ["knowledge_file_trash not called", "delete_skill/delete_paper not implemented by this slice",
      "prior readonly-bucket restore", "installed transport cancellation", "installed destination collision",
      "installed pending recovery/interruption", "full Trash/full151/shared-root/production cutover"],
    portability: "Static checker never opens this external artifact. Changed bytes require an explicitly reviewed new record; source runner presence or Source-only test counts cannot qualify the case.",
  };
}

function installedTrashEffectCase() {
  const assertion = `reviewedEvidence.${INSTALLED_TRASH_EVIDENCE_ID}`;
  return {
    id: INSTALLED_TRASH_CASE_ID, operations: [id("delete_note")], executionProfile: "installed-native-isolated",
    runner: { file: "clients/vscode-host/installed-test.mjs", scenarioArgument: "--native-trash",
      requiredFlags: ["--native-identity", "--cold-component", "--legacy-vsix"],
      originalVsixSha256: "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27",
      definition: "clients/vscode-host/installed-native-trash.mjs#verifyInstalledNativeTrash",
      authority: "Known installed selector is navigation only; exact sealed artifact and scoped real effect/receipt/preservation assertions are required." },
    reviewedEvidenceRefs: [INSTALLED_TRASH_EVIDENCE_ID],
    stages: [
      { operation: id("delete_note"), stage: "public-and-trash-guarded-denial", nativeOperation: "knowledge.trash.move",
        assertion: `${assertion}: public Deny and separate default-Enter Move Deny preserve all bytes/journal rows` },
      { operation: id("delete_note"), stage: "approved-public-note-trash", nativeOperation: "knowledge.trash.move",
        assertion: `${assertion}: raw Note and owned opaque pair moved exactly, deletion history appends only exact removed paths, first canonical receipt and custody successor` },
      { operation: null, stage: "canonical-trash-list", nativeOperation: "knowledge.trash.list",
        assertion: `${assertion}: default-Enter list denial and approved exact target IDs; prior readonly bucket listed/preserved, not restored; no mutation journal change` },
      { operation: null, stage: "canonical-restore-refusals", nativeOperation: "knowledge.trash.restore",
        assertion: `${assertion}: default-Enter denial, Escape dismissal and stale-source CAS conflict cause zero effects or changed receipts` },
      { operation: null, stage: "canonical-restore", nativeOperation: "knowledge.trash.restore",
        assertion: `${assertion}: exact raw Note knowledge identity/revision 2, pair bytes and original history restored; second mutation receipt and custody successor` },
      { operation: null, stage: "canonical-uuid-replay", nativeOperation: "knowledge.trash.restore",
        assertion: `${assertion}: exact restore operation UUID replays with no effects/review or new receipt/successor` },
      { operation: null, stage: "independent-B1-B0-preservation",
        assertion: `${assertion}: separate verifyInstalledNativeTrashB1/Restored exports compare all receipt/successor rows, private/pair/history bytes and fresh B0 all original bytes/no database or grant` },
      { operation: null, stage: "closed-profile-and-model-limits",
        assertion: `${assertion}: normal coordinator exit 0/profile removed; Source-only native inference unavailable, helper initiates zero model requests (not global audit)` },
    ],
    oracle: `${assertion}: installed fresh public Note/pair slice, genuine exact native/default-deny bindings and RAW identity/revision/history assertions, not a metadata-only public get_note identity oracle`,
    receipt: `${assertion}: exact two mutation operation UUIDs and two full custody successor digests; same-UUID restore replay no new effects/review`,
    preservation: `${assertion}: independent B1 complete receipt/successor/private/pair/history comparisons and fresh B0 original bytes/no native database/grant; old bucket restore/transport cancellation/collision/pending recovery not qualified`,
  };
}

function installedScriptEvidence() {
  return {
    level: "installed", executionProfile: "installed-native-isolated", operations: SCRIPT_OPERATIONS,
    review: "parent-reviewed actual two-editor installed run and exact artifact assertions, not preparatory 9/9 tests, file presence or hash-only acceptance",
    uri: "file:///home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-frozen-script-008de6-installed-attempt3.json",
    sha256: "f1030f40f19973c4d0a2e453eee0ea51728bd791ae594f6cb0750d594273fa01",
    candidateUri: "file:///home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-frozen-script-008de6-candidate.vsix",
    candidateVsixSha256: "ade8f3aef9dd5e432411e3cd8cdd00091ac790bf0125cf6e1767bdf7bf23ba4d",
    payloadBuildId: "b8a8309e057ea9607ddf824469c2f020ea24d90b8369a8b2674a34a4a12faaf2",
    timestamp: "2026-11-22T02:30:39.359Z", reportSchema: "pkm.installed-host-acceptance/v1",
    scope: "Frozen v2 public Script initial lexical search -> returned-ID get with real private exclusion; no post-seal edit, write/execute or recapture",
    selectors: { reads: "/coldComponent/nativeScript", plan: "/coldComponent/currentPlan",
      preservation: "/coldComponent/scriptPreservation", restoration: "/coldComponent/scriptRestoration",
      editorExits: "/coldComponent/editorExitCodes", uiExits: "/coldComponent/genericUiExitCodes", profileRemoval: "/profileRemoved" },
    rootPins: { schema: "pkm.original-mcp-custody/v2",
      planSha256: "640ca0d5f4e3b40ebcbc9600ed722b11fa13c60d1c57d94e36b5905d39174c7a",
      inventorySha256: "2a1d63b200fcbfdbc05ccd741c8c62bf0ac0a89f8256a0be3d694ae374c0ed89",
      privacySha256: "ef4cc62cb36a9718a894fc1e707d0a9e1cc6b43c01f31c34419ed88b04e6b16e",
      journalSha256: "1048a5e6e77dcaad5f10bab4e978d47526d3b118b76805653de15817c8ec306a",
      b1Sha256: "aed9f1518885bb9265405e0f8a41d6762ac0ac5e9387b9d4c3c48d562561d8c6" },
    observations: {
      actualInstalledIdentityAndHost: true, hostChoicesAcrossWholeEditors: 2, readonlyModals: 0,
      deniedEpoch: "ee544557-bd5d-4653-b3bb-439dd6c54f52", approvedEpoch: "c4eda560-3a35-4386-b2f0-39bd378df11f",
      sourceId: "pkm://script/script_4f1222322b0fdf6ba8963381",
      rawSha256: "33a775ad40cd97909d0461a9500f7b76c4ec1fc0dbae21460215e353f8e0e0c3",
      contentHash: "9d5161da53ceaa161a8c1690d5f67d1bbba501c274db06bcab7a623d108ae0e1",
      sourceRevision: "sha256:33a775ad40cd97909d0461a9500f7b76c4ec1fc0dbae21460215e353f8e0e0c3:e4c89be37bc72f46d8307613e3a7ad9b2a2527a3742aa26eeaa1d8069a34efa7",
      corpusRevision: "08638185361e253d8c0eaaf6379a5d96a4286184e68a0c66c0b7b4a8091a2af1", readyGeneration: 1,
      actualRootPrivateExclusion: true, privateServingAtimeAndIdentityUnchangedAfterB0: true, frozenSourceUnmodified: true,
      businessReceiptsUnchanged: true, derivedCorpusOnly: true, noRawScriptBytesPersistedInCorpus: true,
      liveHelperB1AndRestoredQualified: false,
      independentPreservation: { frozenPublicPrivateScriptsAtB1: true, stoppedNativeDatabaseImagePreserved: true,
        scriptMutationReceiptCreated: false, allOriginalB0BytesRestored: true, freshB0NoNativeCorpusOrGrants: true },
      editorExits: { deny: 0, approve: 0 }, uiExits: { deny: 0, approve: 0 }, profileRemoved: true,
      noCommonNoteSkillMutationPrelude: true, fullCutoverQualified: false,
    },
    assertionRefs: ["clients/vscode-host/installed-native-script.mjs#verifyInstalledNativeScript",
      "clients/vscode-host/installed-native-script.mjs#verifyInstalledNativeScriptHostDenied",
      "clients/vscode-host/installed-native-script.mjs#verifyInstalledNativeScriptB1",
      "clients/vscode-host/installed-native-script.mjs#verifyInstalledNativeScriptRestored",
      "clients/vscode-host/installed-native-script-lifecycle.mjs#verifyInstalledNativeScriptLifecycle"],
    referenceSourcePins: [
      { file: "clients/vscode-host/installed-native-script.mjs", sha256: "cd5fe0903dfe5390e32dd411765464a5a3dbe0b7b88b8cb4713b4be4ba4c8c88" },
      { file: "clients/vscode-host/installed-native-script-ui.mjs", sha256: "190854042ae3cb26cbc6d17c3146f28404ed71045dd744f4559f6a908a76d332" },
      { file: "clients/vscode-host/installed-native-script-lifecycle.mjs", sha256: "5f9245659794248e38065efb312c838e88c7d5e7f4b47c19aac06cbff5e693d8" },
      { file: "clients/vscode-host/installed-held-script-custody-parser.mjs", sha256: "c28951f3bc0fa0fe17c02d5d5be7a077fbece7bbbe0524992e77ad82514ebf45" },
    ],
    preservationScope: "Live SQL receipt/corpus assertions followed by exact stopped database-image hash preservation, not newly reopened B1 rows. Early leaf B1 flag stays false; independent later preservation/restoration proof is separate.",
    sourceReferenceScope: "Assertion snapshots/navigation only; exact approved artifact/candidate/payload/Root pins remain authority, not current helper/runner hashes.",
    remainingGaps: ["Script write/execute API absent", "installed post-seal edit/refresh/recapture not claimed",
      "genuine retained-v1 Root/Host serving-refusal not claimed", "semantic route/model/provider qualification",
      "general private-source or full151/shared-root/production cutover"],
    portability: "Static checker does not open the external report/candidate or private Root; registration alone cannot create installed authority.",
  };
}

function installedScriptEffectCase() {
  const assertion = `reviewedEvidence.${INSTALLED_SCRIPT_EVIDENCE_ID}`;
  return {
    id: INSTALLED_SCRIPT_CASE_ID, operations: SCRIPT_OPERATIONS, executionProfile: "installed-native-isolated",
    runner: { file: "clients/vscode-host/installed-test.mjs", scenarioArgument: "--native-script",
      requiredFlags: ["--native-identity", "--cold-component", "--legacy-vsix"],
      definition: "clients/vscode-host/installed-native-script-lifecycle.mjs#verifyInstalledNativeScriptLifecycle",
      authority: "Actual two-editor installed artifact and scoped helper assertions, not preparatory tests or manufactured Host/witness data." },
    reviewedEvidenceRefs: [INSTALLED_SCRIPT_EVIDENCE_ID],
    stages: [
      { operation: null, stage: "two-real-editor-host-admissions", assertion: `${assertion}: genuine denied Host/closed whole editor then different Root/epoch approved Host; actual Attach acknowledgement and branded witness, zero named read modals` },
      { operation: id("search_scripts"), stage: "frozen-public-retrieve", assertion: `${assertion}: actual installed explicit lexical query returns one exact body hit/canonical source ID, semantic off/model not invoked` },
      { operation: id("get_script"), stage: "returned-id-read", assertion: `${assertion}: returned search ID reads exact independent original bytes/raw hash/content hash/revision/type/metadata/provenance/field sets/read_only=false without a Script write API` },
      { operation: id("search_scripts"), stage: "real-root-private-exclusion", assertion: `${assertion}: real frozen Root policy excludes the private source ID before serving` },
      { operation: id("get_script"), stage: "private-not-found", assertion: `${assertion}: exact private not-found, private dev/ino/size/atime/mtime/ctime/mode unchanged after B0 and admission` },
      { operation: null, stage: "readonly-derived-corpus", assertion: `${assertion}: business receipts unchanged, only derived generation 1/corpus append, no raw Script bytes in SQL corpus, no common Note/Skill mutation prelude` },
      { operation: null, stage: "independent-B1-fresh-B0", assertion: `${assertion}: actual stopped editor/owner B1 preserves frozen public/private Scripts/privacy and database IMAGE hash; fresh B0 exact original bytes/no corpus or authority` },
      { operation: null, stage: "closed-editors-ui-profile", assertion: `${assertion}: both whole editors and UIs exit 0, profile removed; no v1 serving, post-seal edit, recapture or full cutover claim` },
    ],
    oracle: `${assertion}: genuine installed frozen-Root public search/get and private denial with exact original byte/provenance oracle, not A's unsealed refresh or Source-only decision double`,
    receipt: `${assertion}: actual Host/epoch/Root pin binding, read results and derived corpus preservation; no Script mutation receipt`,
    preservation: `${assertion}: exact separate B1 image/fresh-B0 proof after complete lifetimes, not reopened-row proof or historical v1 serving authority`,
  };
}

function installedTodoEvidence() {
  return {
    level: "installed", executionProfile: "installed-native-isolated", operations: TODO_OPERATIONS,
    review: "parent-reviewed actual installed lifecycle plus exact helper call/UI/receipt assertions, not an originalIds catalog list or Source boundary/proxy test",
    uri: "file:///home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-todo-genesis-b1-installed-qualified.json",
    sha256: "cdee3e03acf4d4d7dcd3abd92258bd6f3ebf285a6f04caf4f9f20baba4992610",
    candidateUri: "file:///home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-todo-genesis-b1-candidate.vsix",
    candidateVsixSha256: "6367a908d10fcede19a3d76a40b93f9cf63dfb0375eb24ec53029cfd867d9075",
    payloadBuildId: "00564b3c8dabc4c5e35906180981faf623d1f2322d43b587f2c94f5aee6a16d7",
    timestamp: "2026-11-22T04:25:03.311Z",
    scope: "one new empty Board/paired Note in existing PUBLIC owned Team700 namespace and one Planning task; no folder/overwrite/worker/reviewer authority",
    selectors: { live: "/coldComponent/nativeTodoGenesis", preservation: "/coldComponent/todoGenesisPreservation",
      exit: "/electronExitCode", profileRemoval: "/profileRemoved" },
    rootPins: { sourceId: "e8987feb-d9b1-4130-8a9d-3038739bb0db", knowledgeId: "knowledge_ca0bb1788f1df0ef726c619d",
      nativeEpoch: "aaf18acb-29c8-41a2-bc9d-3467eebd2c7c",
      custodyPlanSha256: "5d90ecc7b703e8d0e6b6b9bad36055421c5a3ee57b620d696847f56375d1a9ac",
      catalogSha256: "696d70e87c1b56697de21d0ab545eb161fed46ae11b34fce6a1f1179198d6a21",
      noteSha256: "7278aa7eedb621b2aad260574488f468a4b395a48318f76078fc9fd91df495c7",
      backingSha256: "4f49ed15de1aca1a4333e2a6c50c2382c92c9e72a0efdbf2e9e82da078d6ed75",
      finalBoardSha256: "eea6111f3d4dd90c945b0dfae4529cfeebc953b83f3535875e02dc5fca529d9f",
      sourceLedgerSha256: "a2389bbf989d87065fd135adc3fb988685c912f839e4323fcc64304b848cb306",
      b1Sha256: "6611c3cbdfcbbd439d6d23d59bc06358cfb74c2aeec7a075c52b717ad3b2ebf9" },
    canonicalReceipts: [
      { operation: "todo.board.create", operationId: "d3a7bccd-e736-4451-a00d-9f0dc6840a47", resultSha256: "fd3eb99098a1d5531eac33c39dc8a780f656b1a8115a158d0a721eb19fdafb6a" },
      { operation: "todo.workitem.create", operationId: "63b7b06e-1e64-4d2a-99d1-b8aa2c41e247", resultSha256: "fee7270cc1b2103015ffac2c27a20d720889fffde7c45b746a879bb2aebec88a" },
      { operation: "todo.workitem.update", operationId: "7ef32004-b4f4-49c6-a487-e188eb29abdd", resultSha256: "06eedb2d19a38f2194e2e07adca668774d0f745af7f782e6e9d0513f208d33d0" },
      { operation: "todo.workitem.claim", operationId: "ad6b10fc-0052-4c80-a522-aa25cd9736e1", resultSha256: "dbe45acb20e6194f0c01723cbce4f35be3397e618aee10db5cdde0d329a2d26c" },
      { operation: "todo.workitem.transition", operationId: "653fc425-74f0-49f3-8247-f2033838b368", resultSha256: "26f9ad450bf2db807a6a0823b0979ea2cced2acf0bb2d8495a4bb60ce3a8afc3" },
    ],
    observations: { actualRenderedDom: true, publicDialogCount: 8, genesisDialogCount: 2,
      approvedGenesisRequestSha256: "62727995d10c36f7f95ee461a6864061f7745a740d7579986a93994979218e03",
      noNamedReadModalStages: ["native-todo-genesis-read-empty", "native-todo-genesis-read-created",
        "native-todo-genesis-retrieve", "native-todo-genesis-token-refusal"],
      liveHelperB1AndRestoredQualified: false, oneBoardB1BytesReceiptsAndStoppedImagePreserved: true,
      originalB0BytesRestored: true, noBoardOrNativeAuthorityRestored: true,
      sourceRevocationRenewal: false, transportCancelRecovery: false, humanAcceptance: false, workerEnrollment: false,
      editorExitCode: 0, profileRemoved: true, nativeModelChannelUnavailable: true, fullCutoverQualified: false },
    assertionRefs: ["clients/vscode-host/installed-native-todo-genesis.mjs#verifyInstalledNativeTodoGenesis",
      "clients/vscode-host/installed-native-todo-genesis.mjs#verifyInstalledNativeTodoGenesisB1",
      "clients/vscode-host/installed-native-todo-genesis.mjs#verifyInstalledNativeTodoGenesisRestored"],
    referenceSourcePins: [
      { file: "clients/vscode-host/installed-native-todo-genesis.mjs", sha256: "c6d21f8b854e7ca4d389f5975eb1736259cc12ba19263ebb28f5f133e0550890" },
      { file: "clients/vscode-host/installed-native-todo-genesis-ui.mjs", sha256: "fbf0f867a5982e553018950d30333fdbfc2fdfbd6c1d8c9e695a633450d96d03" },
    ],
    sourceReferenceScope: "Historical assertion navigation only; immutable report/new candidate/payload/root pins bind this profile, never old ADE8 artifact reassignment.",
    remainingGaps: ["source revocation/renewal", "pending/transport recovery", "worker enrollment/human acceptance",
      "all original34 Todo operations/old-Board rebind", "general namespace/folder/overwrite permission", "full151/shared-root/cutover"],
    portability: "No external artifact or private Root is opened by the static checker.",
  };
}

function installedTodoEffectCase() {
  const assertion = `reviewedEvidence.${INSTALLED_TODO_EVIDENCE_ID}`;
  const read = (operation, stage, oracle) => ({ operation: id(operation), stage, assertion: `${assertion}: ${oracle}` });
  return {
    id: INSTALLED_TODO_CASE_ID, operations: TODO_OPERATIONS, executionProfile: "installed-native-isolated",
    runner: { file: "clients/vscode-host/installed-test.mjs", scenarioArgument: "--native-todo-genesis",
      requiredFlags: ["--native-identity", "--cold-component", "--legacy-vsix"],
      definition: "clients/vscode-host/installed-native-todo-genesis.mjs#verifyInstalledNativeTodoGenesis",
      authority: "Exact installed public+GENESIS dialogs, actual call stages and canonical receipt/source-ledger assertions, not catalog originalIds counting." },
    reviewedEvidenceRefs: [INSTALLED_TODO_EVIDENCE_ID],
    stages: [
      read("todo_board_create", "genesis-deny-approve-create", "public Deny, separate GENESIS Deny then exact one Board/Note/pair creation; source/knowledge identity/epoch/namespace/catalog binding and one creation receipt"),
      read("get_board", "read-empty-board", "exact empty digest/actor/current source; no named read modal"),
      read("list_boards", "retrieve-board", "actual queried Board result total one"),
      read("add_workitem", "write-planning-task", "Planning task/no owner; second canonical receipt"),
      read("get_workitem", "read-created-task", "actual read equals created response"),
      read("update_workitem", "planning-CAS-edit", "title edit/omitted schedule preserved, stale CAS no journal change; update receipt"),
      read("claim_workitem", "authenticated-claim", "mcp:external WIP owner, claim receipt; no worker/reviewer grant"),
      read("change_workitem_state", "on-hold-transition", "OnHold/no acceptance/outcome and transition receipt"),
      read("get_workitem", "read-final-state", "actual final read equals held task/digest"),
      read("list_workitems", "retrieve-filtered-task", "OnHold query yields exact task"),
      read("list_workitem_history", "retrieve-audit", "exact create/edit/claim/transition, authenticated actor"),
      read("list_board_changes", "retrieve-change-ids", "exact four stable event IDs"),
      read("note_work_items", "paired-source-snapshot", "pair digest and generated history match canonical state"),
      { operation: null, stage: "refusal-only-not-worker-reviewer", assertion: `${assertion}: invalid worker token and wrong-lane accept request refused; no worker enrollment/human acceptance coverage` },
      { operation: null, stage: "independent-B1-fresh-B0", assertion: `${assertion}: separate stopped B1 image/Note/pair/canonical Board/source-ledger receipt proof then exact fresh B0/no Board or grants, editor0/profile removed; early leaf B1 flag stays false` },
    ],
    oracle: `${assertion}: twelve actual original-ID calls under real installed catalog/Host/source namespace approval; full result/metadata/digest/history and rendered dialog rows, not Source proxy IDs`,
    receipt: `${assertion}: one Board creation plus four Planning canonical receipt UUID/result hashes and exact source ledger/root/epoch binding`,
    preservation: `${assertion}: separate later B1 stopped-image/source bytes and fresh B0 proof; no renewal/pending recovery/workers/reviewer or full34/full151 assertion`,
  };
}

function installedInplaceEvidence() {
  return {
    level: "installed", executionProfile: "installed-native-isolated", operations: INSTALLED_INPLACE_OPERATIONS,
    review: "Parent actually ran and reviewed this entire installed profile and explicitly approved exactly four original IDs for existing-resource in-place update plus immediate read; not new CRUD, restart or full-root qualification.",
    uri: "file:///home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-todo-b1-private-inplace-regression-installed.json",
    sha256: "84d83310ca59bb958d2869d22d7546073fec53a9a2ce533abf27926a4089ee31",
    reportSchema: "pkm.installed-host-acceptance/v1", timestamp: "2026-11-22T18:15:22.023Z",
    candidateVsixSha256: "6367a908d10fcede19a3d76a40b93f9cf63dfb0375eb24ec53029cfd867d9075",
    payloadBuildId: "00564b3c8dabc4c5e35906180981faf623d1f2322d43b587f2c94f5aee6a16d7",
    originalWriterVsixSha256: "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27",
    selectors: {
      live: "/coldComponent/nativePrivateInplace",
      receiptIds: "/coldComponent/nativePrivateInplace/outcomes",
      preservation: "/coldComponent/privateInplacePreservation",
      closedEditor: "/coldComponent/actualEditorFullyClosedBeforeB1",
      exit: "/electronExitCode", uninstall: "/installation/uninstalled", profileRemoval: "/profileRemoved",
    },
    bindingReview: {
      assertion: "clients/vscode-host/installed-native-knowledge-move.mjs#assertInstalledKnowledgeMoveComponentBinding",
      scope: "Parent-reviewed exact genuine Host/Storage/Core/Root binding, private installed profile and typed cold/B1/fresh-B0 workflow; helper verifies current payload, custody and workspace lease.",
      exportedColdRootSha256: null, exportedColdProfileSha256: null,
      limitation: "Report does not export those cold binding digests. Do not invent them, substitute the earlier source-picker fingerprint or infer same-root restart/whole-root cutover.",
    },
    canonicalReceipts: [
      { operation: id("update_note"), stage: "content", operationId: "f57dfbbd-7a0d-4588-8d9e-99fa315b1302" },
      { operation: id("update_note"), stage: "metadata", operationId: "df6f0a0b-7da5-4485-8610-2ae507d645a7" },
      { operation: id("update_paper"), stage: "content", operationId: "63a07105-5a9e-4760-aca7-5e9c345f9d30" },
      { operation: id("update_paper"), stage: "metadata", operationId: "213f1cd0-2c3c-428a-b6ea-2e0b284c1827" },
    ],
    observations: {
      publicDialogCountAcrossWholeProfile: 11, wholeProfileCanonicalReceipts: 6, mappedCanonicalReceipts: 4,
      mappedImmediatePublicReads: 4, observedPrivateResourceDialogs: 0, resourceCopies: 0,
      newPrivateUriDenialsBeforeIntent: 3, publicNoteDenials: 2,
      liveHelperB1AndB0Qualified: false, independentB1SixReceiptsCommitmentsAndPrivateControlsPreserved: true,
      freshB0AllOriginalBytesRestoredWithoutDatabaseOrGrant: true, editorFullyClosedBeforeB1: true,
      electronExitCode: 0, uninstalled: true, profileRemoved: true, productionCutover: false,
    },
    assertionRefs: [
      "clients/vscode-host/installed-native-private-inplace.mjs#installedNativePrivateInplaceSteps",
      "clients/vscode-host/installed-native-private-inplace.mjs#prepareInstalledNativePrivateInplaceFixture",
      "clients/vscode-host/installed-native-private-inplace.mjs#verifyInstalledNativePrivateInplace",
      "clients/vscode-host/installed-native-private-inplace.mjs#verifyInstalledNativePrivateInplaceB1",
      "clients/vscode-host/installed-native-private-inplace.mjs#verifyInstalledNativePrivateInplaceRestored",
    ],
    referenceSourcePins: [
      { file: "clients/vscode-host/installed-native-private-inplace.mjs", sha256: "5053eeeaa9f8801463dbc070ba9d16c16066795bbf33e5f8aa59702882b7f00b" },
      { file: "clients/vscode-host/installed-native-private-inplace-ui.mjs", sha256: "d385e3b36d7a49c22a2cc0de0686577c6621080dbb56e42909193dc8d5ec2e23" },
    ],
    sourceReferenceScope: "Captured assertion navigation pins, not a refreshed Source-run attestation. Immutable artifact/candidate/payload and Parent-reviewed binding are authority; no historical artifact reassignment or hash-only rerun.",
    remainingGaps: ["add/list/search operations not mapped", "Skill calls remain outside this four-ID registration",
      "general private publication/rename/category moves", "same-root restart/read and mutation replay",
      "installed transport cancellation/expiry/arbitrary faults", "shared-root/provider/keyring/full151 cutover"],
    portability: "Static checker opens no external artifact or private Root; exact report selectors retain the separate early leaf and later independent preservation proofs.",
  };
}

function installedInplaceEffectCase() {
  const assertion = `reviewedEvidence.${INSTALLED_INPLACE_EVIDENCE_ID}`;
  const stages = ["note", "paper"].flatMap(kind => [
    { operation: id(`update_${kind}`), stage: "existing-content-update", arguments: { slug: "Old/Before" },
      assertion: `${assertion}: content equals the exact prepared ${kind} fixture contents (stored normalized private links and ignored examples); public result deep-equals {ok:true,slug:'Old/Before'}, raw Markdown matches pinned original Upsert ID/revision/content/aliases and Paper file metadata; one receipt and publication-free commit digest` },
    { operation: id(`get_${kind}`), stage: "immediate-read-after-content", arguments: { slug: "Old/Before" },
      assertion: `${assertion}: actual public get_${kind} content equals the just-verified raw Markdown content, with no private plaintext` },
    { operation: id(`update_${kind}`), stage: "existing-metadata-update", arguments: { slug: "Old/Before", tags: ["inplace-verified"] },
      assertion: `${assertion}: exact public ok/slug response and original Upsert stable identity/revision/content/aliases/Paper-file oracle; one distinct canonical receipt, no intent remains, exact commitment and unchanged controls` },
    { operation: id(`get_${kind}`), stage: "immediate-read-after-metadata", arguments: { slug: "Old/Before" },
      assertion: `${assertion}: actual public get_${kind} content equals the just-verified raw Markdown; metadata is independently checked through original-writer/raw assertions, not an invented public field assertion` },
  ]);
  return {
    id: INSTALLED_INPLACE_CASE_ID, operations: INSTALLED_INPLACE_OPERATIONS, executionProfile: "installed-native-isolated",
    runner: { file: "clients/vscode-host/installed-test.mjs", scenarioArgument: "--native-private-inplace",
      requiredFlags: ["--native-identity", "--cold-component", "--legacy-vsix"],
      definition: "clients/vscode-host/installed-native-private-inplace.mjs#verifyInstalledNativePrivateInplace",
      authority: "Parent-reviewed actual installed public calls and binding/receipt assertions; only four approved original IDs, not whole-profile call counts." },
    reviewedEvidenceRefs: [INSTALLED_INPLACE_EVIDENCE_ID],
    stages: [...stages,
      { operation: null, stage: "public-denial-and-new-uri-refusal",
        assertion: `${assertion}: two Note public denials and three new-private-URI ACCESS_DENIED refusals preserve all bytes/journal before intent; zero private dialogs/copies, no relocation/moveTo in actual commits` },
      { operation: null, stage: "independent-B1-fresh-B0",
        assertion: `${assertion}: Parent-reviewed closed-editor typed B1 preserves six exact receipts/commitments/private controls; fresh B0 restores all original bytes without native database/grants; early live B1/B0 flag remains false` },
      { operation: null, stage: "closed-editor-uninstall-profile-cleanup",
        assertion: `${assertion}: actual editor/coordinator exit zero, extension uninstalled and private profile removed; no production cutover` },
    ],
    oracle: `${assertion}: exact existing-resource update arguments and public responses plus four immediate original get calls; pinned original-writer/raw ID/revision/content/aliases/Paper-file assertions, no add/list/search or new read modal`,
    receipt: `${assertion}: four mapped update UUIDs with actor/result/id/path/revision/hash and commitment-digest checks, no remaining intent/publication plan; whole-profile six receipts are preservation support, not six original IDs`,
    preservation: `${assertion}: unchanged private resources/referrers/folders/pairs/policy and separate later six-receipt B1/fresh-B0 proof; no same-root restart/replay/transport-cancel/full-root qualification`,
  };
}

function installedSkillPaperTrashEvidence() {
  return {
    level: "installed", executionProfile: "installed-native-isolated", operations: INSTALLED_SKILL_PAPER_TRASH_OPERATIONS,
    review: "Parent approved exactly two original post-admission public unshared Skill/Paper owned-pair deletes after two actual complete installed runs and exact final receipt/UI/B1/fresh-B0 checks; not list_papers, generic file Trash, old-bucket restore or full Trash parity.",
    uri: "file:///home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-skill-paper-trash-installed-qualified.json",
    sha256: "28413339c102231b0626f1b7a7f7576119116f4b392c6691690d9b98219d3886",
    reportSchema: "pkm.installed-host-acceptance/v1", timestamp: "2026-11-22T20:17:25.311Z",
    candidateVsixSha256: "b4a69339739b79dd93f9fb1f914a5b90a03e1b79adde0db63b9b4ae3cc184684",
    payloadBuildId: "cf4755e48726172888b928a6b27ab27edd5a1fcca7984d90b959e352cc8b89f2",
    originalWriterVsixSha256: "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27",
    runProvenance: {
      actualFullInstalledReruns: ["19648", "19650"], parentExactFinalChecks: "19651",
      helperChecks: { passed: 6, skipped: 0, phase: "Parent-provided pre-final-proof-field-fix helper run",
        currentHelperSourceReattestedByThatRun: false, notInstalledQualification: true },
      finalProof: "Proof-field edit was followed by actual full installed reruns; immutable final artifact is not a modified old saved JSON or hash-only refresh.",
    },
    selectors: {
      live: "/coldComponent/nativeSkillPaperTrash", binding: "/coldComponent/nativeSkillPaperTrash/binding",
      owners: "/coldComponent/nativeSkillPaperTrash/owners", canonicalReceipts: "/coldComponent/nativeSkillPaperTrash/canonicalReceipts",
      transitions: "/coldComponent/nativeSkillPaperTrash/custodyTransitions", dialogs: "/coldComponent/nativeSkillPaperTrash/actualDialogs",
      oldReceiver: "/coldComponent/heldTrashParser", B1FreshB0: "/coldComponent/skillPaperTrashPreservation",
      B1Image: "/coldComponent/b1", exit: "/electronExitCode", uninstall: "/installation/uninstalled", profileRemoval: "/profileRemoved",
    },
    rootBinding: {
      root: "/home/yuwang8/.local/state/pkm-v5-recovery/native-cold-d26cf451-642c-46b2-83de-ad75a4d609bf/root",
      workspaceId: "45c329cd-6244-40cd-b8dd-647e959df0a3", catalogSha256: ORIGINAL_METADATA_SHA256,
      profileSha256: "dcd45ab973ec69999360f9be84254e341859f2fe771d636b58884ba4d92900d5",
      custodyPlanSha256: "e0cb5f0640339675f64c1676eafc06c6a2e1adbb7c1d9825a81fd1a4358c15eb",
      privacySha256: "9e1f9e89c775ae1db78231635fec9924eca67b9bd812b2390a1f6291c334a70d",
      epoch: "f1e53809-950f-4098-8d85-6ac8f41c6948",
      nativeHostReceiptSha256: "caf991995476a967774696ce5b020ab25182347366c9c9c6ffdf249c02c1e5b3",
    },
    publicCalls: [
      { operation: id("delete_skill"), area: "skills", arguments: { name: "SkillTrashOwner" },
        argumentsDigest: "808867f043620ec5d55e653cb9515ac43cf40b49aa63b8a92f71d71a4b4049d5",
        path: "SkillPaperTrash/SkillTrashOwner.md", pairPath: "SkillPaperTrash/SkillTrashOwner.assets",
        knowledgeId: "knowledge_972ab4cdd3a0d762ccad25b7", revision: 2,
        rawSha256: "d331f09987e17bfeaf3e0cf4b660800d32a613572f1d289898ed085afeccb014" },
      { operation: id("delete_paper"), area: "papers", arguments: { slug: "SkillPaperTrash/PaperTrashOwner" },
        argumentsDigest: "6a3e7641ef447cc97d030616bbc202624efa18f9d5ef7e50b6cda0d744ca6bc7",
        path: "SkillPaperTrash/PaperTrashOwner.md", pairPath: "SkillPaperTrash/PaperTrashOwner.assets",
        knowledgeId: "knowledge_e9ea11cec5ee328db96813b3", revision: 2,
        rawSha256: "86467da1dd7545265b86667c0fb6cd60ff22e120ea06faebe622023a27c8b6f4" },
    ],
    canonicalReceipts: [
      { operationId: "39e23e2e-bfcf-4281-b4b5-e9c65909d496", operation: "knowledge.trash.restore", actorId: "mcp:external",
        fingerprint: "4706a2a5e1291c0e501f059d3e063403e5cb4adfbaadd1a29e650fb0bf52a8de",
        resultSha256: "b9d4ceac342991a694b41f3388a101ec2954ba4e3e84a1310f773780dc93ede2" },
      { operationId: "bffc6f3b-210c-4c0e-9073-b9ebea5bab7a", operation: "knowledge.trash.move", actorId: "mcp:external",
        fingerprint: "d0a3a8001ccdd9c6d5426e2cf2ab69ac8e314b0ba3c4fe0b6cb9bb3c98fd2709",
        resultSha256: "88c426f4cf4e13110f7b898f62c8c57cb5caa2eaff0dd7cc790cebd6739df20f" },
      { operationId: "f0752df1-e955-4690-a2b6-fd8488110760", operation: "knowledge.trash.move", actorId: "mcp:external",
        fingerprint: "ed4e5c2a2e9f659bfd3333e53ceed61de074d9f1e413b1c08d84d15ca8a4219e",
        resultSha256: "ffa15395cd40076d8db48a7215c4d4939a5514bd598aff4688d8933d31de3b4d" },
      { operationId: "fbc52b66-c1e2-44ad-9335-6234f6e231a0", operation: "knowledge.trash.restore", actorId: "mcp:external",
        fingerprint: "da9f914fdb6845e3b0ad85e9ae0444cf46635f998e0f99ff9aa751a6b9f85503",
        resultSha256: "dcc9f58210bf43a65095b0d77186062b3874a6d96952bd9f6925cef25567e670" },
    ],
    custodyTransitions: [
      { operationId: "bffc6f3b-210c-4c0e-9073-b9ebea5bab7a", action: "move", area: "skills",
        requestSchema: "pkm.original-native-trash-request/v2", selectionAreas: ["skills"],
        requestSha256: "dfef6312abb55d922071a77351ca593c695b5776746f1d18c19a9b3f48bd1295" },
      { operationId: "39e23e2e-bfcf-4281-b4b5-e9c65909d496", action: "restore", area: "skills",
        requestSchema: "pkm.original-native-trash-request/v2", selectionAreas: ["skills"],
        requestSha256: "9c6b68abe86c15a1c9e16a2dc52ea7cc2acce2bd43180ff14d9db086f7ee38eb" },
      { operationId: "f0752df1-e955-4690-a2b6-fd8488110760", action: "move", area: "papers",
        requestSchema: "pkm.original-native-trash-request/v2", selectionAreas: ["papers"],
        requestSha256: "74e067cbbc5503e763aca3de790c63040fe7a0c47c2201cbae3bfd6269ab012c" },
      { operationId: "fbc52b66-c1e2-44ad-9335-6234f6e231a0", action: "restore", area: "papers",
        requestSchema: "pkm.original-native-trash-request/v2", selectionAreas: ["papers"],
        requestSha256: "8d56d3c7c7513ba56e0cf5d2cc1d1dcb8369a38ff011e910787ffc8b1c552d53" },
    ],
    heldReceiverSchemaProbe: {
      heldVsixSha256: "e87602ed6ef34660c0af0c577ad33d5e9cd841b3a6b0d8e47a69763e20d71725",
      heldPayloadBuildId: "6116952f74b1087cd364a21dbaad8908f7193245ae8bf6de7c239d0d0d0b63cf",
      heldManifestSha256: "2b24bf5b8a3de77654922e28246057d53021e8a2ed737743bd91000eeda87765",
      heldModuleSha256: "cd753c8fef3585448bce4006a7a1b5d5bde2511345fccd03ae52b58e23e7ecf4",
      refusedMoveRequestSha256: ["dfef6312abb55d922071a77351ca593c695b5776746f1d18c19a9b3f48bd1295",
        "74e067cbbc5503e763aca3de790c63040fe7a0c47c2201cbae3bfd6269ab012c"],
      compatibleNoteV1DtoAccepted: true, noteControlSchemaOnly: true, oldOwnerServingQualified: false,
      oldNativeServiceDispatchQualified: false, nativeAuthorityFromPacketCopies: false,
      scope: "Genuine receipt/UI-linked Skill/Paper v2 DTOs refused by the actual sealed old module/Zod closure; Note v1 acceptance is schema-only, zero original operations and no old serving.",
    },
    preservationPins: {
      b1Sha256: "c63e4b1d0d9b3cd39652dfcfdeb1f2aa1294dca2bc9c9ea9173df83a42eb9852",
      stoppedCoreSha256: "336676663517c0921476ba965abd4b32b5b8174b977a11568f7fa8a3e61bdc44",
      sidecarScope: "Actual B1 manifest rows, archive and payload sidecar byte/hash comparisons; WAL zero when present. No invented unexported sidecar digest and no archived SQLite reopen.",
    },
    observations: {
      actualInstalledNativeUi: true, publicDialogCount: 9, targetDialogCount: 12, observerStageAcknowledgements: 23,
      exactOriginalRawKnowledgeIdRevisionPairHistory: true, sameOwnerLeaseAndCoreDatabase: true,
      privateControlsPreservedSharedAndStaleRefusalsNoEffect: true, canonicalUuidReplayNoEffectOrReview: true,
      paperListValidationRequiredSeparatePublicApproval: true, paperListOperationParityQualified: false,
      liveHelperSealedV1ReceiverRefusalQualified: false, separateHeldV1SchemaProbeQualified: true,
      liveHelperB1AndB0Qualified: false, separateStoppedB1AndFreshB0Qualified: true,
      archivedSqliteReopenedForPreservation: false, oldReadonlyBucketRestoreQualified: false,
      genericKnowledgeFileTrashQualified: false, installedDestinationCollisionQualified: false, installedPendingRecoveryQualified: false,
      electronExitCode: 0, uiExitCode: 0, uninstalled: true, profileRemoved: true, fullTrashParityQualified: false, productionCutover: false,
    },
    referenceSourcePins: [
      { file: "clients/vscode-host/installed-native-skill-paper-trash.mjs", sha256: "59a3c39d1e2717c3cc14e2ccaccfaf5c3ebebd911254b006e65357740ea5f2c8" },
      { file: "clients/vscode-host/installed-native-skill-paper-trash-ui.mjs", sha256: "e9d9737b548a96d87dc5586be71a7413f77cb8fc0059ba7464fafaf21cd9d66d" },
      { file: "clients/vscode-host/installed-native-skill-paper-trash.test.mjs", sha256: "37077c9d1ec50fa4ce5726d4fc49c4fa9d99c69122b717ce9cb8ae58ebec1ad1" },
      { file: "clients/vscode-host/installed-native-knowledge-move.mjs", sha256: "7cc8e693fedbd15491cf9a0456606e09bb5b0b3b5b08224f3aee4ae42aa889f8" },
      { file: "clients/vscode-host/installed-native-trash.mjs", sha256: "3ebcc6b84e562155ac0afcac20bde367c42d3c5053ace7ca84d1a8019676f3b9" },
      { file: "tests/original-knowledge-writer-fixture.mjs", sha256: "f4151aa28df50ec1ab2593e5aa94248ce7c409053a0477102cfa4e3c1601892d" },
    ],
    sourceReferenceScope: "Captured final assertion/support navigation pins; immutable installed rerun/report/candidate is authority. Pre-field-fix six helper tests do not re-attest current helper bytes. No existing Source attestation or old Note artifact is refreshed/reassigned.",
    remainingGaps: ["list_papers parity explicitly unqualified despite its separate public validation call",
      "generic knowledge_file_trash native operation", "old readonly-bucket restore", "installed destination collision",
      "installed pending recovery", "installed transport cancellation/expiry/same-root restart",
      "general private/shared-root/provider/keyring/full151 cutover"],
    portability: "Static checker never opens this external artifact, the held archive or private Root. Canonical restores/schema controls are supporting stages, not invented original restore aliases.",
  };
}

function installedSkillPaperTrashEffectCase() {
  const assertion = `reviewedEvidence.${INSTALLED_SKILL_PAPER_TRASH_EVIDENCE_ID}`;
  return {
    id: INSTALLED_SKILL_PAPER_TRASH_CASE_ID, operations: INSTALLED_SKILL_PAPER_TRASH_OPERATIONS, executionProfile: "installed-native-isolated",
    runner: { file: "clients/vscode-host/installed-test.mjs", scenarioArgument: "--native-skill-paper-trash",
      requiredFlags: ["--native-identity", "--cold-component", "--legacy-vsix", "--held-old-trash-parser-vsix", "--held-old-trash-parser-sha256"],
      definition: "clients/vscode-host/installed-native-skill-paper-trash.mjs#verifyInstalledNativeSkillPaperTrash",
      authority: "Two exact actual original deletes in the independently reviewed installed profile; canonical restore and schema-only controls do not add original IDs." },
    reviewedEvidenceRefs: [INSTALLED_SKILL_PAPER_TRASH_EVIDENCE_ID],
    stages: [
      { operation: id("delete_skill"), stage: "public-skill-owned-pair-delete",
        assertion: `${assertion}: actual {name:'SkillTrashOwner'} with separate public/per-target default-Deny choices; Skill kind/name, exact raw hash/revision 2 and pair bytes physically moved, one receipt and strict v2 skills custody transition` },
      { operation: id("delete_paper"), stage: "public-paper-owned-pair-delete",
        assertion: `${assertion}: actual {slug:'SkillPaperTrash/PaperTrashOwner'} with independent public/per-target choices; item kind/PaperTrashOwner.md, exact raw hash/revision 2 and pair bytes physically moved, one receipt and strict v2 papers transition` },
      { operation: null, stage: "denial-private-shared-stale-preservation",
        assertion: `${assertion}: public/target denials, private-referrer/shared conflict and stale restore preserve files/directories/history/intents/receipts/successors; no private publication or extra authority` },
      { operation: null, stage: "canonical-list-read", nativeOperation: "knowledge.trash.list",
        assertion: `${assertion}: independently approved exact area/entry IDs and empty restored list; supplemental native stage, no original Trash-list alias` },
      { operation: null, stage: "canonical-owned-pair-restore", nativeOperation: "knowledge.trash.restore",
        assertion: `${assertion}: exact restored raw hashes, original identity/revision 2, opaque pairs and original history; two restore UUID/fingerprint/result hashes, matching v2 area/request SHA; no original restore alias` },
      { operation: null, stage: "canonical-uuid-replay-and-missing-refusal",
        assertion: `${assertion}: same restore UUID returns without effect/review, new missing-entry request refused; no new intent/receipt or installed pending-recovery claim` },
      { operation: null, stage: "supporting-paper-list-not-parity",
        assertion: `${assertion}: list_papers readOnly=false validation required its own public approval but only checks absence; paperListOperationParityQualified remains false and list_papers is not registered` },
      { operation: null, stage: "actual-held-v1-schema-only-control",
        assertion: `${assertion}: actual sealed e876 module/Zod refuses both genuine receipt/UI-linked v2 move requests; Note v1 DTO accepted schema-only, not old Owner/native dispatch or an original operation` },
      { operation: null, stage: "independent-stopped-B1-fresh-B0",
        assertion: `${assertion}: separate typed B1 preserves exact stopped Core/sidecar image hashes, WAL zero when present, pairs/history; fresh B0 exact all original bytes/no DB/grants. No archived SQLite reopen or promotion of early false leaf flags` },
      { operation: null, stage: "closed-editor-ui-uninstall-profile-cleanup",
        assertion: `${assertion}: complete installed rerun, 9 public/12 Trash dialogs and 23 run/stage acknowledgements; editor/UI exit zero, uninstall/profile removal, no production cutover` },
    ],
    oracle: `${assertion}: exact Original public arguments/result/RAW identity/revision/pair/history and receipt/UI-linked homogeneous v2 areas; no borrowed Note/list/generic file or old-bucket coverage`,
    receipt: `${assertion}: four canonical move/restore UUIDs, actor/fingerprint/result SHA and matching custody/UI request SHAs under exact Root/profile/catalog/epoch; supplemental restore adds no original ID`,
    preservation: `${assertion}: unchanged private/referrer/shared controls and independently reviewed stopped B1 image/sidecars/fresh B0; not reopened B1 rows, pending recovery/destination collision or full Trash readiness`,
  };
}

function validateSkillPaperTrashEvidence(evidence) {
  assert.deepEqual(evidence.operations, INSTALLED_SKILL_PAPER_TRASH_OPERATIONS, "Skill/Paper v2 cannot borrow Note/list/generic original IDs");
  assert.equal(new Set(evidence.canonicalReceipts.map(receipt => receipt.operationId)).size, 4, "Skill/Paper receipts must be four distinct effects");
  for (const call of evidence.publicCalls) {
    assert.equal(call.operation, id(call.area === "skills" ? "delete_skill" : "delete_paper"));
    const transitions = evidence.custodyTransitions.filter(transition => transition.area === call.area);
    assert.deepEqual(transitions.map(transition => transition.action), ["move", "restore"], "Skill/Paper area must own its move and restore");
    for (const transition of transitions) {
      assert.equal(transition.requestSchema, "pkm.original-native-trash-request/v2", "Skill/Paper provenance must remain strict v2, not Note v1");
      assert.deepEqual(transition.selectionAreas, [call.area], "Skill/Paper v2 selections must be homogeneous and area-bound");
      const receipt = evidence.canonicalReceipts.find(receipt => receipt.operationId === transition.operationId);
      assert.equal(receipt?.operation, `knowledge.trash.${transition.action}`, "Skill/Paper request must match the exact canonical receipt");
      assert.equal(receipt.actorId, "mcp:external");
      for (const digest of [receipt.fingerprint, receipt.resultSha256, transition.requestSha256])
        assert(/^[a-f0-9]{64}$/.test(digest));
    }
  }
  assert.deepEqual(evidence.heldReceiverSchemaProbe.refusedMoveRequestSha256,
    evidence.custodyTransitions.filter(transition => transition.action === "move").map(transition => transition.requestSha256),
    "Held v1 refusal must refer to the genuine v2 move requests, not fabricated DTOs");
  assert.equal(evidence.heldReceiverSchemaProbe.noteControlSchemaOnly, true, "Note v1 control grants no serving qualification");
  for (const key of ["oldOwnerServingQualified", "oldNativeServiceDispatchQualified", "nativeAuthorityFromPacketCopies"])
    assert.equal(evidence.heldReceiverSchemaProbe[key], false);
  for (const key of ["paperListOperationParityQualified", "oldReadonlyBucketRestoreQualified", "genericKnowledgeFileTrashQualified",
    "installedDestinationCollisionQualified", "installedPendingRecoveryQualified", "archivedSqliteReopenedForPreservation"])
    assert.equal(evidence.observations[key], false, "Skill/Paper scope cannot promote unqualified operations or preservation methods");
  assert.deepEqual(evidence.referenceSourcePins.map(source => source.file),
    installedSkillPaperTrashEvidence().referenceSourcePins.map(source => source.file),
    "Installed Skill/Paper assertion and direct support pins are required");
  for (const source of evidence.referenceSourcePins)
    assert(/^[a-f0-9]{64}$/.test(source.sha256), "Installed Skill/Paper support digest is required");
}

function installedNotePaperBasicEvidence() {
  return {
    level: "installed", executionProfile: "installed-native-isolated", operations: INSTALLED_NOTE_PAPER_OPERATIONS,
    review: "Parent approved only six previously unmapped installed create/list/search original IDs after two complete fresh PUBLIC Note/Paper profile successes and exact final checks; existing get/update in-place IDs retain their old 6367 artifact mapping.",
    uri: "file:///home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-note-paper-basic-installed-qualified.json",
    sha256: "b04b132a6d60552e308185a54baba842f88bd2c3ef3fda1e14f7963ab93d6b87",
    reportSchema: "pkm.installed-host-acceptance/v1", timestamp: "2026-11-22T21:00:51.463Z",
    candidateVsixSha256: "5948d45b8c09afcc1492a0d1c38ea58c95f3c5284ea3c8b0367979587b19b078",
    payloadBuildId: "a1fedd37b87b39d150332a2cb9b035152e90485e0d38a86b2e4656133e4cb2f9",
    originalWriterVsixSha256: "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27",
    originalMcpSourceSha256: "2a5f623b20b71e3d3ce12283db1fbcb01fb5fa4b43ebbf29d2fd9a28a992f948",
    runProvenance: {
      actualFullInstalledReruns: ["19714", "19717"], parentExactFinalChecks: "19719",
      helperChecks: { passed: 5, skipped: 0, phase: "Parent-provided helper run before final detail fields",
        currentHelperSourceReattestedByThatRun: false, notInstalledQualification: true },
      finalProof: "Final detail fields and PUBLIC-root privacy fix are attested by the actual new candidate/profile, never edited old saved artifacts, source test totals or hash-only refresh.",
    },
    selectors: {
      live: "/coldComponent/nativeNotePaperBasic", binding: "/coldComponent/nativeNotePaperBasic/binding",
      outcomes: "/coldComponent/nativeNotePaperBasic/outcomes", receipts: "/coldComponent/nativeNotePaperBasic/canonicalReceipts",
      documents: "/coldComponent/nativeNotePaperBasic/createdDocumentRows", dialogs: "/coldComponent/nativeNotePaperBasic/actualDialogs",
      B1FreshB0: "/coldComponent/notePaperBasicPreservation", B1Image: "/coldComponent/b1",
      exit: "/electronExitCode", uninstall: "/installation/uninstalled", profileRemoval: "/profileRemoved",
    },
    rootBinding: {
      root: "/home/yuwang8/.local/state/pkm-v5-recovery/native-cold-7ddec360-c9af-497c-a172-ae87c2e13b12/root",
      workspaceId: "207c87c9-b763-494e-b7b8-97507e964b6c",
      custodyPlanSha256: "8d91500fa49248c010b768a8b59ae1c929c0556e2bc3ad88c766c555f2b19f02",
      catalogSha256: ORIGINAL_METADATA_SHA256,
      profileSha256: "156b5077ae0ec18d40a13886ce56d685f29260967d88a168be414be825dad8e2",
      privacySha256: "9e1f9e89c775ae1db78231635fec9924eca67b9bd812b2390a1f6291c334a70d",
      epoch: "3f246b82-dd2c-4950-8ff2-e45cdcbd6868",
      nativeHostReceiptSha256: "05d6028b6be2ae8d23d465f1d8ede89a9745082e663d9461bae106a235884760",
    },
    createCalls: [
      { operation: id("add_note"), arguments: { title: "BasicCreatedNote", category: "BasicPublic", content: "basicnotebodyoldunique\n" },
        argumentsDigest: "9f1afce41c76a74a3e457dfb66178bbc87b34c882d1307333427d9c4edeb3570" },
      { operation: id("add_paper"), arguments: { title: "BasicCreatedPaper", category: "BasicPublic",
        topic: "basicpapermetadataoldunique", content: "basicpaperbodyonlyunique\n" },
        argumentsDigest: "9765b8d7740ebdffa7278582f153fb3b31614828a76c683016cec5736f2eb5cf" },
    ],
    canonicalReceipts: [
      { operationId: "42efa7bb-633a-42cb-90a5-213636b84bb8", operation: "knowledge.note.create", actorId: "mcp:external",
        fingerprint: "92a7276d40f236e0eca7ae9502991e9aefff72a3de36d27c7a7006678477fac5",
        resultSha256: "ad21a80d67639ef496dbd27e4e8ad03668adb9afa77d9e274eadf03946c87caa" },
      { operationId: "1fa14b8d-c52b-4cdf-aff6-8886dd7cd716", operation: "knowledge.note.update", actorId: "mcp:external",
        fingerprint: "83b4f25e30fc34aca36c14ea8901f596111d8ec3cf57a118862cf9deb19a35a1",
        resultSha256: "8809aa23aa0bd846fa65955aa05bf10690c3e8147367dc172219d4454f74e174" },
      { operationId: "7cb78ee8-c487-4702-9bd2-d09931ed5a3e", operation: "knowledge.research.create", actorId: "mcp:external",
        fingerprint: "45f2b0e9a9b5dbf5d502ff591bf0a7270f25f46ea3d20abcd00380ab15c0d976",
        resultSha256: "b736457bce36cdcf146f4aed0f67831df7bca3b0ae08e65e7bdb55874657d05f" },
      { operationId: "5a43fafa-ff2f-4fbd-93dd-0e64875469f4", operation: "knowledge.research.update", actorId: "mcp:external",
        fingerprint: "7751bed5d3710e3fa7a5e84bd12731d8b2dc033c8bd25ca8eaaa973ec552c68a",
        resultSha256: "92de90e49b60dd0eaa25fdbe24f75b6980b25f4c8c16b9b34355f299116ad979" },
    ],
    documentRevisionProof: [
      { kind: "note", id: "knowledge_08e30e36460adcfd9377bb52", path: "BasicPublic/BasicCreatedNote.md",
        initialRevision: 1, finalRevision: 2, createReceiptOperationId: "42efa7bb-633a-42cb-90a5-213636b84bb8",
        updateReceiptOperationId: "1fa14b8d-c52b-4cdf-aff6-8886dd7cd716",
        initialRawSha256: "9aa21c8054882411c006a9506860008cd9c91945a98056b8adeeea58b0d9cf62",
        finalRawSha256: "44ed4492e9326f87553e78eb205014cb61b2b291cf6ed5f543d124b66af7fe67" },
      { kind: "paper", id: "knowledge_0a60061f0135795afc0906a9", path: "BasicPublic/BasicCreatedPaper.md",
        initialRevision: 1, finalRevision: 2, createReceiptOperationId: "7cb78ee8-c487-4702-9bd2-d09931ed5a3e",
        updateReceiptOperationId: "5a43fafa-ff2f-4fbd-93dd-0e64875469f4",
        initialRawSha256: "141e3e6eb5b54b66497bce07ec1eed4f14c51ae26c4467cc41fc0cde3fd3c8bd",
        finalRawSha256: "4ad149a20d9b6dfe900d8f28ecb77b1fcf725e71e67eecefff18d60a82a35185" },
    ],
    paperListPublicStages: ["native-note-paper-basic-paper-list-created", "native-note-paper-basic-paper-list-updated"],
    originalSemanticScope: {
      actualClosedOriginalMcpAstOracle: true, originalCreateIsNotUpsert: true, originalMcpRawWriteAssignsIdentity: false,
      nativeIdentityRevisionIncrementSeparatelyProven: true, paperOfflineMetadataOnly: true, paperBodyOnlyControlEmpty: true,
      noteInventoryScope: "BasicPublic category inventory envelope/revision deep-equals actual Original using exact nanosecond mtimes; root fallback compares its BasicPublic subset and excludes Private, not a full-root corpus equivalence claim.",
      rawReaderScope: "Pinned Original22 raw reader checks semantic fields/defaults on compatible native bytes; Original MCP raw Markdown creation does not assign native identity/revision.",
    },
    preservationPins: {
      b1Sha256: "5be065cd999ded077916e35331dbf4b61739e2599cd00fb200b313668e7282de",
      stoppedCoreSha256: "64d045cf0379bd54328c1569b973bdbefc45a0bcb5fa15c9ca9828722c439cee",
      sidecarScope: "Exact captured stopped Core/known sidecar images, WAL zero when present and created/updated Markdown bytes; no archived SQLite reopen or invented sidecar digest.",
    },
    observations: {
      actualComponentInvokeAndNativeUi: true, acknowledgedStageCount: 29, publicDialogCount: 13,
      paperListReadOnly: false, paperListSeparatelyApprovedTwice: true,
      duplicateCreateDenialOccupiedAndPrivateUriNoEffect: true, privateRootFilterNoLeakage: true,
      liveReceiptsSha256: "270c5a39ac533bdecd54ccaaec40a1509b44ece291e559d8edc060db0b8be421",
      installedHostEntrySha256: "25560529d709c7879ad8a5f8a38f1692ce68e0035b375a2944e4343b876de114",
      liveHelperB1AndB0Qualified: false, separateIndependentStoppedB1FreshB0Qualified: true,
      archivedSqliteReopenedForPreservation: false, publicCallerCasArgumentInvented: false,
      publicStaleCasPerformed: false, readOnlyActorLanePerformed: false, semanticOrNetworkPerformed: false,
      electronExitCode: 0, uiExitCode: 0, uninstalled: true, profileRemoved: true, productionCutover: false,
    },
    referenceSourcePins: [
      { file: "clients/vscode-host/installed-native-note-paper-basic.mjs", sha256: "1c26a353f5f26972be1cc3360de02fc209018703ef3cea7a4bc4dc0868d552eb" },
      { file: "clients/vscode-host/installed-native-note-paper-basic-ui.mjs", sha256: "91374b5e49eca5120ff65e7baf4dd5c1add6f3c9ee166b4453eb2e2d9fcf2373" },
      { file: "clients/vscode-host/installed-native-note-paper-basic.test.mjs", sha256: "92f00d43623a4825910e719aa2155b9bbbfe4224ada34bd8e5cc71ec3c795385" },
      { file: "tests/installed-note-paper-basic-oracle.mjs", sha256: "d2cc4bf3b781cf527d8a69c25bc45f2e354c5543eaa874ea99c81b79e08368bf" },
      { file: "tests/original-knowledge-writer-fixture.mjs", sha256: "f4151aa28df50ec1ab2593e5aa94248ce7c409053a0477102cfa4e3c1601892d" },
      { file: "clients/vscode-host/installed-native-knowledge-move.mjs", sha256: "7cc8e693fedbd15491cf9a0456606e09bb5b0b3b5b08224f3aee4ae42aa889f8" },
      { file: "scripts/migration.mjs", sha256: "e52f125ee3f1e2d3613e9921aefbc1dfbbef519f9c182e5cec53ac782cdd9a62" },
    ],
    sourceReferenceScope: "Captured final helper/oracle/support navigation pins, not a new Source-run attestation. Actual installed candidate/report is authority; old get/update and Source attestation hashes are never refreshed or reassigned.",
    remainingGaps: ["existing get_note/update_note/get_paper/update_paper not newly mapped",
      "semantic Paper/Note retrieval, assets/network/read-only actor lane",
      "public stale-CAS arguments absent and not invented", "installed transport cancellation/expiry/same-root restart",
      "general private/shared-root/provider/keyring/full151 cutover"],
    portability: "Static checker opens no external artifact, Original archive or private Root. Only the six approved original create/list/search IDs are installed-qualified.",
  };
}

function installedNotePaperBasicEffectCase() {
  const assertion = `reviewedEvidence.${INSTALLED_NOTE_PAPER_EVIDENCE_ID}`;
  return {
    id: INSTALLED_NOTE_PAPER_CASE_ID, operations: INSTALLED_NOTE_PAPER_OPERATIONS, executionProfile: "installed-native-isolated",
    runner: { file: "clients/vscode-host/installed-test.mjs", scenarioArgument: "--native-note-paper-basic",
      requiredFlags: ["--native-identity", "--cold-component", "--legacy-vsix"],
      definition: "clients/vscode-host/installed-native-note-paper-basic.mjs#verifyInstalledNativeNotePaperBasic",
      authority: "Six exact original PUBLIC create/list/lexical search operations in the actual complete fresh installed profile; existing get/update calls remain supporting only." },
    reviewedEvidenceRefs: [INSTALLED_NOTE_PAPER_EVIDENCE_ID],
    stages: [
      { operation: id("add_note"), stage: "create-public-note",
        assertion: `${assertion}: actual title=BasicCreatedNote/category=BasicPublic/content='basicnotebodyoldunique\\n'; exact Original add result/defaults, native revision 1 and one create receipt; duplicate add is not upsert` },
      { operation: id("list_notes"), stage: "scoped-note-inventory",
        assertion: `${assertion}: actual {directory:'BasicPublic'} before/after update deep-equals Original inventory envelope/revision with exact nanosecond mtimes and created identity` },
      { operation: id("list_notes"), stage: "public-root-note-inventory-private-filter",
        assertion: `${assertion}: actual {} root fallback has directory='' and BasicPublic subset equal to Original; private title/body/metadata never enter results, no full-root equivalence claim` },
      { operation: id("search_notes"), stage: "note-lexical-roundtrip",
        assertion: `${assertion}: actual old/new unique body queries deep-equal closed Original results and locate created/updated slug; old marker and private query return [] after update` },
      { operation: id("add_paper"), stage: "create-public-paper",
        assertion: `${assertion}: actual title=BasicCreatedPaper/category=BasicPublic/topic=basicpapermetadataoldunique/content='basicpaperbodyonlyunique\\n'; exact Original add result/metadata defaults and one native research.create receipt` },
      { operation: id("list_papers"), stage: "paper-list-two-public-approvals",
        assertion: `${assertion}: actual {} twice, Original readOnly=false with two independent PUBLIC approvals; BasicPublic result subset deep-equals full closed Original output before/after update, not the prior Trash absence-only validation` },
      { operation: id("search_papers"), stage: "paper-metadata-only-lexical-roundtrip",
        assertion: `${assertion}: old/new topic marker queries deep-equal actual Original results and locate slug; initial body-only query, old marker after update and private query all [] without semantic/model substitution` },
      { operation: null, stage: "supporting-get-update-native-receipts-not-new-ids",
        assertion: `${assertion}: four existing original get/update calls support exact content/default checks and native same-ID revision 1->2/create-update receipt hashes; Original MCP raw writer assigns no identity/revision, old 6367 mappings stay unchanged` },
      { operation: null, stage: "duplicate-denial-occupied-private-uri-no-effect",
        assertion: `${assertion}: duplicate create returns actual Original refusal; independent PUBLIC update denial, occupied-other identity and new private URI preserve all bytes/intents/receipts; no caller stale-CAS or actor-lane invented` },
      { operation: null, stage: "independent-stopped-B1-fresh-B0",
        assertion: `${assertion}: separate typed B1 preserves exact created/updated/private/prelude bytes and stopped Core/sidecars without SQLite reopen; fresh B0 restores originals without created docs/DB/grants; early leaf remains false` },
      { operation: null, stage: "acknowledged-editor-ui-profile-cleanup",
        assertion: `${assertion}: 29 run/stage ACKs, 13 real PUBLIC dialogs, editor/UI exit zero, uninstall/profile removal and no production cutover` },
    ],
    oracle: `${assertion}: actual closed Original MCP AST handlers and pinned Original22 JS raw-reader semantic defaults/output; no invented original native ID/revision, no alias or Source-test proxy`,
    receipt: `${assertion}: two create and two supporting update UUID/fingerprint/result SHA receipts with exact native identity/revision 1->2/raw hashes under Root/profile/catalog/epoch; only six approved original IDs`,
    preservation: `${assertion}: exact BasicPublic scoped envelopes/nanosecond revision, private-filter/no-effect controls and independent stopped-image B1/fresh B0; no assets/network/semantic/stale-CAS/read-only-lane/restart/full-root claims`,
  };
}

function validateNotePaperBasicEvidence(evidence) {
  assert.deepEqual(evidence.operations, INSTALLED_NOTE_PAPER_OPERATIONS, "Note/Paper basic cannot borrow existing get/update or aliases");
  assert.equal(evidence.observations.paperListReadOnly, false, "Original list_papers must retain its mutating PUBLIC channel");
  assert.deepEqual(evidence.paperListPublicStages, ["native-note-paper-basic-paper-list-created", "native-note-paper-basic-paper-list-updated"],
    "Both actual Paper lists require their separate PUBLIC stages");
  assert.equal(evidence.originalSemanticScope.originalMcpRawWriteAssignsIdentity, false,
    "Original MCP raw write is not native knowledge identity/revision parity");
  assert.equal(evidence.originalSemanticScope.originalCreateIsNotUpsert, true);
  assert.equal(evidence.originalSemanticScope.paperOfflineMetadataOnly, true);
  assert.equal(evidence.originalSemanticScope.paperBodyOnlyControlEmpty, true);
  assert.equal(new Set(evidence.canonicalReceipts.map(receipt => receipt.operationId)).size, 4);
  for (const document of evidence.documentRevisionProof) {
    const prefix = `knowledge.${document.kind === "note" ? "note" : "research"}`;
    assert.equal(evidence.canonicalReceipts.find(receipt => receipt.operationId === document.createReceiptOperationId)?.operation, `${prefix}.create`);
    assert.equal(evidence.canonicalReceipts.find(receipt => receipt.operationId === document.updateReceiptOperationId)?.operation, `${prefix}.update`);
    assert.deepEqual([document.initialRevision, document.finalRevision], [1, 2], "Native identity revision proof must remain distinct and exact");
  }
  for (const key of ["publicCallerCasArgumentInvented", "publicStaleCasPerformed", "readOnlyActorLanePerformed",
    "semanticOrNetworkPerformed", "archivedSqliteReopenedForPreservation"])
    assert.equal(evidence.observations[key], false, "Note/Paper scope cannot invent unperformed oracle or preservation lanes");
  assert.deepEqual(evidence.referenceSourcePins.map(source => source.file), installedNotePaperBasicEvidence().referenceSourcePins.map(source => source.file),
    "Note/Paper exact helper/oracle/support pins are required");
  for (const source of evidence.referenceSourcePins) assert(/^[a-f0-9]{64}$/.test(source.sha256));
}

function installedResearchEvidence() {
  return {
    level: "installed", executionProfile: "installed-native-isolated", operations: RESEARCH_OPERATIONS,
    review: "Parent approved four exact Research original IDs after the complete fresh installed PUBLIC/observer/B1/fresh-B0 profile succeeded; no Paper receipt borrowing, model/Role/Recovery acceptance or failed prior Root replay.",
    uri: "file:///home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-research-basic-installed-qualified-final.json",
    sha256: "4c406abc412e7280f9ce62cf2ead9bc2c32f208fe407fd40dafa1203dc07d867",
    reportSchema: "pkm.installed-host-acceptance/v1", timestamp: "2026-11-22T23:00:46.551Z",
    candidateVsixSha256: "994eb9b62e7585a85b42daa0180b5f5d8772ec22ed8a3753481602e482c8a9e3",
    payloadBuildId: "af0bd2f1a85280e88fdd75e7808d8760196e775fd860ce7da71fa998e728b5e6",
    installedHostEntrySha256: "978d3dfe407bf45575189b5ff5c0ee86cbd16f326805e35a6c02f2b2b3208fa1",
    originalWriterVsixSha256: "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27",
    originalMcpMemberSha256: "34e4c6ff03185afdb2b985e87704a7e337a591a07bf68aa30f6b575a9729c06b",
    originalMcpProducerSha256: "8650294dfc353aa29364093aa6bd7ff118bd25530074cfa4bd225ee99e0b6b50",
    runProvenance: {
      actualCompleteFreshInstalledRun: "19903", parentExactChecks: ["19904"],
      helperWholeFileRun: { shellId: "19882", passed: 8, skipped: 0,
        scope: "Closed sealed Original22/Source callback tests after reader-signature fix, before final proof-output fix; not current helper hash re-attestation or actual A gateway execution." },
      failedPriorRootAccepted: false,
      finalProof: "Reader signature and receipt output now use the already validated freshB0.receiptSha256. Parent reran the entire fresh profile after the one-line output fix; no old artifact was edited or hash-refreshed.",
    },
    supersededArtifactHistory: [{
      uri: "file:///home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-research-basic-installed-qualified.json",
      sha256: "f008274bb9c3b0734cbd44b533be8587c846208714329e24c090078a525c3196",
      run: "19886", status: "passed-older-output-shape-not-current-operation-mapping",
      helperSha256: "a739b67e27955fc6fce2f08d0a016636f9f4a81b0ba29e1b42d9dae5d539ab29",
      root: "/home/yuwang8/.local/state/pkm-v5-recovery/native-cold-9c8f29e6-f677-4200-bb12-37b5c4b0c685/root",
      b1Sha256: "c7669f65affc7a689ed425ce581879bf5cad08548599e47538d545002ac5aa4d",
      stoppedCoreSha256: "f573f6b3b35939789edcf477bdeadf212909fd6f424fed7b1e0b6a4683966cda",
      freshB0ReceiptHashExported: false,
    }],
    requiredCaseRefs: RESEARCH_OPERATIONS.map(operation => `original-${operation.slice(9)}-basic`),
    compatibilityABasicRegistration: {
      status: "unverified-no-actual-A-gateway-test",
      reason: "Eight helper tests exercise sealed Original functions and a current Source callback Host, not the compatibility A transport. Artifact effectCaseRefs identify requirements, not executed A test cases.",
      needed: "Exact declared node:test case(s) using compatibility-mcp-fixture.mjs and actual Original/A capability_read/call for these four IDs, with independent output/graph/identity/no-effect assertions and a pinned real whole-file run.",
    },
    selectors: {
      live: "/coldComponent/nativeResearchBasic", binding: "/coldComponent/nativeResearchBasic/binding",
      outcomes: "/coldComponent/nativeResearchBasic/outcomes", dialogs: "/coldComponent/nativeResearchBasic/actualDialogs",
      B1Image: "/coldComponent/b1", freshB0: "/coldComponent/researchBasicPreservation",
      stoppedCore: "/coldComponent/researchStoppedCoreSha256", editorClosedBeforeB1: "/coldComponent/actualEditorFullyClosedBeforeB1",
      typedRetirement: "/coldComponent/typedRetirement", exit: "/electronExitCode",
      uninstall: "/installation/uninstalled", profileRemoval: "/profileRemoved",
    },
    rootBinding: {
      root: "/home/yuwang8/.local/state/pkm-v5-recovery/native-cold-e4cfa801-97b3-4c7d-8ebf-0a98823beab2/root",
      workspaceId: "16310059-07c6-41fa-a56d-94a50e2a1f48",
      custodyPlanSha256: "978bc8ff853f13c3e250136fe68dcf71c8d3718904e5ecc461915c28a1f05b9c",
      catalogSha256: ORIGINAL_METADATA_SHA256,
      profileSha256: "9beacaade2ca4869da4a507dca13c2f87cb83e03bc9d188091bc2b5b095ba6ff",
      privacySha256: "9e1f9e89c775ae1db78231635fec9924eca67b9bd812b2390a1f6291c334a70d",
      epoch: "593dca21-94bb-4f60-940f-5c4bb0975125",
      nativeHostReceiptSha256: "584d0e76958687f1da72df3f36ef865fa1ce088426bc6def750c790a5980e7c9",
    },
    graphPublicDialogs: [
      { stage: "native-research-basic-graph-denied", choice: "Deny", readOnly: false, focusedEnterDenial: true,
        argumentsDigest: "8741c3341140552f34448960a442f70be525e1bdc52814744d7b48bf18b087d6" },
      { stage: "native-research-basic-graph-top", choice: "Approve this request", readOnly: false, focusedEnterDenial: false,
        argumentsDigest: "924a5ec2f602b618848cae0807eb22338c3bfd046516ae73e5824ccd5336dbe3" },
      { stage: "native-research-basic-graph-neighbors", choice: "Approve this request", readOnly: false, focusedEnterDenial: false,
        argumentsDigest: "8741c3341140552f34448960a442f70be525e1bdc52814744d7b48bf18b087d6" },
      { stage: "native-research-basic-graph-empty", choice: "Approve this request", readOnly: false, focusedEnterDenial: false,
        argumentsDigest: "804e96ccef84c32330440e1489c497945f208c1cd25226cdbb0fe9ea39ac20c2" },
    ],
    graphResults: [
      { stage: "native-research-basic-graph-top", nodes: 1, edges: 0, total: 3, shown: 1 },
      { stage: "native-research-basic-graph-neighbors", nodes: 2, edges: 2, total: 3, shown: 2 },
      { stage: "native-research-basic-graph-empty", nodes: 0, edges: 0, total: 0, shown: 0 },
    ],
    originalSemanticScope: {
      legacySlug: "ResearchPublic/Root", canonicalSourceId: "pkm://knowledge/knowledge_000000000000000000000071",
      rawKnowledgeId: "knowledge_000000000000000000000071", rawRevision: 7,
      stableComparison: "Actual sealed Original get_source/snapshot executor; schema/source_id/source_revision/content/hash fields match. Corpus revision and ready generation are separately validated, not equated across different Root/oracle corpora.",
      listArguments: ["topic"], listPaginationParametersExist: false, listOutput: "Exact ordered legacy metadata array and topic filter, not a paginated Paper/list wrapper.",
      lexicalMetadataQuery: "RESEARCHMETADATANEEDLE", lexicalLimit: 1,
      emptyControlQueries: ["researchbodyonlyneedle", "researchmetadataneedle OR impossible", "researchprivatesentinel"],
      semanticOrNetworkQualified: false, duplicateGraphEdgesPreserved: true, oneHopGrandchildExcluded: true,
      graphArguments: { topic: "researchfixturetopic", limit: 1, neighbors: true },
    },
    preservationPins: {
      b1Kind: "pkm.original-mcp-component-b1/v1", b1Entries: 22, sqliteChecks: 1,
      b1Sha256: "c46fc148b579a5fd62f2f8ee0bfc80e1a2d59f99b4a662ed0087e3847778154b",
      stoppedCoreSha256: "38588d1724a5f8db638a2104a206e010915a488152e1e50114fb0dd9da13e205",
      freshB0ReceiptSha256: "15148483f00c1cae55a7b262389fc8388ddee11b365abfeee37e752c76d2eaf9",
      scope: "Independent Parent typed B1 after complete editor exit, exact captured stopped Core/known sidecars and WAL zero when present; fresh B0 exact baseline/old Root untouched plus actual validated receipt hash. No archived SQLite reopen.",
    },
    observations: {
      actualComponentInvokeAndNativeUi: true, acknowledgedStageCount: 16, uniqueOutcomeStages: 16,
      paperEvidenceBorrowed: false, graphReadOnlyHint: false, independentFocusedGraphDenialNoEffects: true,
      rawSourceIdsRevisionsFilesReceiptsAndIntentsUnchanged: true, semanticOrNetworkPerformed: false,
      liveHelperB1AndB0Qualified: false, independentParentB1AndFreshB0Qualified: true,
      actualEditorFullyClosedBeforeB1: true, typedRetirement: true, freshB0ExactBaseline: true, oldRootUntouched: true,
      originalRootOverwritten: false, archivedSqliteReopenedForPreservation: false,
      electronExitCode: 0, uiExitCode: 0, uninstalled: true, profileRemoved: true, productionCutover: false,
    },
    referenceSourcePins: [
      { file: "clients/vscode-host/installed-native-research-basic.mjs", sha256: "1c5c90b83f20d837bbd11c8626ec6be8c16177072e1cadb8b83af5813543b5f7" },
      { file: "clients/vscode-host/installed-native-research-basic-ui.mjs", sha256: "9f3e1e78041ffcea7a8406c26e5fef6c3ce6b40b5911ea9ad107fd4500804bd9" },
      { file: "clients/vscode-host/installed-native-research-basic.test.mjs", sha256: "0e5df789cf5c33248b93f736693f4b229c7e321e28f05a389f6fb056c57f248c" },
      { file: "tests/installed-research-basic-oracle.mjs", sha256: "2a7b376dd47c6677e779ade9f1f76e19febe6cf72676b659ee320c0a1d13a5b3" },
      { file: "tests/original-knowledge-writer-fixture.mjs", sha256: "f4151aa28df50ec1ab2593e5aa94248ce7c409053a0477102cfa4e3c1601892d" },
      { file: "clients/vscode-host/installed-native-knowledge-move.mjs", sha256: "7cc8e693fedbd15491cf9a0456606e09bb5b0b3b5b08224f3aee4ae42aa889f8" },
    ],
    sourceReferenceScope: "Captured helper/oracle/support navigation pins; exact installed candidate/report is authority. Helper schema/closed-Original/Source callback assertions do not qualify A transport, earlier artifacts or new semantic/model/Role operations.",
    remainingGaps: ["actual Original/A gateway basic test absent", "semantic/model/network Research retrieval",
      "whole-corpus generation equality, assets/subscriptions", "installed expiry/cancel/same-root restart",
      "general private/shared-root/provider/keyring/Role/Recovery/full151 cutover"],
    portability: "Static checker never opens the external report, sealed releases or private Root; four exact original IDs only, no catalog/schema/helper-count inference.",
  };
}

function installedResearchEffectCase() {
  const assertion = `reviewedEvidence.${INSTALLED_RESEARCH_EVIDENCE_ID}`;
  return {
    id: INSTALLED_RESEARCH_CASE_ID, operations: RESEARCH_OPERATIONS, executionProfile: "installed-native-isolated",
    runner: { file: "clients/vscode-host/installed-test.mjs", scenarioArgument: "--native-research-basic",
      requiredFlags: ["--native-identity", "--cold-component", "--legacy-vsix"],
      definition: "clients/vscode-host/installed-native-research-basic.mjs#verifyInstalledNativeResearchBasic",
      authority: "Complete actual installed Research profile and independent Parent preservation proof, not four requirement names, Paper results or an Original/A gateway run." },
    reviewedEvidenceRefs: [INSTALLED_RESEARCH_EVIDENCE_ID],
    stages: [
      { operation: id("get_research"), stage: "legacy-slug-and-stable-source-read",
        assertion: `${assertion}: actual slug=ResearchPublic/Root, canonical pkm://knowledge ID and raw knowledge ID use their genuine distinct sealed Original envelopes; raw revision 7 is not indexed source_revision, conflicting/missing input responses checked` },
      { operation: id("list_research"), stage: "ordered-legacy-research-list",
        assertion: `${assertion}: actual {} plus topic=researchfixturetopic and missing-topic inputs deep-equal ordered metadata arrays/citation counts; only topic exists, no invented offset/limit or Paper inventory borrowing` },
      { operation: id("search_research"), stage: "genuine-offline-metadata-lexical",
        assertion: `${assertion}: actual query=RESEARCHMETADATANEEDLE/limit=1 returns exact original metadata hit; body-only, literal OR and private queries return []; no semantic or model qualification` },
      { operation: id("paper_graph"), stage: "independent-public-graph-denial",
        assertion: `${assertion}: actual topic/limit=1/neighbors=true request receives focused-Enter Deny with ACCESS_DENIED and unchanged files/receipts/intents; original readOnly=false retained` },
      { operation: id("paper_graph"), stage: "nonempty-one-hop-citation-graph",
        assertion: `${assertion}: independent PUBLIC approvals for top/neighbors/empty graph; 2 nodes/2 duplicate directed edges, total3/shown2, no transitive Grandchild, separately genuine empty topic result` },
      { operation: null, stage: "read-preservation-no-mutation-receipt-invention",
        assertion: `${assertion}: every actual call/denial preserves exact files/raw IDs/revisions and live Core receipts/intents; response/decision digests are proof, no invented canonical mutation UUID or borrowed Paper receipt` },
      { operation: null, stage: "independent-typed-B1-fresh-B0",
        assertion: `${assertion}: separate Parent actual editor exit/typed 22-entry B1 image/stopped Core hash and exact fresh baseline/old Root untouched; early leaf B1 flag stays false and failed prior Root is not replayed` },
      { operation: null, stage: "complete-observer-ui-profile-cleanup",
        assertion: `${assertion}: 16 unique outcomes/ACKs and four real graph PUBLIC dialogs, CLI/editor/UI zero, uninstall/profile removal; no Role/Recovery/model or full151 claim` },
    ],
    oracle: `${assertion}: actual sealed Original22 executors compared to installed Research calls, ordered arrays, stable read fields, lexical controls and nonempty duplicate-edge graph; schema27 comparison alone is not behavior`,
    receipt: `${assertion}: bounded genuine output/graph PUBLIC decision digests and exact unchanged raw files/Core receipts/intents establish read preservation, not fabricated write receipts or A transport success`,
    preservation: `${assertion}: unchanged source/control bytes, independently typed stopped B1 and fresh B0 after actual whole-editor exit; no edited leaf flags, archived SQLite reopen, failed Root replay or full-root cutover`,
  };
}

function validateResearchEvidence(evidence) {
  assert.deepEqual(evidence.operations, RESEARCH_OPERATIONS, "Research cannot borrow Paper IDs or count model variants");
  assert.deepEqual(evidence.requiredCaseRefs, RESEARCH_OPERATIONS.map(operation => `original-${operation.slice(9)}-basic`));
  assert.equal(evidence.compatibilityABasicRegistration.status, "unverified-no-actual-A-gateway-test",
    "Closed Original/Source callbacks are not an actual compatibility A gateway run");
  assert.equal(evidence.graphPublicDialogs.length, 4);
  assert.deepEqual(evidence.graphPublicDialogs.map(dialog => [dialog.choice, dialog.readOnly, dialog.focusedEnterDenial]),
    [["Deny", false, true], ...Array.from({ length: 3 }, () => ["Approve this request", false, false])],
    "Research graph must preserve four independent mutating PUBLIC choices");
  assert.deepEqual(evidence.graphResults.map(result => [result.nodes, result.edges, result.total, result.shown]),
    [[1, 0, 3, 1], [2, 2, 3, 2], [0, 0, 0, 0]], "Research graph cannot qualify solely empty or deduplicated/transitive results");
  assert.equal(evidence.originalSemanticScope.listPaginationParametersExist, false);
  assert.deepEqual(evidence.originalSemanticScope.listArguments, ["topic"]);
  assert.equal(evidence.originalSemanticScope.semanticOrNetworkQualified, false);
  assert.equal(evidence.observations.paperEvidenceBorrowed, false);
  assert.equal(evidence.observations.liveHelperB1AndB0Qualified, false);
  assert.equal(evidence.observations.independentParentB1AndFreshB0Qualified, true);
  assert(/^[a-f0-9]{64}$/.test(evidence.preservationPins.freshB0ReceiptSha256), "Research final profile requires the validated fresh-B0 receipt hash");
  assert.deepEqual(evidence.referenceSourcePins.map(source => source.file), installedResearchEvidence().referenceSourcePins.map(source => source.file));
  for (const source of evidence.referenceSourcePins) assert(/^[a-f0-9]{64}$/.test(source.sha256));
}

function installedRecoveryEvidence() {
  const directory = "/home/yuwang8/.local/state/pkm-v5-recovery/native-cold-413391ee-4075-4e29-bfa0-2d681c5cd281";
  const evidenceDirectory = `${directory}/recovery-evidence`, root = `${directory}/root`;
  const counts = { ok: true, restored: 1, identical: 0, preserved_existing: 0 };
  return {
    level: "installed", executionProfile: INSTALLED_RECOVERY_PROFILE, operations: RECOVERY_OPERATIONS,
    review: "Parent 20050 and exact 20051 qualified the third entire fresh installed run 20049, exit0; two failed profiles retained and never replayed. Only the registered PUBLIC Note/0644 normal repair slice, not full Original arbitrary-file Recovery or actual A gateway execution.",
    uri: "file:///home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-knowledge-recovery-installed-qualified-20261123.json",
    sha256: "ae002b4906f651382b9631c9580e6dc6474743caed664a1f7f4173a6d8ea49ea",
    reportSchema: "pkm.installed-host-acceptance/v1", timestamp: "2026-11-23T03:44:16.499Z",
    candidateVsixSha256: "7c4e9a9a15432431f7134799731677a59e58d321e36d191bfc13ef50dc827dbe",
    payloadBuildId: "b250b3863a028d01dd29dea946467b9c804a4a2920bac5fc7ff797547450bb3b",
    installedHostEntrySha256: "adc181759d03189f9996dd66b0133af9b75ebef94e720cca0f9a760ec370b0e0",
    originalPackageSha256: "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27",
    originalRecoveryMemberSha256: "8e06b2ef4de7abc5be6ca855a8c148241b3a4a79e22593d1b4d976f5899788af",
    runProvenance: {
      actualCompleteFreshInstalledRun: "20049", parentExactChecks: ["20050", "20051"],
      failedPriorProfilesAccepted: false, failureArtifactsRewritten: false,
      priorFailures: ["Host duplicate hash check masked native wire as generic NATIVE_HANDLER_FAILED; Host-only check removed, server hash-before-grant-mint retained",
        "Helper lost SQLite autoindexes for known Recovery DDL; exact declared DDL/domain-object filtering fixed with five focused helper tests"],
      reportedSourceChecks: { normalBuildPassed: 460, normalBuildSkipped: 127, recoveryPrivateCasesPassed: 10,
        helperFocusedCasesPassed: 5, legacyRecoveryMcpCasesPassed: 2, coldDdlCasesPassed: 18,
        legacyAuthorizeCallbacksAreGenuineNativePermission: false },
    },
    compatibilityABasicRegistration: { status: "unverified-no-actual-A-gateway-test",
      reason: "Closed sealed Original22 decorator oracle and Source authorize callbacks are not actual Original/A gateway transport or genuine native permission." },
    selectors: {
      live: "/coldComponent/nativeKnowledgeRecovery", binding: "/coldComponent/nativeKnowledgeRecovery/binding",
      outcomes: "/coldComponent/nativeKnowledgeRecovery/outcomes", dialogs: "/coldComponent/nativeKnowledgeRecovery/actualDialogs",
      folderPickers: "/coldComponent/nativeKnowledgeRecovery/actualFolderPickers",
      canonicalReceipt: "/coldComponent/nativeKnowledgeRecovery/canonicalReceipt",
      B1Image: "/coldComponent/b1", independentParentPreservation: "/coldComponent/knowledgeRecoveryPreservation",
      stoppedCore: "/coldComponent/knowledgeRecoveryStoppedCoreSha256",
      editorClosedBeforeB1: "/coldComponent/actualEditorFullyClosedBeforeB1",
      typedRetirement: "/coldComponent/typedRetirement", freshB0: "/coldComponent/b0FreshRootRestored",
      exit: "/electronExitCode", uninstall: "/installation/uninstalled", profileRemoval: "/profileRemoved",
      productionCutover: "/productionCutover",
    },
    rootBinding: {
      root, workspaceId: "33441d79-d596-4aa7-aa7a-94e9b0babbef",
      custodyPlanSha256: "4abecfcecedd4a38fa2b278bbdd7cba012b4893bd8f274723a00bfd2be8c1a8e",
      catalogSha256: ORIGINAL_METADATA_SHA256,
      profileSha256: "fca5aed519335acd429558af4ae0890375acad5d8c2679f8f341bcdc1bd3f3f3",
      privacySha256: "9e1f9e89c775ae1db78231635fec9924eca67b9bd812b2390a1f6291c334a70d",
      epoch: "5d51f522-b1cf-4ef8-bc47-02ce101696c0",
      nativeHostReceiptSha256: "cf6469cdc3ed7c5dde3877ea74456abde81a2fc757e3fffcb0389a5ae5bbd339",
    },
    qualifiedScope: {
      ownerCount: 1, alreadyRegistered: true, privacy: "public", unshared: true, documentKind: "note",
      path: "notes/RecoveryPublic/Owned.md", rawKnowledgeId: "knowledge_f071e3121306c13f11c1e664", rawRevision: 1,
      retainedOriginalMode: "100644", restoredMode: 0o644, bytes: 273,
      rawSha256: "23fca9f3ef4a6f3a72eb977cf20a568f6387cd269e1acce5e43f241b12cf7e0a",
      registrationReceiptSha256: "45af5f57b561b6a8d0afeabe15a9034214d969837aa3d1aecbb56d400a52d173",
      indexRowSha256: "e4e28a1af335c910580ecf38e37117d73888dd3abca3d75c88eb6516ed981412",
      assets: [], referrers: [], fullRecovery: false, full151: false, fullCutoverQualified: false,
    },
    evidenceDirectory, approvedPlanSha256: "8dda31060dd8f6b24d859df529d85ae429134becfc921fa5ea5429bc201994bb",
    nativeAuthority: { sourceDefaultDecision: "deny", repairDefaultDecision: "deny",
      sourceInspectionDoesNotGrantRepair: true, ordinaryPublicApprovalDoesNotGrantRepair: true,
      serverHashVerifiedBeforeRepairGrantMint: true },
    actualFolderPickers: RECOVERY_STAGES.map(stage => ({
      stage, directory: evidenceDirectory, actualFolderPicker: true, noActiveNavigationRow: true,
    })),
    actualDialogs: [
      ...RECOVERY_STAGES.map((stage, index) => ({
        stage, kind: "source", choice: index === 0 ? "Deny" : "Read selected evidence only",
        focusedEnterDenial: index === 0,
        requestSha256: ["b6cebb5af45a70b94ad9d47dd0df0c93676ef2306580a40ae4628c54bd1ad32e",
          "4b02d2ddbcb7e2a7602e0ce83a883a6fbb5677a671c0f49c0a3b6bdb1b5c450a",
          "215c74ea4465097831f491c5baadbe08506e35f207710a1cbe4291090a7ed175",
          "fa6f8e99fa5d519eae480e4508107399ef14286b5ab3b3ec7d5e9f699e6ddcb5",
          "f887aa50eeaad8c4b187e32e83dafec216dc158a3f0c731a513beaeb70533033",
          "d923e5e5798a77b2ece9c1294e44cb3a486387ae0f42c2708c0cb768ec086916",
          "c05538f5c47e1ec3c78aa99eab92be64ecd1f23cf41c51075cce36867e7d114d"][index],
      })),
      ...["recovery-deny-repair", "recovery-wrong-hash", "recovery-apply", "recovery-occupied"].map(stage => ({
        stage, kind: "public", choice: "Approve this request", focusedEnterDenial: false,
        operation: id("knowledge_recovery_apply"), readOnly: false,
        argumentsDigest: stage === "recovery-wrong-hash"
          ? "3721632b8d71f7cfd5284f69a1a59f33ef4775d47798d1badef89c8e8ff9bd2a"
          : "267d95e19dedc6b9d8651e0e348cb32e0af6c6d277f749426351511c22900e02",
      })),
      { stage: "recovery-deny-repair", kind: "repair", choice: "Deny", focusedEnterDenial: true,
        requestSha256: "d5c9856ca5049e77d831135f8a3be13d309390c1c195faf234e0666b29764aed",
        repairPlanSha256: "19f39313d2c594133212c0489e07a7574e401b787de3fd572e3421d3c53f7f7e" },
      { stage: "recovery-apply", kind: "repair", choice: "Repair this exact missing owner", focusedEnterDenial: false,
        requestSha256: "3d6ee80ca800222fe41a474fd3bc6480b70a829bac059e2d15d579986048949a",
        repairPlanSha256: "81df9571bc76778f922d1631ae20fc78f2bacfd1f749cfe43c00aef7f5a7e926" },
    ],
    outcomes: RECOVERY_STAGES.map(stage => stage === "recovery-apply"
      ? { stage, actualCounts: counts, originalExpectedCounts: counts }
      : ["recovery-preview", "recovery-after-preview"].includes(stage)
        ? { stage, actualOriginalPreview: true, noEffects: true,
          counts: stage === "recovery-preview"
            ? { restore: 1, identical: 0, "preserve-existing": 0 } : { restore: 0, identical: 1, "preserve-existing": 0 } }
        : { stage, refusal: true, noEffects: true }),
    canonicalReceipt: {
      actual: { ...counts, report: `${evidenceDirectory}/result-20261123T034411819000.json` },
      originalExpectedCounts: counts, rawSha256: "23fca9f3ef4a6f3a72eb977cf20a568f6387cd269e1acce5e43f241b12cf7e0a",
      indexUnchanged: true, mode: 0o644, oneCustodyReceipt: true,
      operationId: "cf478ed9-f964-43ae-9805-ee10e5a1c2d6", operation: "knowledge.recovery.owner", actorId: "mcp:external",
      fingerprint: "81df9571bc76778f922d1631ae20fc78f2bacfd1f749cfe43c00aef7f5a7e926",
      resultSha256: "2839575b50b026909b061a04cea0dfa53f381a9fab17a09619c94ba5cdfbd05d",
      custodyReceiptSha256: "a24f808020d7fb9ec09c8f455f8ad97be34d6a7d021fd6fdd9b6011ed8f627b4",
      scope: "one registered PUBLIC baseline owner normal repair only", fullRecovery: false, full151: false,
    },
    liveReceiptSha256: "18ba3a140bcf8fbdfbfe7259c03694858bdad2e66d2ca2eadc7cce0be2480b02",
    preservationPins: {
      b1Kind: "pkm.original-mcp-component-b1/v1", b1Entries: 18, b1Bytes: 1218993, sqliteChecks: 1,
      b1Sha256: "e7ba4094b4d97af12b7c2fbf9d6fc1cda31aacf37deef461a6f7d68dc5dd1040",
      stoppedCoreSha256: "92f3aa675ce031e059b520f429923a7964dc7e9659e2f8ed8ef9f6740a090597",
      scope: "Independent Parent exact manifest/payload/sidecars/modes, captured WAL zero when present, unchanged index/receipt/raw and prelude controls; no archived SQLite reopen. Fresh B0 exact Original bytes/modes with no database/grants/native locks.",
    },
    independentParentPreservation: {
      exactStoppedCoreAndCapturedSidecarsPreserved: true, exactB1ImagePayloadModesPreserved: true,
      repairedOriginalBytesAndModePreserved: true, unchangedIndexAndReceiptInStoppedCoreImage: true,
      preludeControlsPreserved: true, noArchivedSqliteReopen: true,
      exactOriginalB0BytesAndModesRestored: true, freshB0NoDatabaseGrantsOrNativeLocks: true,
      originalRootOverwritten: false, fullRecovery: false, full151: false, fullCutoverQualified: false,
    },
    observations: {
      actualNativeUi: true, actualComponentInvoke: true, actualOriginal22Oracle: true, acknowledgedStageCount: 7,
      liveHelperB1AndB0Qualified: false, independentParentPreservationQualified: true,
      actualEditorFullyClosedBeforeB1: true, typedRetirement: true, b0FreshRootRestored: true,
      electronExitCode: 0, uninstalled: true, profileRemoved: true, productionCutover: false,
    },
    referenceSourcePins: [
      { file: "clients/vscode-host/installed-native-knowledge-recovery-normal.mjs", sha256: "9c68d3fa39d19b186d13b4a953039c60507ce97271941f8633690081922f104c" },
      { file: "clients/vscode-host/installed-native-knowledge-recovery-ui.mjs", sha256: "9f29d810698a3021eca51feab9b43bfef6789541a5d222ac220ab666797062a3" },
      { file: "clients/vscode-host/installed-native-knowledge-recovery-normal.test.mjs", sha256: "040a150f7a9217df3aeb02d077103bda7f512555dcb967ca27f23cd09b74bf56" },
      { file: "tests/original-knowledge-writer-fixture.mjs", sha256: "f4151aa28df50ec1ab2593e5aa94248ce7c409053a0477102cfa4e3c1601892d" },
      { file: "clients/vscode-host/installed-native-knowledge-move.mjs", sha256: "7cc8e693fedbd15491cf9a0456606e09bb5b0b3b5b08224f3aee4ae42aa889f8" },
      { file: "clients/vscode-host/original-knowledge-recovery-producer.ts", sha256: "2f11cc0d68581775f1f7765cd14a38a993c7e7ac2ecab8a22a09323eed7c0ac5" },
    ],
    sourceReferenceScope: "New-profile captured helper/UI/oracle/native-producer navigation pins only; sealed installed report/candidate is authority. No old Source attestation hash refresh or inference of A gateway permission from helper tests.",
    remainingGaps: ["actual Original/A gateway basic test absent", "unknown owners, private/Paper/assets/referrers/private namespaces",
      "unshared or retained mode unproven, multiple owners", "arbitrary-file/full Original Recovery, arbitrary crash recovery",
      "installed expiry/cancel/same-root restart/no-replay", "Root replacement/shared-root/provider keyring/full151/cutover/stability"],
    portability: "Static checker never opens external reports/releases/private Roots; bounded exact two-ID registration only, not schema/helper-count or full readiness proof.",
  };
}

function installedRecoveryEffectCase() {
  const assertion = `reviewedEvidence.${INSTALLED_RECOVERY_EVIDENCE_ID}`;
  return {
    id: INSTALLED_RECOVERY_CASE_ID, operations: RECOVERY_OPERATIONS, executionProfile: INSTALLED_RECOVERY_PROFILE,
    runner: { file: "clients/vscode-host/installed-test.mjs", scenarioArgument: "--native-knowledge-recovery",
      requiredFlags: ["--native-identity", "--cold-component", "--legacy-vsix"],
      definition: "clients/vscode-host/installed-native-knowledge-recovery-normal.mjs#verifyInstalledNativeKnowledgeRecovery",
      authority: "Third entire fresh actual installed registered PUBLIC Note/Original0644 profile with independent Parent preservation; not full Recovery, older failed profiles or actual A gateway execution." },
    reviewedEvidenceRefs: [INSTALLED_RECOVERY_EVIDENCE_ID],
    stages: [
      { operation: id("knowledge_recovery_preview"), stage: "recovery-deny-source",
        assertion: `${assertion}: actual folder picker plus focused Source Deny; refusal and zero Knowledge/evidence/audit/new receipt effects` },
      { operation: id("knowledge_recovery_preview"), stage: "recovery-preview",
        assertion: `${assertion}: genuine selected-evidence-only Source choice, exact closed sealed Original22 preview restore1/identical0/preserve-existing0; zero writes` },
      { operation: id("knowledge_recovery_apply"), stage: "recovery-deny-repair",
        assertion: `${assertion}: separate ordinary PUBLIC and Source approvals do not mint repair authority; focused repair Deny has zero effects/audit/new receipt` },
      { operation: id("knowledge_recovery_apply"), stage: "recovery-wrong-hash",
        assertion: `${assertion}: genuine Source/PUBLIC choices reach server-authoritative hash-before-grant-mint rejection; no repair dialog, effects/audit/new receipt` },
      { operation: id("knowledge_recovery_apply"), stage: "recovery-apply",
        assertion: `${assertion}: independent Source/PUBLIC/exact-owner repair choices; exact Original ok/restored1/identical0/preserved_existing0, lost raw bytes restored0644, same raw ID/revision/index; one external audit and matching native/global mcp:external knowledge.recovery.owner UUID/fingerprint/result/custody receipt` },
      { operation: id("knowledge_recovery_preview"), stage: "recovery-after-preview",
        assertion: `${assertion}: actual selected-evidence preview matches Original identical1/restore0/preserve-existing0 with zero effects` },
      { operation: id("knowledge_recovery_apply"), stage: "recovery-occupied",
        assertion: `${assertion}: actual PUBLIC/Source choices reject occupied destination without repair dialog/overwrite/effects/audit/new receipt` },
      { operation: null, stage: "independent-stopped-B1-fresh-B0",
        assertion: `${assertion}: editor/Core closed before independent Parent exact18-entry B1/manifest/payload/modes/sidecars/WAL0, unchanged index/receipt/raw/prelude and fresh B0 original bytes/modes/no database/grants/locks; early leaf B1 flag stays false, no archived SQLite reopen` },
      { operation: null, stage: "actual-picker-ACK-profile-cleanup",
        assertion: `${assertion}: seven unique outcomes/ACKs, seven genuine picker observations, seven Source choices six approve/one focused Deny, four PUBLIC approvals, two repair choices focused Deny/approve; typed retirement/freshB0/uninstall/profileRemoval/electron0, full Recovery/full151/cutover/stability not qualified` },
    ],
    oracle: `${assertion}: actual closed sealed Original22 recovery preview/apply executor, exact one-owner normal counts/raw bytes/mode; decorator registration is not A gateway execution or arbitrary-file Recovery proof`,
    receipt: `${assertion}: exact same actor/operation UUID/fingerprint/resultSHA/custody receipt, stable rawKnowledgeID/revision/index; all preview/refusal stages preserve files/evidence/audit/new receipts`,
    preservation: `${assertion}: independent Parent stopped-image/sidecar/mode/B1 and freshB0 proof after actual editor/Core exit; no edited pre-B1 leaf flag, archived SQLite reopen, failed profile replay or original Root replacement`,
  };
}

function validateRecoveryEvidence(evidence) {
  assert.deepEqual(evidence.operations, RECOVERY_OPERATIONS, "Recovery cannot borrow other operation IDs");
  assert.equal(evidence.executionProfile, INSTALLED_RECOVERY_PROFILE, "Recovery installed profile must be explicitly bounded");
  assert.deepEqual(evidence.qualifiedScope, installedRecoveryEvidence().qualifiedScope, "Only registered PUBLIC asset-free Note/Original0644 Recovery is qualified");
  assert.equal(evidence.compatibilityABasicRegistration.status, "unverified-no-actual-A-gateway-test", "Recovery decorator oracle is not actual A gateway execution");
  assert.equal(evidence.canonicalReceipt.actorId, "mcp:external", "Recovery receipt actor cannot be borrowed");
  assert.equal(evidence.canonicalReceipt.operation, "knowledge.recovery.owner", "Recovery receipt operation cannot be borrowed");
  assert.equal(evidence.canonicalReceipt.fingerprint,
    evidence.actualDialogs.find(dialog => dialog.stage === "recovery-apply" && dialog.kind === "repair")?.repairPlanSha256,
    "Recovery receipt must match actual exact-owner repair choice");
  assert.equal(evidence.canonicalReceipt.rawSha256, evidence.qualifiedScope.rawSha256);
  const { report, ...counts } = evidence.canonicalReceipt.actual;
  assert.deepEqual(counts, { ok: true, restored: 1, identical: 0, preserved_existing: 0 }, "Recovery exact Original normal counts required");
  assert.deepEqual(counts, evidence.canonicalReceipt.originalExpectedCounts);
  assert(report.startsWith(`${evidence.evidenceDirectory}/result-`));
  assert.deepEqual(evidence.outcomes.map(outcome => outcome.stage), RECOVERY_STAGES, "Recovery requires seven unique actual outcomes");
  assert.equal(evidence.observations.acknowledgedStageCount, RECOVERY_STAGES.length, "Recovery requires seven actual ACKs");
  assert.deepEqual(evidence.actualFolderPickers.map(picker => picker.stage), RECOVERY_STAGES, "Recovery requires seven genuine picker observations");
  assert(evidence.actualFolderPickers.every(picker => picker.actualFolderPicker && picker.noActiveNavigationRow
    && picker.directory === evidence.evidenceDirectory), "Recovery genuine selected folder picker proof required");
  for (const [kind, expected] of [
    ["source", RECOVERY_STAGES.map((stage, index) => [stage, index === 0 ? "Deny" : "Read selected evidence only", index === 0])],
    ["public", ["recovery-deny-repair", "recovery-wrong-hash", "recovery-apply", "recovery-occupied"].map(stage => [stage, "Approve this request", false])],
    ["repair", [["recovery-deny-repair", "Deny", true], ["recovery-apply", "Repair this exact missing owner", false]]],
  ]) assert.deepEqual(evidence.actualDialogs.filter(dialog => dialog.kind === kind)
    .map(dialog => [dialog.stage, dialog.choice, dialog.focusedEnterDenial]), expected, `Recovery requires separate genuine ${kind} choices including focused Deny`);
  for (const outcome of evidence.outcomes.filter(outcome => outcome.stage !== "recovery-apply"))
    assert.equal(outcome.noEffects, true, "Recovery previews/refusals must preserve all effects");
  assert.deepEqual(evidence.nativeAuthority, installedRecoveryEvidence().nativeAuthority, "Recovery Source/PUBLIC/repair authority cannot be merged or default-allowed");
  assert.equal(evidence.observations.liveHelperB1AndB0Qualified, false, "Recovery pre-B1 leaf flag must stay false");
  assert.equal(evidence.observations.independentParentPreservationQualified, true, "Recovery requires independent Parent preservation");
  assert.deepEqual(evidence.independentParentPreservation, installedRecoveryEvidence().independentParentPreservation, "Recovery exact stopped image and fresh B0 proof required");
  assert.deepEqual(evidence.preservationPins, installedRecoveryEvidence().preservationPins, "Recovery B1/stopped Core pins cannot be rebound");
  assert.deepEqual(evidence.referenceSourcePins, installedRecoveryEvidence().referenceSourcePins, "Recovery requires exact new-profile support pins");
}

function installedActionPureEvidence() {
  return {
    level: "installed", executionProfile: INSTALLED_ACTION_PURE_PROFILE, operations: ACTION_PURE_OPERATIONS,
    review: "Entire fresh installed run 20259/exit0; Parent exact checks 20260/20261 passed. Only complete templates and bounded basic-component graph positives are registered, not invalid-definition diagnostics, capabilities refusal or whole Action.",
    uri: "file:///home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-action-pure-installed-20261123.json",
    sha256: "3b06876186aa1d49d0487239b2d747f682b0a800bbb06e986caaf40daf39d993", artifactBytes: 47010,
    reportSchema: "pkm.installed-host-acceptance/v1", timestamp: "2026-11-23T07:06:16.495Z",
    candidateVsixSha256: "e2af449784fa2f09e7d3c0cc2fc984e405c2ddd696f9d77789e0c8ccb55b1f42",
    payloadBuildId: "35a07c20857f56341e0572dc9795b73942e0dbf248b1821279a52d97e207d967",
    installedPins: {
      "original-mcp-action-pure": "473181114c92fa440ea4089cade1c697383b92c18c857506309f0be871a9cdb7",
      "original-mcp-public": "cd7e28840d9cd971c67ad092bd92ad5e76d2c4d7237b8a079ab738d04f09ea0b",
      "original-mcp-cold-component": "b01725dc347d57307d6a8036ead1ef01564e38244a1bbbb99b6806d1e5795701",
      "domain/action-compiler-graph": "c3079f06d92edfb312fefc3bf8e3e244a04822380e58f09979a8882136183bfc",
      "domain/action-compiler-validation": "81a22e28432bc6c939e7d32c49e5fa0d482288b6e037bdac28dfd462ec89915d",
      "domain/legacy-action-mcp-original": "59fc8217ca4ac734b57e8cc493c008317fe4c5d34de2f6198ba4d02c12843ead",
      hostEntry: "8888dd86f9010396b135d9e1eb60877ddb795d27ee74a77016888a1d28e60252",
    },
    originalPackageSha256: "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27",
    oracle: {
      kind: "closed-sealed-Original22-tool-functions-and-ModuleRuntime-business-methods",
      apiShapedMock: false, privateWorkspaceIoAllowed: false, processOrNetworkAllowed: false,
      templateCatalogueNonempty: true,
    },
    compatibilityABasicRegistration: { status: "unverified-no-actual-A-gateway-test",
      reason: "Exact Original tool-function/business-method oracle and Source callbacks are not actual A gateway transport." },
    runProvenance: {
      actualCompleteFreshInstalledRun: "20259", parentExactChecks: ["20260", "20261"],
      failedPriorProfilesAccepted: false, failureArtifactsRewritten: false,
      priorFailure: "5d7 Root lacked papers inventory; retained, never replayed. Parent prepared the empty Paper area before B0 and ran an entirely fresh profile.",
      independentFairness48ArtifactBorrowed: false,
      reportedSourceChecks: { normalBuildPassed: 462, normalBuildSkipped: 127,
        closureSha256: "4f59f4eec9cb8e5558eaee054439a1dc7052a0d0d11f086e6bfa89d9b3bcac82",
        privateSourceCasesPassed: 5, helperCasesPassed: 4, helperChecks: ["20220", "20253"],
        legacyAuthorizeCallbacksAreGenuineNativePermission: false },
    },
    selectors: {
      live: "/coldComponent/nativeActionPure", binding: "/coldComponent/nativeActionPure/binding",
      outcomes: "/coldComponent/nativeActionPure/outcomes", acknowledgements: "/coldComponent/nativeActionPure/acknowledgements",
      B1Image: "/coldComponent/b1", independentParentPreservation: "/coldComponent/actionPurePreservation",
      stoppedCore: "/coldComponent/actionPureStoppedCoreSha256",
      editorClosedBeforeB1: "/coldComponent/actualEditorFullyClosedBeforeB1",
      typedRetirement: "/coldComponent/typedRetirement", freshB0: "/coldComponent/b0FreshRootRestored",
      exit: "/electronExitCode", uninstall: "/installation/uninstalled", profileRemoval: "/profileRemoved",
      productionCutover: "/productionCutover",
    },
    rootBinding: {
      root: "/home/yuwang8/.local/state/pkm-v5-recovery/native-cold-92b01f38-3438-44ab-8459-0b3a26904199/root",
      workspaceId: "2ed2de0b-2b19-457b-b9e0-5ee4d34a7e60",
      custodyPlanSha256: "f16bba0b148fbd3dcd167e76b5eac3213675e02dbf427197b64ed11f570705db",
      catalogSha256: ORIGINAL_METADATA_SHA256,
      profileSha256: "6b96b5ced41a27fd2be4b10736c24780a4963544640fa889b3cac8e0b7337966",
      privacySha256: "9e1f9e89c775ae1db78231635fec9924eca67b9bd812b2390a1f6291c334a70d",
      epoch: "0cc6aa74-7fd6-4b4e-afc6-881dca842b50",
      nativeHostReceiptSha256: "53a2dae69e3f94e1941b375ba1aaeac81c588a3be7d8dea594f4030eadd026a1",
    },
    leafOperationIds: {
      completeOperationIds: [id("action_templates")],
      boundedOnlyOperationIds: [id("action_definition_check"), id("action_graph_check")],
      deniedOperationIds: [id("action_capabilities")],
    },
    qualifiedScope: {
      completeOperationIds: [id("action_templates")],
      boundedPositiveOperationIds: [id("action_graph_check")],
      supplementalDiagnosticOnlyOperationIds: [id("action_definition_check")],
      refusalOnlyOperationIds: [id("action_capabilities")],
      graphScope: "Only installed basic constant and typed component-only graph compiled outputs; private and nested Action references remain blocked.",
      validDefinitionRegistryQualified: false, privateActionReferencesQualified: false,
      actionSourceOrRuntimeAdmission: false, actionExecution: false, credentialsOrExternalNetwork: false,
      fullAction: false, full151: false, fullCutoverQualified: false,
    },
    positiveOutputs: [
      { stage: ACTION_PURE_STAGES[0], tool: "action_templates", qualification: "complete-nonempty-catalogue",
        originalResultSha256: "eada2b926b53b62ea0a0343dbec6e89db7eebae83f0815d066862524573b3627", exactClosedOriginalResult: true },
      { stage: ACTION_PURE_STAGES[1], tool: "action_definition_check", qualification: "supplemental-invalid-diagnostics-only",
        originalResultSha256: "578d60a84bb99a1609e21166d761ee0431296a064b4ae2478e45b1a0bf672dc9", exactClosedOriginalResult: true },
      { stage: ACTION_PURE_STAGES[2], tool: "action_graph_check", qualification: "bounded-basic-component-graph",
        originalResultSha256: "f67c65d220bc18ede3d4fc49f1e2f6e6e433d88294a5ad71277e8ba59f680b55", exactClosedOriginalResult: true },
      { stage: ACTION_PURE_STAGES[3], tool: "action_graph_check", qualification: "bounded-basic-component-graph",
        originalResultSha256: "16674cb9e7c2b1331b6be319a55a1d2f7e260607040cc95b66e1ea4058f9d09b", exactClosedOriginalResult: true },
    ],
    denials: ACTION_PURE_STAGES.slice(4).map((stage, index) => ({
      stage, tool: ["action_capabilities", "action_definition_check", "action_graph_check", "action_graph_check"][index],
      denied: true, code: index === 0 ? "ORIGINAL_MCP_ADAPTER_REQUIRED" : "NATIVE_AUTHORITY_REQUIRED",
      fullRuntimeRequired: true, noActionSourceOrRuntimeAdmission: true,
    })),
    acknowledgements: ACTION_PURE_STAGES.map(stage => ({
      schema: "pkm.installed-native-action-pure-ui-ack/v1", runId: "f6226f87-d8f5-462b-a574-d3e3446b294e",
      stage, phase: "complete", noUnexpectedModal: true,
    })),
    observations: {
      actualNativeUi: true, actualRenderedDom: true, actualComponentInvoke: true,
      sameOwnerLease: true, originalMcpPublicRequest: true, originalCatalogReadOnlyEveryStage: true,
      acknowledgedStageCount: 8, publicDialogCount: 0, noReviewEveryStage: true,
      wholePreludeKnowledgeUnchanged: true, businessReceiptsIntentsAndDocumentsUnchanged: true,
      businessSnapshotSha256: "b94ecaf7c5d4f50208f414e84a2335a1a579090e1fda2041c70e9f2178078aa4",
      liveHelperB1AndB0Qualified: false, independentParentPreservationQualified: true,
      actualEditorFullyClosedBeforeB1: true, typedRetirement: true, b0FreshRootRestored: true,
      electronExitCode: 0, uninstalled: true, profileRemoved: true, productionCutover: false,
    },
    preservationPins: {
      b1Kind: "pkm.original-mcp-component-b1/v1", b1Entries: 15, b1Bytes: 1177759, sqliteChecks: 1,
      b1Sha256: "da7e12ee9ca039d7318d6ed1153bad816a806720443ed4068c4a17c0dd5ebdb9",
      stoppedCoreSha256: "6b49cc7fbdde733e0e2bdeef780aa101a3da83c273db5cc1d410432e701b8737",
    },
    independentParentPreservation: {
      exactKnowledgeModesAndStoppedCoreSidecars: true, noArchivedSqliteReopen: true,
      freshB0ExactBytesAndModes: true, originalRootOverwritten: false,
      freshB0NoNativeDatabaseOrActionGrants: true, b1AndB0Qualified: true, fullAction: false, full151: false,
    },
    preservationScope: "Genuine typed retirement after editor/Core exit; exact B1 manifest/payload/modes/stopped Core/sidecars, captured WAL zero when present, fresh B0 original bytes/modes/new Root identity, no archived SQLite reopen or Action grants.",
    referenceSourcePins: [
      { file: "src/original-mcp-action-pure.ts", sha256: "9315ac35208baf434a6e00f29b35c2bd462f572927b5602d76df653a054a21eb" },
      { file: "clients/vscode-host/installed-native-action-pure.mjs", sha256: "b28e6a2ae0b006d5fa4d36399bb454e8ca7e194fe343f7e4157a98dfc329532b" },
      { file: "clients/vscode-host/installed-native-action-pure-ui.mjs", sha256: "0403586fc8711a5a5c63c4d31170ab7439ef0c00820f89d1a916b98b85664591" },
      { file: "clients/vscode-host/installed-native-action-pure.test.mjs", sha256: "2f04755ee5a094adeb0c068287f6283d4b1430f6b468b40de37b50a37bfefa2d" },
      { file: "tests/installed-action-pure-oracle.mjs", sha256: "3b90e5e27f40754319d74cd52e893da6bf653d83274cb3e20a6db767354cd59e" },
      { file: "tests/original-mcp-action-pure-oracle.mjs", sha256: "4fdf83a1b61eb571495319722d78f61134d5f8d204a4986244a91f94eda75bfc" },
      { file: "tests/original-mcp-action-pure.test.mjs", sha256: "b1a8cb342b6527a3cd094434bca266ac755ec2b3ba96a41d1a94a09e2f7815dc" },
    ],
    sourceReferenceScope: "New-profile captured Source/helper/UI/oracle navigation pins only; no old Source attestation refresh, fabricated rerun, Original/A gateway or independent same-candidate fairness48 qualification.",
    remainingGaps: ["actual Original/A gateway test absent", "valid-definition registry/dependency closure",
      "private or nested Action references, Action source/native trust and execution grants",
      "Cosmos/modules/credentials/source/runs/queue/history", "installed same-root expiry/cancel/restart/no-replay",
      "SDK official account/roles, production keyring/shared Root/full151/cutover/stability"],
    portability: "Static checker never opens this external report/candidate or private Root. Two positive original IDs only; graph is bounded, invalid definition supplemental, capabilities refusal-only.",
  };
}

function installedActionPureEffectCase() {
  const assertion = `reviewedEvidence.${INSTALLED_ACTION_PURE_EVIDENCE_ID}`;
  const operations = ["action_templates", null, "action_graph_check", "action_graph_check",
    null, null, "action_graph_check", "action_graph_check"];
  const assertions = [
    "complete nonempty catalogue exactly matches genuine sealed Original22 tool function and ModuleRuntime business methods",
    "supplemental invalid-schema exact Original diagnostics only; NOT a positive installed/basic definition registration",
    "bounded basic constant component graph exactly matches Original compiled output, no Action references or execution",
    "bounded typed component graph exactly matches Original compiled output, no registry/runtime admission",
    "genuine ORIGINAL_MCP_ADAPTER_REQUIRED with ACTION_FULL_RUNTIME_REQUIRED, never COMPONENT_TOOL_NOT_ADMITTED; refusal-only capabilities, no positive coverage",
    "schema-valid definition refuses with ACTION_FULL_RUNTIME_REQUIRED, no registry/dependency/source admission",
    "private Action graph refuses with ACTION_FULL_RUNTIME_REQUIRED, no Action source/runtime admission",
    "nested private Action graph refuses with ACTION_FULL_RUNTIME_REQUIRED, no Action source/runtime admission",
  ];
  return {
    id: INSTALLED_ACTION_PURE_CASE_ID, operations: ACTION_PURE_OPERATIONS, executionProfile: INSTALLED_ACTION_PURE_PROFILE,
    operationScopes: { [id("action_templates")]: "complete-nonempty-catalogue",
      [id("action_graph_check")]: "bounded-basic-constant-and-typed-component-graphs-only" },
    runner: { file: "clients/vscode-host/installed-test.mjs", scenarioArgument: "--native-action-pure",
      requiredFlags: ["--native-identity", "--cold-component", "--legacy-vsix"],
      definition: "clients/vscode-host/installed-native-action-pure.mjs#verifyInstalledNativeActionPure",
      authority: "Entire fresh genuine installed same-Root/owner/Host/PublicRequest with actual rendered noReview ACKs; no Action source/runtime grants, A gateway or fairness48 borrowing." },
    reviewedEvidenceRefs: [INSTALLED_ACTION_PURE_EVIDENCE_ID],
    stages: [
      ...ACTION_PURE_STAGES.map((stage, index) => ({
        operation: operations[index] === null ? null : id(operations[index]), stage,
        assertion: `${assertion}: ${assertions[index]}; original readOnly=true, actual noReview ACK, zero PUBLIC modals and unchanged whole Knowledge/receipts/intents/documents`,
      })),
      { operation: null, stage: "independent-stopped-B1-fresh-B0",
        assertion: `${assertion}: genuine typed retirement after editor/Core exit, exact manifest/payload/modes/sidecars/WAL0/stopped Core and fresh B0 bytes/modes/new Root/no database or Action grants; no archived SQLite reopen or edited pre-B1 leaf flag` },
      { operation: null, stage: "installed-exit-and-profile-cleanup",
        assertion: `${assertion}: actual uninstall/profileRemoved/electron0, productionCutover/fullAction/full151 false` },
    ],
    oracle: `${assertion}: closed sealed Original22 actual tool functions and ModuleRuntime business methods, not API-shaped mock. Four exact positive outputs include supplemental invalid diagnostics; only templates and bounded graph IDs registered.`,
    receipt: `${assertion}: every stage preserves whole post-prelude Knowledge and all business receipts/intents/documents; eight rendered noReview ACKs and zero PUBLIC modals, no invented mutation receipt`,
    preservation: `${assertion}: independent stopped B1/Core/sidecars/modes and fresh B0 bytes/modes/new Root identity; leaf B1 flag remains false, no original Root overwrite, archived SQLite reopen or old failed profile replay`,
  };
}

function validateActionPureEvidence(evidence) {
  const expected = installedActionPureEvidence();
  assert.deepEqual(evidence.operations, ACTION_PURE_OPERATIONS, "Only templates and bounded graph may receive Action basic registration");
  assert.deepEqual(evidence.leafOperationIds, expected.leafOperationIds, "Action leaf complete/bounded/denied IDs must remain exact");
  assert.deepEqual(evidence.qualifiedScope, expected.qualifiedScope, "Invalid diagnostics/private references/full Action cannot become qualified");
  assert.deepEqual(evidence.positiveOutputs.map(output => output.stage), ACTION_PURE_STAGES.slice(0, 4), "Four actual positive outputs required");
  assert(evidence.positiveOutputs.every(output => output.exactClosedOriginalResult && /^[a-f0-9]{64}$/.test(output.originalResultSha256)),
    "Nonempty exact Original output digests required");
  assert.equal(evidence.oracle.templateCatalogueNonempty, true, "Empty-only template evidence cannot qualify");
  assert.deepEqual(evidence.denials, expected.denials, "Full-runtime denials cannot be replaced by component-tool admission failures");
  assert.deepEqual(evidence.acknowledgements, expected.acknowledgements, "Eight genuine rendered noReview stage ACKs required");
  assert.deepEqual(evidence.observations, expected.observations, "Zero PUBLIC modals, same owner, unchanged business state and independent B1 proof required");
  assert.deepEqual(evidence.rootBinding, expected.rootBinding, "Action evidence cannot borrow another Root/Host/Source binding");
  assert.deepEqual(evidence.preservationPins, expected.preservationPins, "Exact new stopped B1/Core required");
  assert.deepEqual(evidence.independentParentPreservation, expected.independentParentPreservation, "Fresh B0 modes/no grants/no archived SQLite reopen required");
  assert.deepEqual(evidence.referenceSourcePins, expected.referenceSourcePins, "New Action profile support pins cannot refresh older Source evidence");
}

function installedSkillEffectCase() {
  const assertion = `reviewedEvidence.${INSTALLED_SKILL_EVIDENCE_ID}`;
  return {
    id: INSTALLED_SKILL_CASE_ID, operations: SKILL_OPERATIONS, executionProfile: "installed-native-isolated",
    runner: { file: "clients/vscode-host/installed-test.mjs", scenarioArgument: "--native-skill-basic",
      definition: "clients/vscode-host/installed-cold-component.mjs#verifyInstalledColdComponent",
      authority: "Scenario registration is navigation only, not installation, native approval or behavioral proof." },
    reviewedEvidenceRefs: [INSTALLED_SKILL_EVIDENCE_ID],
    stages: [
      { operation: id("add_skill"), stage: "write", assertion: `${assertion}: create success and canonical knowledge.skill.create receipt` },
      { operation: id("get_skill"), stage: "read-after-write", assertion: `${assertion}: actual get_skill returns exact initial content` },
      { operation: id("update_skill"), stage: "update", assertion: `${assertion}: canonical knowledge.skill.update receipt, same ID revision 1 -> 2` },
      { operation: id("get_skill"), stage: "read-after-update", assertion: `${assertion}: actual get_skill returns exact updated content` },
      { operation: id("add_skill"), stage: "same-name-upsert", assertion: `${assertion}.selectors.sameNameUpsert/upsertScope: existing Created overwritten via canonical update, same ID revision 2 -> 3` },
      { operation: id("get_skill"), stage: "read-after-upsert", assertion: `${assertion}: exact replacement content includes unique Skill overwrite sentinel` },
      { operation: id("list_skills"), stage: "list", assertion: `${assertion}: actual list_skills contains Created` },
      { operation: id("search_skills"), stage: "retrieve", assertion: `${assertion}: actual lexical search_skills contains Created` },
      { operation: null, stage: "canonical-receipt", assertion: `${assertion}.selectors.canonicalReceipts: three create/update/upsert records, stableKnowledgeId and exact revisions 1/2/3` },
      { operation: null, stage: "B1-B0-preservation", assertion: `${assertion}.selectors.B1/freshB0: updated Skill preserved at B1 and created Skill absent at fresh B0` },
      { operation: null, stage: "closed-editor-profile-cleanup", assertion: `${assertion}.selectors.exit/profileRemoval: editor exit 0 and private profile removed` },
    ],
    oracle: `${assertion}: real installed extension, actual content equality, list/search identity and native receipt/revision assertions under isolated original-layout fixture`,
    receipt: `${assertion}: hash-pinned accepted report, three canonical create/update/upsert receipts and stable ID/revisions; no unprovided individual receipt SHA claims`,
    preservation: `${assertion}: genuine closed-editor B1 changed-Skill preservation and fresh-B0 created-Skill absence, not general private-profile/keyring restoration or arbitrary asset preservation`,
  };
}

function sourceSkillEffectCase() {
  const name = "socket producer fixture composes one cold owner/Core, exact Note/Skill writes, B1 retirement then fresh B0 restoration";
  const assertion = `tests/original-mcp-cold-component.test.mjs#${name}`;
  return {
    id: SOURCE_SKILL_CASE_ID, operations: SKILL_OPERATIONS, executionProfile: "native-cold-source-isolated",
    test: { file: "tests/original-mcp-cold-component.test.mjs", name },
    stages: [
      { operation: id("add_skill"), stage: "write", assertion: `${assertion}: actual cold component add_skill creates Created` },
      { operation: id("get_skill"), stage: "read-after-write", assertion: `${assertion}: exact Fresh Skill mutation content` },
      { operation: id("update_skill"), stage: "update", assertion: `${assertion}: actual canonical update succeeds` },
      { operation: id("get_skill"), stage: "read-after-update", assertion: `${assertion}: exact Second Skill revision content` },
      { operation: id("add_skill"), stage: "same-name-upsert", assertion: `${assertion}: existing Created replaced` },
      { operation: id("get_skill"), stage: "read-after-upsert", assertion: `${assertion}: exact Third Skill replacement content` },
      { operation: id("list_skills"), stage: "list", assertion: `${assertion}: result includes Created` },
      { operation: id("search_skills"), stage: "retrieve", assertion: `${assertion}: lexical Third Skill replacement result includes Created` },
      { operation: null, stage: "B1-B0-preservation", assertion: `${assertion}: closed-owner B1/SQLite checks and Created absent at fresh restored B0` },
    ],
    oracle: `${assertion}: actual cold owner/Core/reader, socket producer fixture authority only, not genuine installed native UI`,
    receipt: `${assertion}: archived SQLite receipt presence; exact three Skill receipt identities/revisions are established separately by the installed report`,
    preservation: `${assertion}: original root not overwritten, fresh B0 Created absent, same owner lease and closed persistent reader`,
    reportedRun: { level: "source", reporter: "parity-worker verified framework run", outcome: "passed",
      fileSha256: "caa3dc2cebab0c19ea748e88d62d7239bd657124e39c9f63da8b20839f77fdad",
      fileCasesPassed: 21, fileCasesSkipped: 0,
      frameworkRun: { completedAt: "2026-11-22T04:31:38.754Z",
        catalogFingerprint: "19038f30319bcc346f2becfe60d57a72672b469f3e03d00add764c3328f2cd92",
        selectedFiles: 1, casesPassed: 21, casesSkipped: 0,
        mappedWholeFileCasesPassed: 21, mappedWholeFileCasesSkipped: 0,
        opaqueTasks: 0, cleanupErrors: 0, durationMs: 29113, jobs: 1, timeoutSeconds: 180,
        build: "existing-artifacts-no-build",
        sourceIdentityScope: "Actual complete file rerun only; no storage-closure hash or global Source identity claim." },
      trust: "actual whole cold-component file 21/21 zero-skip rerun after GENESIS B1/pending-refusal additions; no additional operation mapping or Original/A/installed re-attestation",
      limitations: ["socket producer fixture, not genuine installed approvals", "not occupied-other-identity replacement or semantic proof",
        "not live production write permission or full151 readiness"] },
  };
}

function skillEffectCase() {
  const assertion = "tests/compatibility-mcp.test.mjs#Skill module preserves write/read/update/retrieve, overwrite and reconnect through the actual compatibility MCP";
  return {
    id: SKILL_CASE_ID, operations: SKILL_OPERATIONS, executionProfile: "compatibility-a-isolated",
    test: { file: "tests/compatibility-mcp.test.mjs",
      name: "Skill module preserves write/read/update/retrieve, overwrite and reconnect through the actual compatibility MCP" },
    stages: [
      { operation: id("add_skill"), stage: "write", assertion: `${assertion}: initial skill_write succeeds` },
      { operation: id("get_skill"), stage: "read-after-write", assertion: `${assertion}: created.content equals initial body` },
      { operation: id("update_skill"), stage: "update", assertion: `${assertion}: skill_modify succeeds` },
      { operation: id("get_skill"), stage: "read-after-update", assertion: `${assertion}: updated content/description/category assertions` },
      { operation: id("list_skills"), stage: "list", assertion: `${assertion}: category-filtered result contains name` },
      { operation: id("search_skills"), stage: "retrieve", assertion: `${assertion}: lexical legacy search contains name` },
      { operation: id("add_skill"), stage: "overwrite", assertion: `${assertion}: skill_write replaces existing name; exact overwritten body read` },
      { operation: id("add_skill"), stage: "guarded-denial-zero-effect", assertion: `${assertion}: capability_read mutation isError and denied target ENOENT` },
      { operation: id("get_skill"), stage: "restart", assertion: `${assertion}: actual gateway reconnect reads exact persistent overwritten content` },
    ],
    oracle: `${assertion}: actual original backend through staged v5 gateway, content equality and preserved category; search/list assert identity, not content/hash`,
    receipt: `${assertion}: MCP result/error and independent denied-target ENOENT; NOT canonical durable native approval/effect receipt coverage`,
    preservation: `${assertion}: no core.sqlite; unchanged category on partial update; NOT full B1/B0/private-assets preservation`,
    reportedRun: { level: "source", reporter: "parent-coordinator task message", outcome: "passed",
      fileSha256: COMPATIBILITY_CASE_FILE_SHA256, fileCasesPassed: 14, fileCasesSkipped: 0,
      sourceFiles: COMPATIBILITY_CASE_SOURCE_FILES.map(source => ({ ...source })),
      trust: "operator-attested exact whole-file run; this static checker does not execute or independently validate that run",
      limitations: ["not live user-root Skill write permission", "not installed native or production effect proof",
        "no semantic route proof", "no canonical native durable receipt/expiry/cancel/B1-B0/private-assets proof"] },
  };
}

function notePaperEffectCase() {
  const name = "Note and Paper modules preserve write/read/update/list/retrieve and reconnect through actual compatibility MCP";
  const assertion = `tests/compatibility-mcp.test.mjs#${name}`;
  const stages = ["note", "paper"].flatMap(module => [
    { operation: id(`add_${module}`), stage: "write", assertion: `${assertion}: ${module}_write returns ok and actual canonical slug` },
    { operation: id(`get_${module}`), stage: "read-after-write", assertion: `${assertion}: ${module}_read returns exact initial content` },
    { operation: id(`update_${module}`), stage: "update", assertion: `${assertion}: ${module}_modify persists updated body; Paper also updates a unique metadata tag` },
    { operation: id(`get_${module}`), stage: "read-after-update", assertion: `${assertion}: exact updated content and unchanged Acceptance category` },
    { operation: id(`list_${module}s`), stage: "list", assertion: `${assertion}: ${module}_list includes exact title` },
    { operation: id(`search_${module}s`), stage: "retrieve", assertion: module === "paper"
      ? `${assertion}: actual lexical metadata tag compatibilitypapermetadataupdated retrieves Paper; this does not prove body-only/full-text or semantic retrieval`
      : `${assertion}: actual lexical updated Note marker retrieves exact title` },
  ]);
  stages.push({ operation: id("search_papers"), stage: "original-offline-metadata-oracle",
    assertion: `${assertion}: paper_search body-only query result deep-equals the actual original capability_read search_papers response, preserving the empty metadata-only fallback instead of inventing content hits` });
  for (const module of ["note", "paper"])
    stages.push({ operation: id(`get_${module}`), stage: "restart",
      assertion: `${assertion}: actual original-backend gateway closes/reconnects and reads exact updated content` });
  return {
    id: NOTE_PAPER_CASE_ID, operations: NOTE_PAPER_OPERATIONS, executionProfile: "compatibility-a-isolated",
    test: { file: "tests/compatibility-mcp.test.mjs", name }, stages,
    oracle: `${assertion}: exact content/category, canonical slug, title membership and original-direct-server Paper body-query equality; offline Paper metadata-only retrieval is preserved`,
    receipt: `${assertion}: actual original MCP result/error through the v5 gateway; no canonical native approval/effect receipt or per-Note/Paper guarded-denial proof`,
    preservation: `${assertion}: omitted category remains Acceptance, original storage/no core.sqlite and actual gateway reconnect; not complete B1/B0 or private/assets preservation`,
    reportedRun: { level: "source", reporter: "parent-coordinator task message", outcome: "passed",
      fileSha256: COMPATIBILITY_CASE_FILE_SHA256, fileCasesPassed: 14, fileCasesSkipped: 0,
      sourceFiles: COMPATIBILITY_CASE_SOURCE_FILES.map(source => ({ ...source })),
      trust: "operator-attested latest exact whole-file run; checker does not execute it",
      limitations: ["only get_paper/list_papers/search_papers formally called; no inferred get_research/list_research/search_research alias coverage",
        "Paper lexical fallback is metadata-only, not body/full-text or semantic success",
        "not installed native or live production Note/Paper permission", "no complete B1/B0/private-assets/denial-expiry-cancel proof"] },
  };
}

function scriptEffectCases() {
  const file = "tests/script-basic-acceptance.test.mjs";
  const refusalName = "Script readonly original IDs and actual original/v5 MCP offline retrieval refusal match exactly without a false positive";
  const algorithmName = "Script pinned original reader and Source Python lexical search/get preserve canonical ID, exact bytes, hash, provenance and refresh with stale-generation refusal and private corpus exclusion";
  const basicName = "Script actual original worker startup binds the complete disposable public corpus to original and v5 MCP search/get, refresh, stale-generation refusal and drained exit";
  const lifecycleName = "owned original Script worker exits before shared fixture removal after an interrupted test flow";
  const refusal = `${file}#${refusalName}`, algorithm = `${file}#${algorithmName}`;
  const basic = `${file}#${basicName}`, lifecycle = `${file}#${lifecycleName}`;
  const reportedRun = (limits) => ({
    level: "source", reporter: "parent-coordinator task message", outcome: "passed",
    fileSha256: SCRIPT_SOURCE_FILES[0].sha256, fileCasesPassed: 4, fileCasesSkipped: 0,
    sourceFiles: SCRIPT_SOURCE_FILES.map(source => ({ ...source })),
    trust: "parent independently verified combined 18/18, zero skips: exact Script four-case file plus compatibility fourteen-case file after retained-worker cleanup changes; checker does not execute that run",
    limitations: limits || ["this refusal/algorithm case does not establish normal MCP positive Script search/get", "no native signed Root/Host/source-policy or installed Script receipt",
      "public-only snapshot exclusion is not native private-source admission", "no Script write/update/execute API, no Script/model/user command executed"],
  });
  return [
    {
      id: SCRIPT_REFUSAL_CASE_ID, coverageKind: "guarded-refusal", operations: SCRIPT_OPERATIONS,
      executionProfile: "compatibility-a-isolated", test: { file, name: refusalName },
      stages: [
        { operation: id("search_scripts"), stage: "offline-worker-refusal", assertion: `${refusal}: original and actual v5 responses exactly match ok=false Subscriber retrieval worker unavailable for body/filename/private/absent queries` },
        { operation: id("get_script"), stage: "offline-worker-refusal", assertion: `${refusal}: actual original/v5 get matches unavailable worker metadata failure; no Script content exposed` },
        { operation: null, stage: "readonly-contract-preservation", assertion: `${refusal}: exact original get/search IDs and readOnly=true module hints; no Script write/modify/execute tool` },
      ],
      oracle: `${refusal}: exact real original/A MCP refusal and aliases, not successful content retrieval or basic operation acceptance`,
      receipt: `${refusal}: exact failure results; no successful worker read or canonical native effect receipt`,
      preservation: `${refusal}: original storage/no core.sqlite; this case is not mutation or B1/B0 coverage`,
      reportedRun: reportedRun(),
    },
    {
      id: SCRIPT_ALGORITHM_CASE_ID, coverageKind: "algorithm-positive", operations: SCRIPT_OPERATIONS,
      executionProfile: SCRIPT_ALGORITHM_PROFILE, test: { file, name: algorithmName },
      stages: [
        { operation: null, stage: "external-fixture-setup", assertion: `${algorithm}: branded disposable .py file and original pinned privacy-policy setup before generation; not a Script write call or sealed native custody` },
        { operation: id("search_scripts"), stage: "source-algorithm-retrieve", assertion: `${algorithm}: pinned storage.js/knowledge-locator.js reader and Source Python Exact/BM25 worker return one exact body match, canonical source ID, complete hit/search field sets, lexical/off/model_invoked=false` },
        { operation: id("get_script"), stage: "source-algorithm-read", assertion: `${algorithm}: exact CRLF/Unicode content, hash/revision/type/metadata/provenance and returned canonical ID; source read_only=false remains distinct from read-only MCP API` },
        { operation: null, stage: "external-CAS-fixture-refresh", assertion: `${algorithm}: owned same-file expected-byte CAS edit only; raw SHA 377704a3dc338af80bd31961aefdb4be4f2141af2209f9b47479ef6cd52ae35e -> 2a697bfec14db8a6b0a729335cc3d7040593ef2b89494df6efa491d8b00c4d30` },
        { operation: id("search_scripts"), stage: "source-algorithm-retrieve-after-refresh", assertion: `${algorithm}: exact fresh body marker, stable canonical ID, changed content/source/corpus revision and generation 1 -> 2; fuzzy old-marker hits may only reference fresh bytes/hash` },
        { operation: id("get_script"), stage: "source-algorithm-read-after-refresh", assertion: `${algorithm}: exact new bytes/hash/full provenance match the fresh projected original document` },
        { operation: null, stage: "stale-generation-refusal", supportingOperation: id("search_knowledge"),
          supportingCoverage: "guarded-refusal-only", assertion: `${algorithm}: supporting exact generation 1 request returns generation-not-ready; search_knowledge is not positive registered operation coverage` },
        { operation: null, stage: "snapshot-private-corpus-exclusion", assertion: `${algorithm}: excluded private Script is absent from search/get and initial dev/ino/size/atime/mtime/ctime/mode preserved; public-only snapshot is not native Root source policy` },
      ],
      oracle: `${algorithm}: independently pinned original 4.0.22 storage readers and projected snapshot plus actual Source Python lexical algorithm, not a normal MCP/worker-binding positive`,
      receipt: `${algorithm}: exact source result fields, canonical pkm://script/script_549a24a0d755c727cac4b5cf, content/source revisions and generations; no installed or native signed source/approval receipt`,
      preservation: `${algorithm}: controlled public fixture byte-CAS, private file statistics and CRLF/Unicode preserved; no native private admission or complete B1/B0 proof`,
      reportedRun: reportedRun(),
    },
    {
      id: SCRIPT_BASIC_CASE_ID, coverageKind: "basic-operation-sequence", operations: SCRIPT_OPERATIONS,
      executionProfile: "compatibility-a-isolated", test: { file, name: basicName },
      stages: [
        { operation: null, stage: "genuine-original-worker-startup", assertion: `${basic}: complete authorized public-only disposable corpus; authentic original RetrievalWorkerManager.sync/ensureLocked/stageRetrievalRuntime publishes its own worker.json/token/PID, exact Python/engine/config/build and ready generation 1; no descriptor/source/model/grant forged` },
        { operation: id("search_scripts"), stage: "retrieve", assertion: `${basic}: actual original/A full MCP results match, exactly one exact body hit, current canonical source ID/revision and compact provenance, explicit lexical/off/model_invoked=false` },
        { operation: id("get_script"), stage: "read", assertion: `${basic}: returned search ID drives actual original/A/module reads; exact independent raw CRLF/Unicode bytes/hash, engine content hash, type/title/metadata/URI/full provenance/corpus generation, source read_only=false without inventing a Script write API` },
        { operation: null, stage: "external-CAS-fixture-refresh", assertion: `${basic}: branded same-file expected-byte edit and genuine manager.sync delta, same worker PID and generation 1 -> 2; not MCP write/update or sealed native custody mutation` },
        { operation: id("search_scripts"), stage: "retrieve-after-refresh", assertion: `${basic}: actual original/A/module full fresh replies equal; exactly one new-marker exact body match and old-marker fuzzy hits only current hashes/revisions` },
        { operation: id("get_script"), stage: "read-after-refresh", assertion: `${basic}: stable returned canonical ID, exact fresh content/raw hash, changed engine/source/corpus revisions and generation 2` },
        { operation: null, stage: "stale-generation-refusal", supportingOperation: id("search_knowledge"),
          supportingCoverage: "guarded-refusal-only", assertion: `${basic}: actual original/A exact generation 1 responses match generation-not-ready; supporting search_knowledge is not registered positive operation coverage` },
        { operation: null, stage: "drained-exit", assertion: `${basic}: real original/A clients quiesce/drain/close before worker /shutdown; same actual worker PID confirmed gone, no core.sqlite adoption` },
      ],
      oracle: `${basic}: exact normal original/A MCP positives through the genuine original worker producer on a complete explicitly authorized public-only root; not pinned-reader/Python-only or native Root/private admission`,
      receipt: `${basic}: real original worker readiness/identity/PID, complete original/A MCP reply equality and indexed byte/hash/generation evidence; no canonical native or installed source/approval receipt`,
      preservation: `${basic}: CRLF/Unicode, canonical source identity, original storage and owned external byte-CAS/drained shutdown; complete public-only root deliberately contains no Private Script directory, not native private-policy or B1/B0 proof`,
      reportedRun: reportedRun(["complete authorized public-only original/A corpus; not native Root/Host/private-source admission or installed Script receipts",
        "no Script write/update/execute API", "search_knowledge is generation refusal only", "no semantic/model or full151 native/production qualification"]),
    },
    {
      id: SCRIPT_LIFECYCLE_CASE_ID, coverageKind: "lifecycle-only", operations: [],
      executionProfile: "compatibility-a-isolated", test: { file, name: lifecycleName },
      stages: [
        { operation: null, stage: "genuine-owned-worker-startup", assertion: `${lifecycle}: real manager.sync worker PID is alive` },
        { operation: null, stage: "interrupted-retained-cleanup", assertion: `${lifecycle}: interrupted flow invokes retained cleanup; worker PID is gone while fixture base still exists` },
        { operation: null, stage: "final-fixture-removal", assertion: `${lifecycle}: actual worker remains gone and base lstat returns ENOENT after client-close -> retained-worker-close -> base removal ordering` },
      ],
      oracle: `${lifecycle}: real process and filesystem lifecycle assertions, not fake-clock/language-only behavior or extra MCP operation coverage`,
      receipt: `${lifecycle}: actual worker PID shutdown before shared fixture removal; no additional business operation IDs`,
      preservation: `${lifecycle}: fixture stays present until worker shutdown is confirmed, then is removed; no production or native Root mutation`,
      reportedRun: reportedRun(["lifecycle evidence only; zero additional original MCP operation coverage",
        "owned disposable original worker fixture, not native Root/Host/private-source or installed receipt qualification"]),
    },
  ];
}

function todoEffectCases() {
  const file = "tests/todo-basic-acceptance.test.mjs";
  const name = "Todo actual original MCP Board and Workitem planning/state CAS preserve generated audit, metadata, refusal no-effect and gateway reconnect";
  const drainName = "Todo cancelled gateway wait retains one real original CAS edit through EOF drain and durable reconnect without replay";
  const assertion = `${file}#${name}`, drain = `${file}#${drainName}`;
  const run = () => ({
    level: "source", reporter: "parent-coordinator task message", outcome: "passed",
    fileSha256: TODO_SOURCE_FILES[0].sha256, fileCasesPassed: 2, fileCasesSkipped: 0,
    sourceFiles: TODO_SOURCE_FILES.map(source => ({ ...source })),
    trust: "parent independently passed the exact two-case Todo file, zero skips, actual original/A MCP and pinned original reader; not a fourteen-case or native/installed run",
    limitations: ["Source/original-A profile only; no native Root/Worker/human acceptance grant",
      "generated original digest/item/history receipts, not Core operation UUID receipts",
      "note_work_item_command and accept_workitem are guarded refusal evidence only",
      "no B1/B0 or full151 native/production qualification"],
  });
  return [
    {
      id: TODO_BASIC_CASE_ID, operations: TODO_OPERATIONS, executionProfile: "compatibility-a-isolated",
      test: { file, name },
      stages: [
        { operation: id("todo_board_create"), stage: "write-board", assertion: `${assertion}: actual empty structured Board slug/items/digest match independent original snapshot` },
        { operation: id("get_board"), stage: "read-board", assertion: `${assertion}: full original/A response parity, actor mcp:external and exact empty/final counts` },
        { operation: id("add_workitem"), stage: "write-planning", assertion: `${assertion}: Task Planning/todo contract persisted, no owner/acceptance decision, first authenticated generated event` },
        { operation: id("get_workitem"), stage: "read-after-write", assertion: `${assertion}: complete original/A get equals add result` },
        { operation: id("update_workitem"), stage: "planning-CAS-update", assertion: `${assertion}: exact digest patch changes title/plannedEnd only, all untouched contract/presentation fields preserved; stale digest causes no Note/pair/metadata/audit effects` },
        { operation: id("get_workitem"), stage: "read-after-update", assertion: `${assertion}: edited result matches original and pinned independent disk snapshot` },
        { operation: null, stage: "restrictive-worker-refusal", supportingOperation: id("note_work_item_command"), supportingCoverage: "guarded-refusal-only",
          assertion: `${assertion}: nonowner and protected-title worker edits denied without any bytes/digest/history change` },
        { operation: null, stage: "reviewer-acceptance-refusal", supportingOperation: id("accept_workitem"), supportingCoverage: "guarded-refusal-only",
          assertion: `${assertion}: external actor cannot self-delegate acceptance; no effects or accepted/human outcome` },
        { operation: id("claim_workitem"), stage: "authenticated-CAS-claim", assertion: `${assertion}: owner mcp:external, WIP/active; no Agent launch or inherited native worker permission` },
        { operation: id("change_workitem_state"), stage: "owner-state-CAS", assertion: `${assertion}: nonowner transition denied; authenticated owner reaches OnHold/on-hold, history count four, acceptance/outcome absent` },
        { operation: id("list_workitems"), stage: "retrieve-workitems", assertion: `${assertion}: query/state/digest-filtered exact original/A item and pagination` },
        { operation: id("list_boards"), stage: "retrieve-boards", assertion: `${assertion}: exact original/A Board query/title/slug result` },
        { operation: id("list_workitem_history"), stage: "retrieve-paged-audit", assertion: `${assertion}: two pages produce exactly create/edit/claim/transition with actor/time/field differences; stale page digest denied without effects` },
        { operation: id("list_board_changes"), stage: "retrieve-generated-events", assertion: `${assertion}: four stable item event IDs and exact original/A history parity` },
        { operation: id("note_work_items"), stage: "authoritative-pair-read", assertion: `${assertion}: exact original Board pair snapshot; raw Note and presentation metadata unchanged` },
        { operation: id("get_workitem"), stage: "gateway-reconnect", assertion: `${assertion}: different actual gateway PID returns exact persisted OnHold state, digest and unchanged history; original storage remains owner` },
      ],
      oracle: `${assertion}: actual original 2.19/151/27 complete response parity and pinned .22 private reader oracle; generated audit, paired Board bytes, digest and immutable metadata`,
      receipt: `${assertion}: four actual generated original events and CAS digest/item results, not native Core operation UUIDs, execution or human acceptance`,
      preservation: `${assertion}: raw Note/metadata/untouched contract fields, pair audit, guarded refusals and different-PID reconnect; no native Root/B1/B0 proof`,
      reportedRun: run(),
    },
    {
      id: TODO_DRAIN_CASE_ID,
      operations: ["todo_board_create", "add_workitem", "update_workitem", "get_workitem", "list_workitem_history"].map(id),
      executionProfile: "compatibility-a-isolated", test: { file, name: drainName },
      stages: [
        { operation: id("todo_board_create"), stage: "write-board", assertion: `${drain}: real empty Board created` },
        { operation: id("add_workitem"), stage: "write-planning", assertion: `${drain}: real Planning task and initial digest/history` },
        { operation: id("update_workitem"), stage: "cancelled-wait-admitted-write", assertion: `${drain}: held original mutation lock, gateway inFlight=1 before caller cancellation; draining uncertainCalls=1/automaticReplay=false, cancelled wait is not a success receipt` },
        { operation: null, stage: "EOF-drain", assertion: `${drain}: actual stdin EOF cannot exit while original lock is held; release completes one real write and process exits code 0` },
        { operation: id("get_workitem"), stage: "durable-reconnect-read", assertion: `${drain}: different gateway PID observes exactly one persisted title edit/new digest, no owner/acceptance delegation` },
        { operation: id("list_workitem_history"), stage: "single-edit-audit", assertion: `${drain}: exactly create/edit events, authenticated actor, independent original pair/digest/history/metadata equality and no replay` },
      ],
      oracle: `${drain}: real original business CAS survives cancelled wait/EOF and is independently read after a genuine process reconnect`,
      receipt: `${drain}: cancelled caller receipt is not success; one persisted original edit and exact generated audit establish effect after drain, not Core UUID or human acceptance`,
      preservation: `${drain}: Note/metadata and untouched planning fields preserved, original storage/no native adoption; no duplicate generated edit, no implicit native worker grant`,
      reportedRun: run(),
    },
  ];
}

function aTrashEffectCases() {
  const file = A_TRASH_SOURCE_FILES[0].file;
  const reportedRun = () => ({
    level: "source", reporter: "parent-coordinator task message", outcome: "passed",
    fileSha256: A_TRASH_SOURCE_FILES[0].sha256, fileCasesPassed: 4, fileCasesSkipped: 0,
    sourceFiles: A_TRASH_SOURCE_FILES.map(source => ({ ...source })),
    originalVsixSha256: "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27",
    frameworkRun: { shellId: "19539", completedAt: "2026-11-22T19:13:35.929Z", elapsedMs: 35734,
      mappedWholeFileCasesPassed: 4, mappedWholeFileCasesSkipped: 0 },
    trust: "Agent 4/4 followed by Parent independently verified actual private-framework whole-file 4/4; three positive original IDs only, fourth case is a restrictive private-shared/path boundary.",
    limitations: ["Original/A synthetic public pairs only; no native or installed Trash qualification",
      "Original22 direct private Skill deletion was exposed in initial characterization and remains unsafe/unqualified, not an A regression",
      "private-shared pair refusal is restriction evidence only, not direct-private-target safety",
      "closed Original oracle list/restore are not public MCP operations or actual-root/old-bucket restore",
      "no canonical native UUID/approval receipt, installed expiry/cancellation, B1/B0 or full cutover"],
  });
  const direct = ["skill", "paper"].map(kind => {
    const name = `Pinned Original/A delete_${kind} physically moves exact public pairs, preserves revision/history, and reconnects without replay`;
    const assertion = `${file}#${name}`;
    return {
      id: `compatibility-a-${kind}-trash-basic`, operations: [id(`delete_${kind}`)], executionProfile: "compatibility-a-isolated",
      test: { file, name },
      stages: [
        { operation: null, stage: "original-public-pair-read",
          assertion: `${assertion}: pinned Original Upsert fixture revision 2, exact original/A public get content with Python newline normalization; raw CRLF/Unicode bytes and binary pair independently captured` },
        { operation: id(`delete_${kind}`), stage: "paired-delete",
          assertion: `${assertion}: actual Original and A public capability_call use exact ${kind === "skill" ? "{name:document.name}" : "{slug:document.slug}"}; ok/trash fields deep-equal pinned original deletion oracle with actual receipt timestamp/id; owner and pair absent, payload/assets/metadata/history exact` },
        { operation: id(`delete_${kind}`), stage: "absent-idempotency",
          assertion: `${assertion}: both transports repeat deletion with exact original absent response; ordinary not-found read is not a positive read; lists omit target and all inode/hash/journal state stays unchanged` },
        { operation: id(`delete_${kind}`), stage: "gateway-reconnect-no-replay",
          assertion: `${assertion}: actual fresh Original/A connections retain absent response and exact Trash payload without another bucket/journal record` },
        { operation: null, stage: "closed-oracle-only-restore",
          assertion: `${assertion}: separate oracleRoot list/restore returns original identity/revision 2 and exact pair bytes; real MCP root remains deleted and unchanged, no public restore/list alias or old-bucket restore qualification` },
        { operation: null, stage: "owned-exit-before-fixture-removal",
          assertion: `${assertion}: genuine Original/A transport supervisors exit before owned roots and pinned release/oracle removal; no Core/Board/native Root adoption` },
      ],
      oracle: `${assertion}: original/A business metadata and actual public results plus independently pinned 4.0.22 store deletion/raw byte/pair/journal oracle; aliases and private-target deletion safety excluded`,
      receipt: `${assertion}: exact original trash id/kind/name/path/deletedAt/assetsPath and durable deletion-history bytes, not native operation UUID or installed approval receipt`,
      preservation: `${assertion}: original revision 2/CRLF/Unicode/binary pair preserved in physical Trash, repeat/reconnect no effect and owned shutdown; closed-oracle restore is not actual MCP restore, native B1/B0 or private safety`,
      reportedRun: reportedRun(),
    };
  });
  const name = "Pinned Original/A reviewed knowledge_file_trash checks exact SHA before paired deletion; read lane and CAS refusal have no effects";
  const assertion = `${file}#${name}`;
  return [...direct, {
    id: "compatibility-a-reviewed-file-trash-basic", operations: [id("knowledge_file_trash")], executionProfile: "compatibility-a-isolated",
    test: { file, name },
    stages: [
      { operation: id("knowledge_file_trash"), stage: "read-lane-and-stale-CAS-refusal",
        assertion: `${assertion}: both Original/A read-lane requests and expected_sha256='0'.repeat(64) refuse with no inode/hash/bucket/journal change` },
      { operation: id("knowledge_file_trash"), stage: "reviewed-paired-delete",
        assertion: `${assertion}: exact {area:document.area,path:document.path,expected_sha256:sha256(raw)}; actual Original Skill and A Paper calls deep-equal complete pinned deletion oracle, physical owner/pair absent and payload/assets/metadata/history exact` },
      { operation: null, stage: "owned-exit-before-fixture-removal",
        assertion: `${assertion}: authentic Original/A transports close and supervised PIDs exit before owned root/release/oracle cleanup; no restore/list alias or native adoption` },
    ],
    oracle: `${assertion}: actual reviewed-file Original/A public calls, independently pinned .22 result/raw paired-byte/history oracle; no inference from conditional native branch`,
    receipt: `${assertion}: exact original bucket metadata and deletion-history bytes under real expected SHA; not canonical native UUID or installed custody`,
    preservation: `${assertion}: exact paired Trash bytes and zero-effect read/CAS refusals, owned process cleanup; no same-operation actual reconnect for this case, installed B1/B0 or private-target safety`,
    reportedRun: reportedRun(),
  }];
}

function heldSchemaEffectCase() {
  const file = "tests/held-script-custody-parser.test.mjs";
  const name = "actual held e876 sealed v1 Script custody schemas accept compatible DTOs and refuse genuine current v2 plan/journal in a closed Source-staged probe";
  const assertion = `${file}#${name}`;
  return {
    id: HELD_SCHEMA_CASE_ID, coverageKind: "schema-compatibility-only", operations: [],
    executionProfile: "source-staged-held-schema-probe", test: { file, name },
    archivePin: {
      uri: "file:///home/yuwang8/.copilot/session-state/1f1a4feb-dd26-4795-b09f-df30e5d19130/files/live-mcp-parity/native-public-trash-candidate.vsix",
      sha256: "e87602ed6ef34660c0af0c577ad33d5e9cd841b3a6b0d8e47a69763e20d71725",
      payloadBuildId: "6116952f74b1087cd364a21dbaad8908f7193245ae8bf6de7c239d0d0d0b63cf",
      manifestSha256: "2b24bf5b8a3de77654922e28246057d53021e8a2ed737743bd91000eeda87765",
      actualHeldSchemaModuleSha256: "c5e9a758978f77afaaff7529ee092ff875bc5435a5fe6391088d73116594dcb1",
      authority: "Actual held archive/module/packaged-Zod dependency closure, sealed-manifest and before/after hash checks; not newly built v1 schemas or a filename-derived identity.",
    },
    stages: [
      { operation: null, stage: "actual-source-staged-v2-fixture",
        assertion: `${assertion}: real current WeakMap-branded component fixture/B0 and writer fence, actual current v2 capture/prepare/journal; unbranded clone refused, core.sqlite absent, no current Owner/Storage opened` },
      { operation: null, stage: "closed-held-schema-import",
        assertion: `${assertion}: actual sealed old plan/journal schemas and actual packaged Zod only; exact closed read directory, no filesystem writes/network/children/workers/addons/SQLite or old Owner/engine` },
      { operation: null, stage: "compatible-v1-control-accepted",
        assertion: `${assertion}: actual held exports accept compatible v1 plan/journal DTO controls; these controls are not genuine v1 Root/Host serving admission` },
      { operation: null, stage: "actual-v2-plan-journal-refused",
        assertion: `${assertion}: actual held exports refuse genuine current v2 plan and matched journal; old archive/member/manifest pins unchanged before/after` },
    ],
    oracle: `${assertion}: independently rerun actual held-module schema compatibility probe against a genuine Source-staged v2 fixture, not current v1-schema substitution, owner execution or installed UI`,
    receipt: `${assertion}: closed parser result and exact old archive/build/manifest/schema-module pins; zero business operation IDs, oldOwnerServingQualified=false`,
    preservation: `${assertion}: actual fence/directory ownership released and removed, exact sealed input bytes preserved; no native Script serving, complete retirement, installed or v1-serving proof`,
    reportedRun: { level: "source", reporter: "parent-coordinator task message", outcome: "passed",
      fileSha256: "49b885c891f41de322972dffc84555a137e2f6f3a48b98874fb2a553395b34fc",
      fileCasesPassed: 1, fileCasesSkipped: 0,
      sourceFiles: [
        { file, sha256: "49b885c891f41de322972dffc84555a137e2f6f3a48b98874fb2a553395b34fc" },
        { file: "clients/vscode-host/installed-held-script-custody-parser.mjs",
          sha256: "c28951f3bc0fa0fe17c02d5d5be7a077fbece7bbbe0524992e77ad82514ebf45" },
      ],
      trust: "parent independently passed the actual held-parser one-case file, zero skips; static checker does not execute it or open the external archive",
      limitations: ["schema compatibility only, zero original operation IDs", "Source-staged, not installed UI",
        "no old/current Owner or old engine", "compatible v1 DTO is not v1 Root/Host Script serving refusal",
        "native Script retirement/full freeze/installed qualification remains separate and pending"] },
  };
}

function requiredSequence(contract) {
  const name = contract.transportName, module = moduleFor(name);
  const success = contract.description.replace(/\s+/g, " ").trim();
  const families = [
    ["Note", "add_note", "get_note", "update_note", "search_notes", "list_notes"],
    ["Skill", "add_skill", "get_skill", "update_skill", "search_skills", "list_skills"],
    ["Research", "add_paper", "get_research", "update_paper", "search_research", "list_research"],
  ];
  const family = families.find(([kind]) => kind === module);
  if (family && !["skill_capabilities", "skill_context", "skill_feedback", "propose_skill_update", "paper_graph"].includes(name)) {
    const [kind, create, get, update, search, list] = family;
    return {
      fixture: `Owned isolated ${kind} with unique marker, untouched metadata and assets; no live library.${kind === "Research" ? " Use a unique title/tag metadata key for original offline lexical Paper retrieval; body-only fallback may be empty." : ""}`,
      steps: [
        step(create, "write", kind === "Skill" ? "New name persists content; existing-name upsert is separately checked, not silently treated as create-only." : "New record persists; existing-entry conflict preserves bytes."),
        step(get, "read-after-write", "Read exact initial content, canonical identity and metadata from independent storage."),
        step(update, "update", "Change one field; preserve omitted fields, assets and identity/move semantics from the original contract."),
        step(get, "read-after-update", "Read exact replacement content; old marker absent, untouched fields/assets unchanged."),
        step(search, "retrieve", kind === "Research"
          ? "Original offline lexical Paper/Research fallback may search metadata only: unique title/tag key retrieves this source; body-only query must match actual original empty-result behavior. Do not substitute full-text/semantic claims."
          : "Unique updated marker returns this canonical source, not stale content; verify declared route/result shape."),
        inspect(list, "Original filters, ordering and pagination include only expected records."),
        ...(![create, get, update, search, list].includes(name) ? [call(name, success)] : []),
      ],
    };
  }
  if (module === "Script") return {
    fixture: "Author an owned Script fixture externally; the original catalog exposes get_script/search_scripts only, no Script create/update/execute operation.",
    profileRestrictions: {
      unsealedExternalRefresh: ["compatibility-a-isolated", SCRIPT_ALGORITHM_PROFILE],
      nativeSealedCustody: "Exact installed v2 frozen initial public read/private exclusion, two-editor admission and stopped B1-image/fresh-B0 scope is qualified; not a general full-Root/cutover guarantee. Historical v1 Scripts are auxiliary-only; those semantics require explicit upgrade and cannot be reinterpreted. Genuine v1 serving, installed post-seal edit/refresh/recapture and reopened B1-row proof remain unqualified. A's unsealed refresh is not authority to edit frozen custody.",
    },
    steps: [step("search_scripts", "retrieve", "Find expected Script type/source_id and route/model status."),
      inspect("get_script", "Read exact bytes/hash/provenance by returned stable source_id; Script is never executed."),
      { stage: "fixture-update", operation: null, executionProfiles: ["compatibility-a-isolated", SCRIPT_ALGORITHM_PROFILE],
        oracle: "Explicit controlled external file edit in an owned unsealed fixture only, not an invented script_write or authorization to edit native sealed Script custody; assert refreshed revision after index synchronization." },
      { ...step("search_scripts", "retrieve-after-fixture-update", "New marker/hash is returned and old revision is not misrepresented."),
        executionProfiles: ["compatibility-a-isolated", SCRIPT_ALGORITHM_PROFILE] },
      { ...inspect("get_script", "Updated unsealed-fixture bytes; private corpus exclusion is not native source admission; no code execution."),
        executionProfiles: ["compatibility-a-isolated", SCRIPT_ALGORITHM_PROFILE] }],
  };
  if (module === "Retrieval") return {
    fixture: "Owned typed local/subscribed corpus, complete judged source IDs and independently admitted frozen model; offline lexical run is separate from semantic/dual.",
    steps: [
      inspect("retrieval_status", "Persistent worker/corpus revision and actual ready/model state."),
      step("search_knowledge", "retrieve", "Canonical IDs, hashes, types/provenance, declared route/model_invoked and missed relevant sources; no silent semantic-to-lexical substitution."),
      inspect("get_knowledge", "Read each returned indexed revision with exact hash/type/provenance/read-only status."),
      ...(name === "retrieval_feedback" ? [call(name, "Complete relevance labels bound to a real retrieval receipt; user provenance only for explicit user judgments; frozen embeddings preserved."),
        inspect("retrieval_status", "Durable learning/ranker/calibrator receipt survives restart without invented relevance labels.")] : []),
    ],
  };
  if (module === "Todo") {
    const story = name.includes("userstor");
    const boardReads = ["list_boards", "get_board", "list_board_changes", "list_agents", "note_work_item_notes", "note_work_items"];
    return {
      fixture: "Owned structured Board/Note with dependency, owner, external actor and authenticated worker; exact digest and generated audit.",
      steps: boardReads.includes(name)
        ? [inspect("get_board", "Initial identity/digest/counts."), call(name, success), inspect("get_board", "Read-only inspection preserves Board bytes and ownership.")]
        : [call("todo_board_create", "Empty structured Board, canonical slug/digest."),
          call(story ? "add_userstory" : "add_workitem", story ? "Story goal/scope/acceptance and child contract persisted." : "Planning contract persisted without acquiring ownership."),
          inspect(story ? "get_userstory" : "get_workitem", "Initial contract, owner/state and digest."),
          ...(!["todo_board_create", "add_userstory", "add_workitem"].includes(name) ? [call(name, success)] : []),
          inspect(story ? "get_userstory" : "get_workitem", "Exact transition/patch/result or include_deleted tombstone; no self-delegated reviewer, inherited worker authority or implicit parent restore."),
          inspect("list_workitem_history", "Authenticated actor/time and exact single durable event."),
          inspect("list_board_changes", "Stable event_id and digest-pinned pagination; no duplicate effect on retry.")],
    };
  }
  if (module === "Trash") {
    const kind = name === "delete_skill" ? "skill" : name === "delete_paper" ? "paper" : "note";
    return {
      fixture: "Owned original knowledge target plus original Trash custody and independently approved exact bytes. Native list/restore requirements remain supplemental, not invented original IDs.",
      steps: [
        ...(name !== "knowledge_file_trash" ? [call(`add_${kind}`, "Create exact target bytes/assets."), inspect(`get_${kind}`, "Read original target.")] : []),
        call(name, success),
        { operation: null, stage: "receipt", oracle: "Durable original deletion intent + target hash and complete Trash bytes/assets; no permanent unlink." },
        { operation: null, stage: "restart", oracle: "Canonical owner reopens; intent/custody reconcile once without deletion replay. Separate approved native restore returns exact original bytes." },
      ],
    };
  }
  if (module === "ApiChat") return {
    fixture: "Owned Host/Chat/source, deterministic authorized loopback provider, exact native model/tool approval; separate archived adoption case. No live provider or private user history.",
    steps: [
      inspect("api_chat_capabilities", "Discover actual Host; discovery starts no model."),
      call("api_chat_create", "Named Group-only Chat displayed with exact selected model; creates no response/Task."),
      inspect("api_chat_list", "Canonical Chat URL and metadata, no bodies/Trash."),
      ...(!["api_chat_capabilities", "api_chat_create", "api_chat_list"].includes(name) ? [call(name, success)] : []),
      inspect("api_chat_request_get", "Inspect returned existing request_id only; receipt completion is not automatically response completion."),
      inspect("api_chat_get", "Exact final/partial response, tool statuses, usage/Harness; same Chat ownership, no duplicate send after restart."),
    ],
  };
  if (module === "Room") return {
    fixture: "Bounded loopback original Room with explicit Magic Link and two aliases; independent credential/source approval. No real remote Room.",
    steps: [
      call("chat_join", "Join exact Magic Link; distinct automatic identities/cursors."),
      ...(!["chat_join", "chat_post", "chat_read", "chat_leave"].includes(name) ? [call(name, success)] : []),
      call("chat_post", "One directed message; progress vs final/standby semantics, no send replay."),
      inspect("chat_read", "Recipient sees exact message once; proper alias cursor."),
      call("chat_leave", "Remove only selected identity; preserve other alias/Room state."),
    ],
  };
  if (module === "Recipe") return {
    fixture: "Owned pinned Recipe library/revision/digest. NoOp success is a narrow case; original command/Script, human/Agent/native/subflow cases must be separately authorized, never assumed.",
    steps: name === "recipe_search" || name === "recipe_capabilities" || name === "recipe_usage_summary"
      ? [call(name, success)]
      : [
        inspect("recipe_search", "Qualified task/Skill contract and candidate revision; no-match is a prerequisite for from-Skill creation."),
        ...(name === "recipe_create_from_skill" || name === "recipe_run_start_adhoc" ? [call(name, success)] : []),
        ...(name !== "recipe_run_start_adhoc" ? [call("recipe_run_start", "Pinned idempotent run, explicit command_id/input; autonomous boundaries honored.")] : []),
        inspect("recipe_run_get", "Exact run/node state; lazy native inspection mutation needs separate authority."),
        ...(!["recipe_create_from_skill", "recipe_run_start_adhoc", "recipe_run_start", "recipe_run_get"].includes(name) ? [call(name, success)] : []),
        inspect("recipe_run_get", "Persisted claimed/progress/human-gate/outcome/terminal state; no fabricated reports, unexpected worker or duplicate node effect."),
      ],
  };
  if (module === "Action") {
    const proposal = /(?:register|graph_|definition_check|template|proposals)/.test(name);
    const packageOperation = name.includes("module_set");
    if (name === "action_validate" || name.startsWith("action_validation_")) return {
      fixture: "Owned intrinsic builtin or operator-reviewed exact source with explicit smoke-test consent and a prepared queued/active/crashed qualification job as required. Never call an unqualified Action first.",
      steps: [
        inspect("action_definition_check", "Pinned definition/dependencies checked without saving or executing; this is not qualification."),
        call(name, success),
        inspect("action_get", "Exact target-host readiness/validation state; queue submission/status/cancellation is not itself successful qualification."),
        { operation: null, stage: "qualification-receipt", oracle: "Assert durable job ID/revision, actual build/test evidence, cancellation/restart outcome and no automatic replay of crashed active tests. Non-builtin code-review-required paths remain explicit, not smoke-success claims." },
      ],
    };
    if (name === "action_cosmos_configure" || name === "action_implementation_select") return {
      fixture: "Owned private host configuration or ambiguous target bindings; independent operator approval, no remote Cosmos request.",
      steps: [
        inspect("action_get", "Read pinned definition/target readiness without invocation."),
        call(name, success),
        inspect("action_get", "Exact selected target readiness; configuration/selection grants no new invocation/effect permissions."),
        { operation: null, stage: "private-configuration-preservation", oracle: "Exact local binding receipt; no credentials/exported host state or automatic remote call; denied/stale selection preserves original configuration." },
      ],
    };
    return {
      fixture: "Owned pinned definition/input/toolchain and exact local path/effect grant; intrinsic pure and bounded Program success do not qualify arbitrary Action/Cosmos.",
      steps: proposal ? [
        call(name, success),
        inspect("action_proposals", "Submitted proposal remains pending operator approval; previous approved definition unchanged."),
        inspect("action_get", "Definition/schema/current readiness only; no invocation or unauthorized registration."),
      ] : packageOperation ? [
        inspect("action_module_sets", "Initial immutable installed package inventory."),
        call(name, success),
        inspect("action_module_sets", "Exact disabled/enabled/removed version state; portable assets only, caller files/credentials/retained runs untouched."),
      ] : ["action_capabilities", "action_retrieve"].includes(name) ? [call(name, success)] : [
        ...(name !== "action_call" ? [call("action_call", "One approved pinned run; durable run ID does not alone prove output/effect.")] : []),
        call(name, success),
        inspect("action_run_get", "Exact durable original run/revision/outputs/effect uncertainty; no replacement invocation."),
        inspect("action_run_events", "Durable cursor, deduplication and explicit gaps; cancellation/recovery never invents rollback or replays unknown remote mutations."),
      ],
    };
  }
  if (module === "Snapshot") return {
    fixture: "Owned private Git/knowledge/privacy plus independently captured user index; no pushes, model calls or live snapshot history.",
    steps: [
      call("knowledge_snapshot_create", "Immutable local tag contains exact active knowledge/privacy; excludes runtime state and leaves user index unchanged."),
      ...(name === "knowledge_snapshot_restore_apply" ? [
        inspect("knowledge_snapshot_restore_preview", "Prepare exact approved unchanged preview after an explicit controlled knowledge edit; capture current privacy and conflict bytes."),
      ] : []),
      ...(!["knowledge_snapshot_create", "knowledge_snapshot_status"].includes(name) ? [call(name, success)] : []),
      inspect("knowledge_snapshot_status", "Exact tags/schedule/timezone/UTC; approved unchanged restore preview requires safety snapshot and Trash journal, preserving current privacy."),
    ],
  };
  if (module === "Recovery") return {
    fixture: "Owned missing file and one existing conflicting file; exact independent recovery bytes/hash/plan.",
    steps: [inspect("knowledge_recovery_preview", "Hash-verified bounded plan, zero writes."),
      ...(name === "knowledge_recovery_apply" ? [call(name, "Restore only approved missing files; preserve existing conflict bytes; one durable audit per write.")] : []),
      { operation: null, stage: "independent-file-read", oracle: "Exact restored bytes/assets and unchanged conflicting/private files; hash/plan change denies all effects." }],
  };
  if (module === "AssetClassification") return {
    fixture: "Owned public/private/duplicate/misclassified assets and concurrent post-apply metadata edit; no inference.",
    steps: [
      inspect("asset_classify_preview", "Model-free exact proposals; excludes private assets; no writes."),
      ...(!["asset_classify_preview"].includes(name) ? [call("asset_classify_apply", "Only explicitly approved proposal IDs change metadata; exact before-image journal.")] : []),
      ...(name === "asset_classify_rollback" ? [call(name, "Restore exact journal bytes only where unchanged since apply; skip concurrent edits.")] : []),
      { operation: null, stage: "independent-file-read", oracle: "Content/assets/private bytes preserved; assert expected metadata difference or rollback, not just schema." },
    ],
  };
  if (module === "Subscription") return {
    fixture: "Owned physically isolated downloaded subscription cache with publisher/subscriber provenance; no local Knowledge Root writes, credentials or sync.",
    steps: [call("search_subscribed_content", "Explicit cache search yields canonical content URI/provenance."),
      ...(!["search_subscribed_content"].includes(name) ? [call(name, success)] : []),
      { operation: null, stage: "preservation", oracle: "Exact returned subscribed bytes/provenance and unchanged local Knowledge Root; preserve original readOnly=false channel metadata even for read-like semantics." }],
  };
  if (module === "AgentSnapshot") return {
    fixture: "Owned immutable Agent Snapshot with task/checkpoint/todo and recovery-verifier sentinel; typed state receipt.",
    steps: [inspect("agent_session_snapshot_list", "Expected immutable snapshot metadata without payload/verifier."),
      ...(!["agent_session_snapshot_list"].includes(name) ? [call(name, success)] : []),
      { operation: null, stage: "preservation", oracle: "Correct captured state, verifier redacted; no Agent Session creation or mutation." }],
  };
  if (module === "Skill") return {
    fixture: "Owned formal Skill and exact task/retrieval/usage/proposal source; no implicit formal Skill update or Recipe creation.",
    steps: [inspect("get_skill", "Capture exact formal bytes/assets."),
      call(name, success),
      inspect("get_skill", name === "skill_context" ? "Smallest explicitly activated Skill set and receipt; formal content unchanged." : "Formal bytes/assets unchanged; feedback/proposal effect has separate durable review receipt.")],
  };
  if (module === "Research") return {
    fixture: "Owned citation pair, topic and popularity order; private Research sentinel.",
    steps: [call("add_paper", "Persist citing/cited records."), call("update_paper", "Persist one citation relation; preserve unrelated fields."),
      call(name, success), inspect("get_research", "Exact citing/cited provenance and no private content.")],
  };
  if (module === "Portal") return {
    fixture: "Owned loopback temporary/saved endpoint adapter only; QBR explicitly deferred, no repair/connect/send against real endpoints.",
    steps: [call(name, "Exercise each original input-schema action with its exact native approval; inspect connection metadata separately from explicit effects."),
      { operation: null, stage: "independent-receiver", oracle: "Approved loopback action observed once; denied/expired target sees zero traffic; existing saved endpoints unchanged." }],
  };
  if (module === "Diagnostics") return {
    fixture: "Owned metadata events with transcript/secret sentinels.",
    steps: [call(name, "Return exactly bounded 1–1000 recent metadata-only events; no transcript/secret/raw telemetry, no state mutation.")],
  };
  throw new Error(`No operation-specific requirement for ${name}`);
}

function buildMatrix(root = ROOT) {
  const { fixture, contracts } = originalContracts(root), facts = sourceFacts(root);
  const originalNames = new Set(contracts.map(contract => contract.transportName));
  for (const name of facts.gate) assert(originalNames.has(name), `Source producer names orphan original operation ${name}`);
  const rows = contracts.map(contract => ({
    id: contract.id, version: contract.version, readOnly: contract.readOnly,
    module: moduleFor(contract.transportName), action: contract.transportName,
    originalAvailability: "present-in-pinned-original-catalog",
    compatibilityA: { availability: "available-with-original-policy", executor: "original-business-runtime",
      database: "original-business-database", channel: contract.readOnly ? "capability_read" : "capability_call",
      operation: contract.id, version: contract.version },
    native: nativeFor(contract, facts),
    evidence: { source: "inspection-only",
      installed: SKILL_OPERATIONS.includes(contract.id) ? "reviewed-isolated-basic-sequence-receipts-B1-B0"
        : contract.transportName === "delete_note" ? "reviewed-installed-public-note-trash-receipts-successors-B1-B0"
          : SCRIPT_OPERATIONS.includes(contract.id) ? "reviewed-installed-v2-frozen-initial-read-private-exclusion-B1-image-fresh-B0"
            : TODO_OPERATIONS.includes(contract.id) ? "reviewed-installed-first-board-planning-source-receipts-B1-fresh-B0" : "unverified-operation-sequence",
      production: "unverified-operation-sequence",
      compatibilityA: [...SKILL_OPERATIONS, ...NOTE_PAPER_OPERATIONS, ...SCRIPT_OPERATIONS, ...TODO_OPERATIONS].includes(contract.id)
        ? "operator-attested-isolated-basic-success" : TODO_REFUSAL_OPERATIONS.includes(contract.id)
          ? "operator-attested-refusal-only-basic-unqualified" : "unverified-no-formal-effect-case",
      nativeColdSource: SKILL_OPERATIONS.includes(contract.id) ? "operator-attested-socket-fixture-same-name-upsert" : "unverified-no-formal-effect-case",
      ...(SCRIPT_OPERATIONS.includes(contract.id) ? { algorithmSource: "operator-attested-pinned-reader-source-python-lexical-only" } : {}),
      effectCaseRefs: SKILL_OPERATIONS.includes(contract.id) ? [SKILL_CASE_ID, SOURCE_SKILL_CASE_ID, INSTALLED_SKILL_CASE_ID]
        : NOTE_PAPER_OPERATIONS.includes(contract.id) ? [NOTE_PAPER_CASE_ID]
          : SCRIPT_OPERATIONS.includes(contract.id) ? [SCRIPT_REFUSAL_CASE_ID, SCRIPT_ALGORITHM_CASE_ID, SCRIPT_BASIC_CASE_ID, INSTALLED_SCRIPT_CASE_ID]
            : contract.transportName === "delete_note" ? [INSTALLED_TRASH_CASE_ID]
              : TODO_OPERATIONS.includes(contract.id) ? [...todoEffectCases().filter(effect => effect.operations.includes(contract.id)).map(effect => effect.id), INSTALLED_TODO_CASE_ID] : [],
      ...(TODO_REFUSAL_OPERATIONS.includes(contract.id) ? { guardedEvidenceRefs: [TODO_BASIC_CASE_ID] } : {}),
      reviewedEvidenceRefs: SKILL_OPERATIONS.includes(contract.id) ? [INSTALLED_SKILL_EVIDENCE_ID]
        : contract.transportName === "delete_note" ? [INSTALLED_TRASH_EVIDENCE_ID]
          : SCRIPT_OPERATIONS.includes(contract.id) ? [INSTALLED_SCRIPT_EVIDENCE_ID]
            : TODO_OPERATIONS.includes(contract.id) ? [INSTALLED_TODO_EVIDENCE_ID] : [],
      refs: ["original-catalog", "source-inspection", "operator-installed-boundaries", "operator-production-A"] },
    requiredCase: { id: `original-${contract.transportName}-basic`, ...requiredSequence(contract),
      executionProfiles: ["compatibility-a-isolated", "native-original-dogfood-isolated", "native-cold-source-isolated", "installed-native-isolated",
        ...(SCRIPT_OPERATIONS.includes(contract.id) ? [SCRIPT_ALGORITHM_PROFILE] : [])],
      requiredChecks: ["exact-original-result", "guarded-denial-zero-effect", "expiry-cancel-no-late-effect",
        "durable-receipt-or-read-preservation", "restart-no-replay", "B1-B0-preservation"],
      coverage: SKILL_OPERATIONS.includes(contract.id) ? "A-and-native-same-name-upsert-basic-receipts-preservation-full-acceptance-incomplete"
        : NOTE_PAPER_OPERATIONS.includes(contract.id) ? "A-basic-success-reconnect-full-acceptance-incomplete"
          : SCRIPT_OPERATIONS.includes(contract.id) ? "A-basic-plus-installed-frozen-initial-private-preservation-scope-full-acceptance-incomplete"
            : contract.transportName === "delete_note" ? "installed-fresh-public-note-trash-basic-qualified-full-acceptance-incomplete"
              : TODO_OPERATIONS.includes(contract.id) ? "A-plus-installed-first-board-planning-CAS-audit-B1-qualified-full-native-acceptance-incomplete"
                : TODO_REFUSAL_OPERATIONS.includes(contract.id) ? "guarded-refusal-only-basic-unqualified" : "unverified-no-formal-effect-case" },
  }));
  for (const row of rows.filter(row => INSTALLED_INPLACE_OPERATIONS.includes(row.id))) {
    row.evidence.installed = "reviewed-installed-existing-resource-inplace-immediate-read-private-controls-B1-B0";
    row.evidence.effectCaseRefs.push(INSTALLED_INPLACE_CASE_ID);
    row.evidence.reviewedEvidenceRefs.push(INSTALLED_INPLACE_EVIDENCE_ID);
  }
  for (const row of rows.filter(row => A_TRASH_OPERATIONS.includes(row.id))) {
    row.evidence.compatibilityA = "operator-attested-isolated-basic-success";
    row.evidence.effectCaseRefs.push(...aTrashEffectCases().filter(effect => effect.operations.includes(row.id)).map(effect => effect.id));
    row.requiredCase.coverage = "A-public-paired-trash-basic-qualified-native-installed-private-target-safety-unqualified";
  }
  for (const row of rows.filter(row => INSTALLED_SKILL_PAPER_TRASH_OPERATIONS.includes(row.id))) {
    row.evidence.installed = "reviewed-installed-public-unshared-skill-paper-v2-delete-restore-UI-receipts-stopped-B1-fresh-B0";
    row.evidence.effectCaseRefs.push(INSTALLED_SKILL_PAPER_TRASH_CASE_ID);
    row.evidence.reviewedEvidenceRefs.push(INSTALLED_SKILL_PAPER_TRASH_EVIDENCE_ID);
    row.requiredCase.coverage = "A-plus-installed-public-unshared-skill-paper-trash-v2-slice-full-acceptance-incomplete";
  }
  for (const row of rows.filter(row => INSTALLED_NOTE_PAPER_OPERATIONS.includes(row.id))) {
    row.evidence.installed = "reviewed-installed-public-note-paper-create-list-lexical-private-filter-stopped-B1-fresh-B0";
    row.evidence.effectCaseRefs.push(INSTALLED_NOTE_PAPER_CASE_ID);
    row.evidence.reviewedEvidenceRefs.push(INSTALLED_NOTE_PAPER_EVIDENCE_ID);
    row.requiredCase.coverage = "A-plus-installed-public-note-paper-create-list-lexical-full-acceptance-incomplete";
  }
  for (const row of rows.filter(row => RESEARCH_OPERATIONS.includes(row.id))) {
    row.evidence.installed = "reviewed-installed-research-read-list-offline-lexical-citation-graph-B1-fresh-B0";
    row.evidence.effectCaseRefs.push(INSTALLED_RESEARCH_CASE_ID);
    row.evidence.reviewedEvidenceRefs.push(INSTALLED_RESEARCH_EVIDENCE_ID);
    row.requiredCase.coverage = "installed-research-scoped-basic-read-lexical-graph-preservation-full-acceptance-incomplete";
  }
  for (const row of rows.filter(row => RECOVERY_OPERATIONS.includes(row.id))) {
    row.evidence.installed = "reviewed-installed-registered-public-note-0644-recovery-selected-Source-PUBLIC-repair-stopped-B1-fresh-B0";
    row.evidence.effectCaseRefs.push(INSTALLED_RECOVERY_CASE_ID);
    row.evidence.reviewedEvidenceRefs.push(INSTALLED_RECOVERY_EVIDENCE_ID);
    row.requiredCase.executionProfiles.push(INSTALLED_RECOVERY_PROFILE);
    row.requiredCase.coverage = "installed-registered-public-note-0644-recovery-basic-slice-full-original-recovery-unqualified";
  }
  for (const row of rows.filter(row => ACTION_PURE_OPERATIONS.includes(row.id))) {
    const complete = row.action === "action_templates";
    row.evidence.installed = complete
      ? "reviewed-installed-complete-nonempty-Original-template-catalogue-zeroReview-stopped-B1-fresh-B0"
      : "reviewed-installed-bounded-basic-component-graph-constant-typed-zeroReview-stopped-B1-fresh-B0";
    row.evidence.effectCaseRefs.push(INSTALLED_ACTION_PURE_CASE_ID);
    row.evidence.reviewedEvidenceRefs.push(INSTALLED_ACTION_PURE_EVIDENCE_ID);
    row.requiredCase.executionProfiles.push(INSTALLED_ACTION_PURE_PROFILE);
    row.requiredCase.coverage = complete
      ? "installed-complete-source-pure-template-catalogue-full-Action-unqualified"
      : "installed-bounded-basic-component-graph-only-private-Action-refs-and-full-runtime-unqualified";
  }
  return {
    schema: "pkm.original-operation-parity/v1",
    scope: "151 original business operations, not transport tools, aliases, supplemental canonical IDs or full native cutover",
    originalPin: { fixture: ORIGINAL, fixtureSha256: sha(read(root, ORIGINAL)), metadataSha256: ORIGINAL_METADATA_SHA256,
      revision: ORIGINAL_REVISION, producer: fixture.producer,
      retainedVsixSha256: "1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27",
      retainedVsixVerification: "operator-provided archive pin; this static test does not inspect or authenticate the archive" },
    classification: { module: "Explicit derived grouping; original metadata has no module/action properties.",
      action: "Exact original transportName, not an invented CRUD verb.",
      nativeImplementation: "partial = source success path exists under bounded independent admission, NOT full original parity; missing = no original dispatcher success path.",
      nativeDispatch: "implemented/refused describe inspected original dispatcher branches; conditional means an under-development source branch requiring its current independent port/context. None proves installed availability or successful execution.",
      availability: "Native writable/read-only values describe originalMcpNativeBrokerAvailability only; a separately composed full facade may differ.",
      evidence: "Source inspection, installed operator observations and production catalog visibility are separate from operation-specific effect-sequence proof.",
      coverage: "No inference from filenames, string literals, test counts, alias counts, registration, refusal-only tests or schema assertions." },
    refs: {
      "original-catalog": { level: "source", path: ORIGINAL, trust: "independently pinned metadata oracle; availability/schema only, not behavior" },
      "source-inspection": { level: "source", paths: ["src/original-mcp-public.ts", "src/original-mcp-broker.ts",
        "src/original-mcp-action-runtime.ts", "src/original-mcp-action-pure.ts", "src/original-mcp-api-chat.ts", "src/original-mcp-room-live-session.ts",
        "src/legacy-recipe-lazy-contracts.ts"], trust: "literal/source branch inspection only; static checks never prove effects" },
      "operator-installed-boundaries": { level: "installed", trust: "operator task context, not machine-verified per-operation receipts",
        candidateVsixSha256: "48927d48dcdb76509458bf41835391941c3c71395e0607cee9dbc82da0370be1",
        payloadSha256: "9ca9b1c963877b5583b3d16b6ec2ba3d7974b313f777277a90bf0cfab06de393",
        sourceSha256: "e8afd398e8647e850d302f1d308c5b455428a26a9c0df750ed78f9ceca8a2059",
        boundary: "Controlled Note/Skill/Paper creation/update/read and private moves/publication/recovery were reported. Bounded synthetic Models/TEXT Task, Action pure/Program, Todo assignment/Worker, Room loopback, Recipe NoOp, explicit Memory do not prove all original operations. Trash implementation pending separate owner.",
        exclusions: "No arbitrary Action/Cosmos/full Recipe/Room worker/Task files-images-history/general private source/provider keyring/shared root/full151; old 2bfc private-inplace failure is not treated as fixed evidence." },
      "operator-production-A": { level: "production", trust: "operator task context; no live queries/mutations or receipt inspection",
        version: ".27", businessOperations: 151, visibleTransportToolsIncludingAliases: 27,
        route: "selected A gateway + original business database, NOT native Core cutover",
        effectCoverage: "unverified; catalog visibility and stable production route do not prove 151 successful CRUD sequences" },
    },
    effectCaseConvention: {
      status: "registration is not a pass; separately reviewed hash-pinned reports may attest exact profile/stages only, not full acceptance or readiness",
      fields: ["id", "operations", "executionProfile", "test.file + test.name OR runner.file + runner.scenarioArgument",
        "stages", "oracle", "receipt", "preservation", "optional reviewedEvidenceRefs"],
      stages: "Each stage names canonical operation ID or null for restart/external fixture/preservation and an assertion reference.",
      oracle: "Independent original-contract/output/state assertion references; not test titles or step-contains matches.",
      receipt: "Exact effect/read receipt assertion reference, including failed/cancelled/unknown outcomes and no replay.",
      preservation: "Independent B1/B0 byte/hash assertions, omitted fields/assets/private sources and denied effects.",
      sourceFiles: "Optional reportedRun.sourceFiles pins the exact test plus explicitly imported supporting chains, not the whole runtime closure. Both extracted A fixtures require their test+helper pins; Script cases additionally pin their intermediate fixture. A helper change makes old attestations stale, never a new passing run.",
      coverageKind: "Default basic-operation-sequence; guarded-refusal, algorithm-positive, lifecycle-only and schema-compatibility-only are distinct evidence, never included in actual MCP basic-success counts. Explicit reviewed lifecycle/schema nonoperation cases carry zero original IDs.",
    },
    remainingGateConvention: {
      compatibilityA: "available-original-policy-not-native-qualification",
      nextGateStates: ["missing-original-implementation-branch", "source-without-installed-qualification",
        "incomplete-full-original-oracles"],
      scopedProof: "Reviewed installed normal/result/receipt/B1-B0 scope is not full-original acceptance. Evidence gaps and required workflow assertions remain explicit.",
      freshness: "Changed tests/support files remove their source attestations from qualified counts; neither source inspection nor hash-only refresh supplies a run.",
      workflow: "Each emitted gate retains its exact original operation/version/channel, required fixture/steps/checks and native blocker/source references. No aliases or supplemental IDs are added.",
      acceptanceBoundary: { fullReadiness: false, fullNativeParityReady: false, userRootStorageMigrated: false,
        productionRoute: "option-A-gateway-original-business-runtime-and-database" },
    },
    reviewedEvidence: { [INSTALLED_SKILL_EVIDENCE_ID]: installedSkillEvidence(),
      [INSTALLED_TRASH_EVIDENCE_ID]: installedTrashEvidence(), [INSTALLED_SCRIPT_EVIDENCE_ID]: installedScriptEvidence(),
      [INSTALLED_TODO_EVIDENCE_ID]: installedTodoEvidence(), [INSTALLED_INPLACE_EVIDENCE_ID]: installedInplaceEvidence(),
      [INSTALLED_SKILL_PAPER_TRASH_EVIDENCE_ID]: installedSkillPaperTrashEvidence(),
      [INSTALLED_NOTE_PAPER_EVIDENCE_ID]: installedNotePaperBasicEvidence(), [INSTALLED_RESEARCH_EVIDENCE_ID]: installedResearchEvidence(),
      [INSTALLED_RECOVERY_EVIDENCE_ID]: installedRecoveryEvidence(),
      [INSTALLED_ACTION_PURE_EVIDENCE_ID]: installedActionPureEvidence() },
    supplementalSourceCapabilities: facts.supplementalTrash.map(operation => ({
      id: operation, version: 1, readOnly: ["knowledge.trash.list", "knowledge.trash.lifecycle.preview"].includes(operation),
      originalBusinessOperation: false,
      sourceStatus: operation === "knowledge.trash.lifecycle.preview" ? "under-implementation-unverified"
        : "installed-fresh-public-note-stage-qualified-full-contract-unqualified",
      scope: "Canonical original-Trash Note-only port under fresh per-target approval/root custody; not reduced-broker original-operation exposure or full151 parity.",
      approvalBridgeMethod: "knowledge.trash.approve", approvalBridgeIsOriginalBusinessOperation: false,
      sourceRefs: ["src/original-mcp-public.ts#createOriginalMcpPublicDispatcher",
        "src/original-native-trash-contracts.ts", "src/original-native-trash-planning.ts", "src/original-native-trash-custody.ts"],
      effectEvidence: operation === "knowledge.trash.lifecycle.preview" ? "unverified-no-formal-accepted-lifecycle-or-installed-case"
        : "reviewed-installed-fresh-note-slice-stage-only",
      reviewedEvidenceRefs: operation === "knowledge.trash.lifecycle.preview" ? [] : [INSTALLED_TRASH_EVIDENCE_ID],
      coordinatorSourceStatus: "28/28 Source unit run reported, but exact per-operation test/receipt mapping is not supplied here; no installed Trash qualification or full readiness promotion.",
      requiredChecks: ["original-bucket-byte-custody", "exact-target-native-approval", "guarded-denial-expiry-cancel-no-effect",
        "canonical-move-restore-receipt", "restart-pending-intent-reconciliation-no-replay", "B1-B0-preservation"],
    })),
    effectCases: [skillEffectCase(), notePaperEffectCase(), sourceSkillEffectCase(), installedSkillEffectCase(),
      ...scriptEffectCases(), installedTrashEffectCase(), ...todoEffectCases(), heldSchemaEffectCase(),
      installedScriptEffectCase(), installedTodoEffectCase(), installedInplaceEffectCase(), ...aTrashEffectCases(),
      installedSkillPaperTrashEffectCase(), installedNotePaperBasicEffectCase(), installedResearchEffectCase(),
      installedRecoveryEffectCase(), installedActionPureEffectCase()],
    operations: rows,
  };
}

function validateMatrix(matrix, root = ROOT) {
  const expected = buildMatrix(root);
  validateSkillPaperTrashEvidence(matrix.reviewedEvidence[INSTALLED_SKILL_PAPER_TRASH_EVIDENCE_ID]);
  validateNotePaperBasicEvidence(matrix.reviewedEvidence[INSTALLED_NOTE_PAPER_EVIDENCE_ID]);
  validateResearchEvidence(matrix.reviewedEvidence[INSTALLED_RESEARCH_EVIDENCE_ID]);
  validateRecoveryEvidence(matrix.reviewedEvidence[INSTALLED_RECOVERY_EVIDENCE_ID]);
  validateActionPureEvidence(matrix.reviewedEvidence[INSTALLED_ACTION_PURE_EVIDENCE_ID]);
  const rows = matrix.operations;
  assert(Array.isArray(rows));
  assert.equal(rows.length, 151);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length, "Duplicate original operation mapping");
  assert.deepEqual(rows.map(row => row.id), expected.operations.map(row => row.id), "Missing/orphan/reordered original operation mapping");
  const core = structuredClone(matrix);
  core.effectCases = [];
  expected.effectCases = [];
  assert.deepEqual(core, expected, "Original contracts, requirements or source availability changed; explicitly review and regenerate parity");
  const known = new Set(rows.map(row => row.id)), caseIds = new Set();
  for (const effect of matrix.effectCases) {
    assert(!caseIds.has(effect.id), `Duplicate effect case ${effect.id}`);
    caseIds.add(effect.id);
    assert.equal(typeof effect.id, "string");
    assert(effect.id.length);
    const kind = effect.coverageKind || "basic-operation-sequence";
    assert(["basic-operation-sequence", "guarded-refusal", "algorithm-positive", "lifecycle-only", "schema-compatibility-only"].includes(kind),
      "Unknown effect coverage kind");
    const nonoperation = ["lifecycle-only", "schema-compatibility-only"].includes(kind);
    assert(Array.isArray(effect.operations) && (nonoperation ? effect.operations.length === 0 : effect.operations.length > 0));
    if (kind === "lifecycle-only")
      assert.equal(effect.id, SCRIPT_LIFECYCLE_CASE_ID, "Lifecycle-only registration requires its explicit reviewed zero-operation case");
    if (kind === "schema-compatibility-only")
      assert.equal(effect.id, HELD_SCHEMA_CASE_ID, "Schema-only registration requires its explicit actual held-parser evidence, not an orphan operation alias");
    assert.equal(new Set(effect.operations).size, effect.operations.length);
    for (const operation of effect.operations) assert(known.has(operation), `Orphan effect operation ${operation}`);
    for (const operation of effect.operations)
      assert(rows.find(row => row.id === operation).requiredCase.executionProfiles.includes(effect.executionProfile), "Unknown effect execution profile");
    assert(Boolean(effect.test) !== Boolean(effect.runner), "Choose exact test case OR installed scenario runner");
    if (effect.test) {
      assert(typeof effect.test.file === "string" && /^(?:tests\/|clients\/vscode-host\/)/.test(effect.test.file));
      assert(!effect.test.file.split("/").includes("..") && /\.test\.(?:mjs|cjs|js)$/.test(effect.test.file), "Effect case must select an executable test");
      assert(fs.existsSync(path.join(root, effect.test.file)), "Missing effect test");
      assert(typeof effect.test.name === "string" && effect.test.name.length, "Exact test name required");
      const tree = sourceTree(root, effect.test.file), testBindings = new Set();
      for (const statement of tree.statements) {
        if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== "node:test") continue;
        if (statement.importClause?.name) testBindings.add(statement.importClause.name.text);
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const binding of bindings.elements)
            if (["test", "it"].includes((binding.propertyName || binding.name).text)) testBindings.add(binding.name.text);
      }
      let declared = false;
      function find(node) {
        if (ts.isCallExpression(node) && testBindings.has(node.expression.getText(tree))
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === effect.test.name) declared = true;
        if (ts.isForOfStatement(node) && !node.awaitModifier && ts.isVariableDeclarationList(node.initializer)
          && (node.initializer.flags & ts.NodeFlags.Const) && node.initializer.declarations.length === 1
          && ts.isIdentifier(node.initializer.declarations[0].name)
          && ts.isArrayLiteralExpression(node.expression) && node.expression.elements.length <= 16
          && node.expression.elements.every(ts.isStringLiteral) && ts.isExpressionStatement(node.statement)) {
          const invocation = node.statement.expression, variable = node.initializer.declarations[0].name.text;
          if (ts.isCallExpression(invocation) && testBindings.has(invocation.expression.getText(tree))
            && invocation.arguments[0] && ts.isTemplateExpression(invocation.arguments[0])) {
            const template = invocation.arguments[0];
            if (template.templateSpans.every(span => ts.isIdentifier(span.expression) && span.expression.text === variable))
              declared ||= node.expression.elements.some(value =>
                template.head.text + template.templateSpans.map(span => value.text + span.literal.text).join("") === effect.test.name);
          }
        }
        ts.forEachChild(node, find);
      }
      find(tree);
      assert(declared, "Effect reference must name an exact declared node:test case (ESM literal or direct finite const string-loop template)");
    } else {
      const installed = [installedSkillEffectCase(), installedTrashEffectCase(), installedScriptEffectCase(),
        installedTodoEffectCase(), installedInplaceEffectCase(), installedSkillPaperTrashEffectCase(),
        installedNotePaperBasicEffectCase(), installedResearchEffectCase(), installedRecoveryEffectCase(),
        installedActionPureEffectCase()].find(expected => expected.id === effect.id);
      assert(installed, "New installed scenarios require explicit bounded evidence review");
      assert.deepEqual(effect.runner, installed.runner, "Installed runner registration changed; no inferred approval or fake flags");
      assert.equal(effect.executionProfile, installed.executionProfile);
      assert(fs.existsSync(path.join(root, effect.runner.file)), "Missing installed runner");
    }
    assert(Array.isArray(effect.stages) && effect.stages.length, "Asserted effect stages required");
    for (const stage of effect.stages) {
      assert(stage.operation === null || effect.operations.includes(stage.operation), "Stage operation not registered");
      assert(typeof stage.stage === "string" && stage.stage.length);
      assert(typeof stage.assertion === "string" && stage.assertion.length, "Stage assertion reference required");
      if (stage.supportingOperation) {
        assert(known.has(stage.supportingOperation), "Unknown supporting operation");
        assert.equal(stage.operation, null);
        assert.equal(stage.supportingCoverage, "guarded-refusal-only", "Support oracle is not positive operation coverage");
      }
      if (stage.nativeOperation)
        assert(matrix.supplementalSourceCapabilities.some(operation => operation.id === stage.nativeOperation),
          "Stage native operation must be a declared supplemental capability, never an invented original ID");
    }
    for (const key of ["oracle", "receipt", "preservation"])
      assert(typeof effect[key] === "string" && effect[key].length, `${key} assertion reference required`);
    assert(!("passed" in effect) && !("verified" in effect), "Registration is not behavioral proof");
    if (effect.reportedRun) {
      assert(["parent-coordinator task message", "parity-worker verified framework run"].includes(effect.reportedRun.reporter),
        "Reported run must identify its actual coordinator/verification origin");
      assert.equal(effect.reportedRun.outcome, "passed");
      assert(/^[a-f0-9]{64}$/.test(effect.reportedRun.fileSha256));
      assert.equal(effect.reportedRun.fileCasesSkipped, 0);
      assert(Array.isArray(effect.reportedRun.limitations) && effect.reportedRun.limitations.length);
      if (effect.reportedRun.reporter === "parity-worker verified framework run") {
        assert.equal(effect.id, SOURCE_SKILL_CASE_ID, "Local re-attestation must retain the actually rerun cold-source scope");
        assert.deepEqual(effect.reportedRun, sourceSkillEffectCase().reportedRun,
          "Local framework evidence must retain its exact verified whole-file result and pin");
      }
      const sources = effect.reportedRun.sourceFiles;
      if (effect.executionProfile === "compatibility-a-isolated")
        assert(Array.isArray(sources) && sources.some(source => source.file === "tests/compatibility-mcp-fixture.mjs"),
          "Extracted A fixture evidence requires its direct supporting helper pin");
      if (sources !== undefined) {
        assert(Array.isArray(sources) && sources.length, "Source support pins must be a nonempty list");
        assert.equal(new Set(sources.map(source => source.file)).size, sources.length, "Duplicate source support pin");
        for (const source of sources) {
          assert(typeof source.file === "string" && /^(?:tests\/|clients\/vscode-host\/)/.test(source.file)
            && !source.file.split("/").includes(".."), "Source support pin must stay in approved test source paths");
          assert(/^[a-f0-9]{64}$/.test(source.sha256), "Source support digest required");
        }
        assert(sources.some(source => source.file === effect.test.file
          && source.sha256 === effect.reportedRun.fileSha256), "Source pins must include the matching exact test digest");
        const included = new Set(sources.map(source => source.file));
        const reachable = new Set([effect.test.file]), pending = [effect.test.file];
        while (pending.length) {
          const file = pending.shift();
          for (const statement of sourceTree(root, file).statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
              || !statement.moduleSpecifier.text.startsWith(".")) continue;
            const child = path.posix.normalize(path.posix.join(path.posix.dirname(file), statement.moduleSpecifier.text));
            if (included.has(child) && !reachable.has(child)) { reachable.add(child); pending.push(child); }
          }
        }
        for (const source of sources) assert(reachable.has(source.file), "Support pin requires an explicit included import chain from the test");
      }
    }
    for (const ref of effect.reviewedEvidenceRefs || []) {
      const evidence = matrix.reviewedEvidence[ref];
      assert(evidence, `Unknown reviewed evidence reference ${ref}`);
      assert.equal(effect.executionProfile, evidence.executionProfile, "Evidence execution profile mismatch");
      assert.deepEqual([...effect.operations].sort(), [...evidence.operations].sort(), "Evidence cannot cover unrelated original operations");
    }
    if (effect.id === INSTALLED_SKILL_CASE_ID)
      assert.deepEqual(effect, installedSkillEffectCase(), "Accepted installed scenario must retain its exact reviewed stage/receipt/preservation scope");
    if (effect.id === INSTALLED_TRASH_CASE_ID)
      assert.deepEqual(effect, installedTrashEffectCase(), "Installed Trash evidence must retain its exact delete_note-only scope and qualified/unqualified boundaries");
    if (effect.id === INSTALLED_SCRIPT_CASE_ID)
      assert.deepEqual(effect, installedScriptEffectCase(), "Installed Script evidence must retain frozen initial get/search/private/B1-image scope without write, v1 serving or recapture claims");
    if (effect.id === INSTALLED_TODO_CASE_ID)
      assert.deepEqual(effect, installedTodoEffectCase(), "Installed Todo evidence must retain exact first-Board namespace/Planning scope, not all34/reviewer/worker/source-renewal authority");
    if (effect.id === INSTALLED_INPLACE_CASE_ID)
      assert.deepEqual(effect, installedInplaceEffectCase(), "Installed in-place evidence must retain exactly four existing-resource update/immediate-read IDs, not add/list/search, restart or full-root qualification");
    if (effect.id === INSTALLED_SKILL_PAPER_TRASH_CASE_ID)
      assert.deepEqual(effect, installedSkillPaperTrashEffectCase(), "Installed Skill/Paper v2 must retain its exact two public unshared delete IDs and supplemental/schema/image-only boundaries");
    if (effect.id === INSTALLED_NOTE_PAPER_CASE_ID)
      assert.deepEqual(effect, installedNotePaperBasicEffectCase(), "Installed Note/Paper basic must retain exact six create/list/search IDs, Original semantics/privacy and separate receipt/image scope without old get/update reassignment");
    if (effect.id === INSTALLED_RESEARCH_CASE_ID)
      assert.deepEqual(effect, installedResearchEffectCase(), "Installed Research must retain exact four original reads/graph, public authority, sealed oracle and independent preservation scope without invented A/model acceptance");
    if (effect.id === INSTALLED_RECOVERY_CASE_ID)
      assert.deepEqual(effect, installedRecoveryEffectCase(), "Installed Recovery must retain the exact two-ID registered PUBLIC Note/0644 slice, native picker/grants/receipts and independent stopped-B1/fresh-B0 boundaries; not full arbitrary-file Recovery or A transport proof");
    if (effect.id === INSTALLED_ACTION_PURE_CASE_ID)
      assert.deepEqual(effect, installedActionPureEffectCase(), "Installed Action must retain complete templates and bounded graph only; no invalid-definition, refusal-only, private-reference, full-runtime or fairness48 borrowing");
    const scriptCase = scriptEffectCases().find(expected => expected.id === effect.id);
    if (scriptCase)
      assert.deepEqual(effect, scriptCase, "Script refusal/algorithm evidence cannot be promoted to MCP basic or native/installed coverage");
    const todoCase = todoEffectCases().find(expected => expected.id === effect.id);
    if (todoCase)
      assert.deepEqual(effect, todoCase, "Todo original/A scope must not be promoted to native Worker/reviewer grants or refusal-only positive coverage");
    const aTrashCase = aTrashEffectCases().find(expected => expected.id === effect.id);
    if (aTrashCase)
      assert.deepEqual(effect, aTrashCase, "Original/A Trash positives must retain exact public-pair/expected-SHA scope, not private-target safety, native/installed or public restore/list coverage");
    if (effect.id === HELD_SCHEMA_CASE_ID)
      assert.deepEqual(effect, heldSchemaEffectCase(), "Held schema evidence cannot be promoted to original operations, old/current Owner, native installed or v1 serving qualification");
  }
  const registered = new Set(matrix.effectCases.map(effect => effect.id));
  for (const row of rows) for (const ref of row.evidence.effectCaseRefs)
    assert(registered.has(ref), `Missing registered effect case ${ref}`);
  for (const row of rows) for (const ref of row.evidence.reviewedEvidenceRefs)
    assert(matrix.reviewedEvidence[ref]?.operations.includes(row.id), `Invalid reviewed operation evidence ${ref}`);
  for (const row of rows) for (const ref of row.evidence.guardedEvidenceRefs || [])
    assert(matrix.effectCases.find(effect => effect.id === ref)?.stages.some(stage =>
      stage.supportingOperation === row.id && stage.supportingCoverage === "guarded-refusal-only"),
    `Missing exact guarded operation evidence ${ref}`);
  const digests = new Map();
  const sourceDigest = file => {
    if (!digests.has(file)) digests.set(file, sha(read(root, file)));
    return digests.get(file);
  };
  const staleAttestations = matrix.effectCases.filter(effect => effect.reportedRun).map(effect => ({
    caseId: effect.id, executionProfile: effect.executionProfile, testFile: effect.test.file,
    changedFiles: (effect.reportedRun.sourceFiles || [{ file: effect.test.file, sha256: effect.reportedRun.fileSha256 }])
      .map(source => ({ file: source.file, expectedSha256: source.sha256, actualSha256: sourceDigest(source.file),
        reason: source.file === effect.test.file ? "test-file-content-changed" : "supporting-file-content-changed" }))
      .filter(source => source.expectedSha256 !== source.actualSha256),
  })).filter(effect => effect.changedFiles.length);
  const staleIds = new Set(staleAttestations.map(effect => effect.caseId));
  const attested = matrix.effectCases.filter(effect => effect.reportedRun && !staleIds.has(effect.id));
  const basic = matrix.effectCases.filter(effect => (effect.coverageKind || "basic-operation-sequence") === "basic-operation-sequence");
  const basicAttested = attested.filter(effect => (effect.coverageKind || "basic-operation-sequence") === "basic-operation-sequence");
  const nonBasic = matrix.effectCases.filter(effect => (effect.coverageKind || "basic-operation-sequence") !== "basic-operation-sequence");
  const remainingOperationGates = rows.map(row => {
    const evidence = row.evidence.reviewedEvidenceRefs.map(ref => ({ ref, ...matrix.reviewedEvidence[ref] }));
    const installed = evidence.filter(value => value.level === "installed");
    const scoped = installed.length > 0;
    return {
      operation: row.id, version: row.version, channel: row.compatibilityA.channel,
      compatibilityA: matrix.remainingGateConvention.compatibilityA,
      nextGate: row.native.implementation === "missing" ? "missing-original-implementation-branch"
        : !scoped ? "source-without-installed-qualification" : "incomplete-full-original-oracles",
      nativeDispatch: row.native.dispatch, nativeSourceRefs: row.native.sourceRefs,
      nativeBlocker: { code: row.native.blockerCode, reason: row.native.reason,
        fullOriginalReadiness: row.native.fullOriginalReadiness },
      installedQualification: { state: scoped ? "reviewed-scoped-not-full-original" : "unqualified",
        evidenceRefs: installed.map(value => value.ref),
        remainingGaps: installed.flatMap(value => value.remainingGaps) },
      sourceAttestations: { currentCaseRefs: basicAttested.filter(effect => effect.operations.includes(row.id)).map(effect => effect.id),
        staleCaseRefs: staleAttestations.filter(effect => row.evidence.effectCaseRefs.includes(effect.caseId)).map(effect => effect.caseId) },
      oracles: {
        normal: scoped ? "reviewed-installed-scoped-result-only" : "exact-installed-original-result-required",
        authority: "full-original-denial-expiry-cancellation-oracle-incomplete",
        fault: "full-original-no-late-or-unknown-effect-oracle-incomplete",
        restart: "full-original-same-root-no-replay-oracle-incomplete",
        preservation: scoped ? "reviewed-installed-scoped-B1-B0-only" : "exact-installed-receipt-read-and-B1-B0-required",
      },
      requiredWorkflow: { caseId: row.requiredCase.id, fixture: row.requiredCase.fixture,
        steps: row.requiredCase.steps, requiredChecks: row.requiredCase.requiredChecks },
    };
  });
  return {
    schema: "pkm.original-operation-parity-check/v1", staticOnly: true, originalOperations: rows.length,
    aliasesCountedAsOperations: 0,
    nativeGateImplemented: rows.filter(row => row.native.fullOriginalReadiness === "implemented").length,
    nativeWritableEnabled: rows.filter(row => row.native.nativeDogfoodWritable === "enabled").length,
    nativeWritableConditional: rows.filter(row => row.native.nativeDogfoodWritable === "conditional").length,
    nativeWritableDisabled: rows.filter(row => row.native.nativeDogfoodWritable === "disabled").length,
    sourceSuccessPaths: rows.filter(row => row.native.dispatch === "implemented").length,
    conditionalSourceBranches: rows.filter(row => row.native.dispatch === "conditional").length,
    originalSuccessPathsMissing: rows.filter(row => row.native.implementation === "missing").length,
    registeredEffectCases: matrix.effectCases.length,
    distinctOriginalOperationsWithRegisteredBasicCases: new Set(basic.flatMap(effect => effect.operations)).size,
    originalOperationsWithoutRegisteredBasicCase: rows.length - new Set(basic.flatMap(effect => effect.operations)).size,
    operatorAttestedBasicOperations: new Set(basicAttested.flatMap(effect => effect.operations)).size,
    qualifiedBasicOriginalOperations: new Set([...basicAttested.flatMap(effect => effect.operations),
      ...Object.values(matrix.reviewedEvidence).filter(evidence => evidence.level === "installed").flatMap(evidence => evidence.operations)]).size,
    operatorAttestedCasesByProfile: Object.fromEntries([...new Set(basicAttested.map(effect => effect.executionProfile))]
      .map(profile => [profile, basicAttested.filter(effect => effect.executionProfile === profile).length])),
    registeredNonBasicCases: nonBasic.length,
    distinctOriginalOperationsWithNonBasicCases: new Set(nonBasic.flatMap(effect => effect.operations)).size,
    distinctOriginalOperationsWithRegisteredEvidence: new Set(matrix.effectCases.flatMap(effect => effect.operations)).size,
    operatorAttestedRefusalCases: attested.filter(effect => effect.coverageKind === "guarded-refusal").length,
    operatorAttestedAlgorithmCases: attested.filter(effect => effect.coverageKind === "algorithm-positive").length,
    operatorAttestedLifecycleCases: attested.filter(effect => effect.coverageKind === "lifecycle-only").length,
    operatorAttestedSchemaCompatibilityCases: attested.filter(effect => effect.coverageKind === "schema-compatibility-only").length,
    reviewedInstalledBasicScenarios: Object.values(matrix.reviewedEvidence).filter(evidence => evidence.level === "installed").length,
    reviewedInstalledBasicOperations: new Set(Object.values(matrix.reviewedEvidence)
      .filter(evidence => evidence.level === "installed").flatMap(evidence => evidence.operations)).size,
    externalEvidenceFilesOpenedByChecker: 0,
    staleOperatorAttestedCases: staleAttestations.length,
    staleAttestations,
    remainingGatesByNextState: Object.fromEntries(matrix.remainingGateConvention.nextGateStates
      .map(state => [state, remainingOperationGates.filter(gate => gate.nextGate === state).length])),
    remainingGatesByModule: Object.fromEntries([...new Set(rows.map(row => row.module))].map(module => {
      const ids = new Set(rows.filter(row => row.module === module).map(row => row.id));
      const gates = remainingOperationGates.filter(gate => ids.has(gate.operation));
      return [module, {
        missingAdapter: gates.filter(gate => gate.nextGate === "missing-original-implementation-branch").length,
        sourceOnly: gates.filter(gate => gate.nextGate === "source-without-installed-qualification").length,
        installedScoped: gates.filter(gate => gate.nextGate === "incomplete-full-original-oracles").length,
      }];
    })),
    remainingOperationGates,
    verifiedEffectSequences: 0,
    unverifiedOriginalOperations: rows.length,
    fullNativeParityReady: false,
    fullReadiness: false,
    userRootStorageMigrated: false,
  };
}

module.exports = { ROOT, MATRIX, originalContracts, sourceFacts, buildMatrix, validateMatrix };

if (require.main === module) {
  const flag = process.argv[2];
  assert.equal(process.argv.length, 3, "Use --check or --write (explicit review/regeneration only)");
  assert(["--check", "--write"].includes(flag));
  if (flag === "--write") {
    const matrix = buildMatrix();
    if (fs.existsSync(path.join(ROOT, MATRIX))) {
      const retained = JSON.parse(read(ROOT, MATRIX)).effectCases;
      const reviewed = new Map(matrix.effectCases.map(effect => [effect.id, effect]));
      matrix.effectCases = [...retained.map(effect => reviewed.get(effect.id) || effect),
        ...matrix.effectCases.filter(effect => !retained.some(old => old.id === effect.id))];
    }
    validateMatrix(matrix);
    fs.writeFileSync(path.join(ROOT, MATRIX), JSON.stringify(matrix, null, 2) + "\n");
  }
  console.log(JSON.stringify(validateMatrix(JSON.parse(read(ROOT, MATRIX))), null, 2));
}
