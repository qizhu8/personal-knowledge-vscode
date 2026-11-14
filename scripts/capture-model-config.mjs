import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "legacy");
const hash = value => createHash("sha256").update(value, "utf8").digest("hex");

async function source(path) {
  const text = await readFile(resolve(repoRoot, path), "utf8");
  return { path, text, sha256: hash(text) };
}

function captureFunction(file, name) {
  const pattern = new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m");
  const match = pattern.exec(file.text);
  if (!match) throw new Error(`Original model configuration function not found: ${file.path}#${name}`);
  const remainder = file.text.slice(match.index + match[0].length);
  const next = /^(?:export )?(?:async )?(?:interface|type|function|const|let|class)\b/m.exec(remainder);
  const end = next ? match.index + match[0].length + next.index : file.text.length;
  return declaration(file, name, match.index, end);
}

function captureMethod(file, name) {
  const pattern = new RegExp(`^  private (?:async )?${name}\\b`, "m");
  const match = pattern.exec(file.text);
  if (!match) throw new Error(`Original model configuration method not found: ${file.path}#${name}`);
  const remainder = file.text.slice(match.index + match[0].length);
  const next = /^  (?:private|public|protected)\s+(?:async\s+)?[A-Za-z_$][\w$]*\s*\(/m.exec(remainder);
  const end = next ? match.index + match[0].length + next.index : file.text.length;
  return declaration(file, name, match.index, end);
}

function declaration(file, name, start, end) {
  const text = file.text.slice(start, end).trimEnd() + "\n";
  const startLine = file.text.slice(0, start).split("\n").length;
  return {
    source: file.path,
    name,
    startLine,
    endLine: startLine + text.split("\n").length - 2,
    sha256: hash(text),
    text,
  };
}

function captureModelProfileTests(file) {
  const start = file.text.indexOf("const profiles = modelProfiles(");
  const stop = start < 0 ? -1 : file.text.indexOf("const directory =", start);
  if (start < 0 || stop < 0) throw new Error("Original model profile/token budget tests were not found.");
  return declaration(file, "model-profile-and-token-budget-tests", start, stop);
}

function manifestModelSettings(manifest) {
  const properties = manifest.contributes?.configuration?.properties;
  if (!properties) throw new Error("Original extension model configuration schema is missing.");
  const settingNames = [
    "personalKnowledge.apiChatProvider",
    "personalKnowledge.apiChatModels",
    "personalKnowledge.apiChatModelProfiles",
    "personalKnowledge.aiModel",
    "personalKnowledge.aiEndpoint",
    "personalKnowledge.aiAzureApiVersion",
  ];
  const settings = {};
  for (const name of settingNames) {
    const entry = properties[name];
    if (!entry) throw new Error(`Original extension setting is missing: ${name}`);
    settings[name] = {
      type: entry.type,
      ...(entry.enum ? { enum: entry.enum } : {}),
      ...(entry.default !== undefined ? { default: entry.default } : {}),
      ...(entry.minimum !== undefined ? { minimum: entry.minimum } : {}),
      ...(entry.properties ? { properties: Object.keys(entry.properties).sort() } : {}),
      ...(entry.items?.required ? { profileRequired: entry.items.required } : {}),
      ...(entry.items?.additionalProperties !== undefined ? { additionalProperties: entry.items.additionalProperties } : {}),
      ...(entry.items?.properties ? { profileProperties: Object.keys(entry.items.properties).sort() } : {}),
    };
  }
  return settings;
}

const modelSource = await source("src/chat/api-chat-models.ts");
const viewSource = await source("src/chat/api-chat-view.ts");
const vscodeSource = await source("src/chat/api-chat-vscode.ts");
const manifestSource = await source("package.json");
const originalModelTests = await source("tests/test-api-chat.js");
const originalPickerTests = await source("tests/test-chat-model-picker.js");
const manifest = JSON.parse(manifestSource.text);
const reviewedPackageChange = {
  previousSha256: "ce001d5c01699d5dfaeaf75498e677b55c670e9b9f2c917536a5578e2ce04540",
  currentSha256: "381e8b3b7313a6c37775fa05704d257379bd6aa68c287837bde9070045d58698",
  suffix: " && python -B tests/test-api-chat-ui.py ChatUiTests.test_remote_link_loss_preserves_draft_and_recovers_without_replay",
  scripts: ["test:chat-faults:run", "test:pkm-chat:daily:run"],
};
if (manifestSource.sha256 !== reviewedPackageChange.currentSha256) {
  throw new Error("Original package.json differs from the independently reviewed source; a new review is required.");
}
let previousPackageText = manifestSource.text;
const reviewedScripts = reviewedPackageChange.scripts.map(name => {
  const after = manifest.scripts?.[name];
  if (typeof after !== "string" || !after.endsWith(reviewedPackageChange.suffix)) {
    throw new Error(`Reviewed package script does not match: ${name}`);
  }
  const before = after.slice(0, -reviewedPackageChange.suffix.length);
  const afterLine = `    ${JSON.stringify(name)}: ${JSON.stringify(after)}`;
  const beforeLine = `    ${JSON.stringify(name)}: ${JSON.stringify(before)}`;
  if (previousPackageText.split(afterLine).length !== 2) throw new Error(`Ambiguous reviewed script: ${name}`);
  previousPackageText = previousPackageText.replace(afterLine, beforeLine);
  return { name, before, after };
});
if (hash(previousPackageText) !== reviewedPackageChange.previousSha256) {
  throw new Error("Reviewed package changes do not reconstruct the previous original bytes.");
}
const declarations = [
  ...["modelProfiles", "assertModelAvailable", "estimateInputTokens", "validateBudget", "estimateCost"]
    .map(name => captureFunction(modelSource, name)),
  ...["defaultModel", "createChat", "settings", "readApiKey"].map(name => captureMethod(viewSource, name)),
  ...["vscodeModelProfile", "discoverVscodeModels"].map(name => captureFunction(vscodeSource, name)),
  captureModelProfileTests(originalModelTests),
];

const capturedPaths = [
  "src/model-config-contracts.ts",
  "src/model-config.ts",
  "src/domain/model-config.ts",
  "tests/model-config.test.mjs",
];
const capturedFiles = [];
for (const path of capturedPaths) {
  const text = await readFile(resolve(packageRoot, path), "utf8");
  capturedFiles.push({ path, sha256: hash(text) });
}

const sourceFiles = [modelSource, viewSource, vscodeSource, manifestSource, originalModelTests, originalPickerTests]
  .map(file => ({ path: file.path, sha256: file.sha256 }));
const capturedForSource = new Map([
  [modelSource.path, "src/domain/model-config.ts"],
  [viewSource.path, "src/model-config.ts"],
  [vscodeSource.path, "src/model-config-contracts.ts"],
  [manifestSource.path, "src/model-config-contracts.ts"],
  [originalModelTests.path, "tests/model-config.test.mjs"],
  [originalPickerTests.path, "tests/model-config.test.mjs"],
]);
const capturedByPath = new Map(capturedFiles.map(file => [file.path, file.sha256]));

const provenance = {
  schema: "pkm.model-config-provenance/v1",
  reviewedSourceHistory: [{
    path: "package.json",
    previousSha256: reviewedPackageChange.previousSha256,
    currentSha256: reviewedPackageChange.currentSha256,
    scope: "User-approved review and recapture: only the two exact test-script appends below; model configuration and dependencies unchanged.",
    scripts: reviewedScripts,
  }],
  files: sourceFiles.map(file => ({
    source: file.path,
    sourceSha256: file.sha256,
    captured: capturedForSource.get(file.path),
    capturedSha256: capturedByPath.get(capturedForSource.get(file.path)),
  })),
  sourceFiles,
  capturedFiles,
  source: {
    declarations,
    settings: manifestModelSettings(manifest),
    configMerge: [
      "Provider is the conversation provider when present; for a new conversation it inherits a valid saved apiChat.defaultModel provider first, otherwise personalKnowledge.apiChatProvider (default openai-compatible).",
      "Configured profiles retain order; a remembered profile participates only when its saved provider and id match the conversation selection, and is appended only when its id is absent.",
      "Legacy ids are considered in order: personalKnowledge.aiModel (default gpt-4o-mini), apiChatModels, then the conversation profile id; known configured profiles win by id.",
      "Original selection guards reject a model if any configured alias sharing its model/deployment string is deprecated.",
      "An unlisted HTTP model id becomes status unknown with a conservative 4096 context / 1024 output-token profile; this is not evidence that the remote model exists.",
      "The HTTP API credential is read natively from SecretStorage key personalKnowledge.aiApiKey; the isolated adapter only consumes an injected opaque handle and never retrieves or returns a value.",
      "Azure uses aiAzureApiVersion (default 2024-06-01); endpoints and API versions are never included in public output.",
    ],
    providerMetadata: {
      vscode: [
        "Original profile id is vscode:<encoded vendor>:<encoded model id>; label is model name plus vendor.",
        "Context window comes from maxInputTokens; output tokens are min(positive maxOutputTokens or 4096, floor(maxInputTokens / 4)).",
        "Native imageInput is true only when the provider reports that capability.",
        "The isolated server does not discover VS Code or Copilot SDK models; it reports discovery unsupported and returns no synthetic native model.",
      ],
      http: "Configured API profile metadata comes from apiChatModelProfiles; API model id/deployment entries not present there retain the legacy unknown 4096/1024 profile.",
    },
    tokenAccounting: {
      verifiedFormula: "API model estimate starts at 32; for each message add UTF-8 bytes of content plus JSON.stringify(tool_calls) when present, then add 32.",
      supportedBy: "src/chat/api-chat-models.ts#estimateInputTokens and tests/test-api-chat.js model-profile/token-budget assertions.",
      excluded: "VS Code model token counts use the native model tokenizer when available and are intentionally not emulated by this host-neutral adapter.",
    },
    integration: {
      constructor: "new ModelConfigService({ configuration, secretResolver, registryAvailability, now? })",
      configuration: "Explicit allowlisted personalKnowledge settings plus optional rememberedModel snapshot; no process.env or host configuration reads.",
      secretResolver: "resolveSecret('personalKnowledge.aiApiKey') returns an opaque object handle or undefined; raw strings are rejected as credentials.",
      registryAvailability: "Parent-injected provider registry booleans; false means provider-unavailable. VS Code model discovery remains unsupported regardless.",
      definitions: "Import modelConfigDefinitions from src/model-config.ts and register its two read-only model.config.catalog/model.config.resolve schemas.",
      transport: "No HTTP client, model transport, or network request is injected or invoked. Tests use metadata-only registry booleans and inert opaque-secret fixtures; real model/transport fixtures are intentionally excluded.",
    },
  },
};

const outputPath = resolve(packageRoot, "migration/model-config-provenance.json");
const output = JSON.stringify(provenance, null, 2) + "\n";
const previous = JSON.parse(await readFile(outputPath, "utf8"));
if (JSON.stringify(previous.source.settings) !== JSON.stringify(provenance.source.settings)
  || JSON.stringify(previous.capturedFiles) !== JSON.stringify(provenance.capturedFiles)) {
  throw new Error("Previously captured model settings or adapter bytes changed; review is required.");
}
if (process.argv.includes("--check")) {
  let existing;
  try { existing = await readFile(outputPath, "utf8"); }
  catch { throw new Error("Model configuration provenance is missing; run capture-model-config.mjs."); }
  if (existing !== output) throw new Error("Model configuration provenance is stale; run capture-model-config.mjs.");
  console.log("Model configuration provenance is current.");
} else {
  await writeFile(outputPath, output);
  console.log(`Captured ${declarations.length} original declarations and ${capturedFiles.length} adapter files.`);
}
