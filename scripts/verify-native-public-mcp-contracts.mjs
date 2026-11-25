import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const artifactPath = "src/native-public-mcp-contracts.ts";
export const nativePublicMcpContractSources = Object.freeze([
  "compat/legacy-compact-mcp.py",
  "compat/legacy-knowledge-mcp.py",
  "compat/legacy-knowledge-captured.py",
  "compat/legacy-recipe-run-read.py",
  "legacy/resources/capability_api.py",
  "legacy/resources/todo_api.py",
  "scripts/export-native-public-mcp-contracts.py",
  "scripts/verify-native-public-mcp-contracts.mjs",
]);
const coreNames = [
  "capabilities_describe", "capabilities_inventory", "capabilities_list", "capabilities_search",
  "capability_call", "capability_read", "check_version", "mcp_lifecycle_quiesce", "mcp_lifecycle_status",
];
const profileNames = ["000", "100", "101", "110", "111"];
const instruction = "Run python scripts/export-native-public-mcp-contracts.py to regenerate the checked catalog; never refresh hashes manually.";
const fail = message => { throw new Error(`Native public MCP catalog: ${message}. ${instruction}`); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = value => createHash("sha256").update(value).digest("hex");
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value, names) => object(value) && Object.keys(value).length === names.length
  && names.every(name => Object.hasOwn(value, name));
const uniqueStrings = value => Array.isArray(value) && value.every(item => typeof item === "string")
  && new Set(value).size === value.length;

function readRegular(root, path) {
  const absolute = resolve(root, path), within = relative(root, absolute);
  if (!within || within.startsWith(`..${sep}`) || within === ".." || resolve(root, within) !== absolute)
    fail(`source path escapes the checkout: ${path}`);
  const parts = within.split(sep);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info || info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()))
      fail(`expected an existing regular checkout file without symlink ancestors: ${path}`);
  }
  const descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) fail(`invalid or oversized source file: ${path}`);
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}

function checked(work) {
  try { return work(); }
  catch (error) {
    if (error instanceof Error && error.message.includes(instruction)) throw error;
    fail(error instanceof Error ? error.message : "invalid checked catalog");
  }
}

export function collectNativePublicMcpContractSourcePins(root = packageRoot) {
  return checked(() => {
    const canonical = realpathSync(root);
    return Object.fromEntries(nativePublicMcpContractSources.map(path => [path, digest(readRegular(canonical, path))]));
  });
}

function parseArtifact(source) {
  const tree = ts.createSourceFile(artifactPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (tree.parseDiagnostics.length || tree.statements.length !== 2)
    fail("generated TypeScript must contain only its literal catalog declaration and default export");
  const [declaration, exported] = tree.statements;
  if (!ts.isVariableStatement(declaration) || declaration.modifiers?.length
    || declaration.declarationList.flags !== ts.NodeFlags.Const || declaration.declarationList.declarations.length !== 1)
    fail("unsupported generated catalog declaration");
  const variable = declaration.declarationList.declarations[0], expression = variable.initializer;
  if (!ts.isIdentifier(variable.name) || variable.name.text !== "contracts"
    || variable.type?.kind !== ts.SyntaxKind.UnknownKeyword || variable.exclamationToken
    || !expression || !ts.isCallExpression(expression) || expression.questionDotToken || expression.typeArguments?.length
    || !ts.isPropertyAccessExpression(expression.expression) || expression.expression.questionDotToken
    || !ts.isIdentifier(expression.expression.expression) || expression.expression.expression.text !== "JSON"
    || expression.expression.name.text !== "parse" || expression.arguments.length !== 1
    || !ts.isStringLiteral(expression.arguments[0])
    || !ts.isExportAssignment(exported) || exported.isExportEquals
    || !ts.isIdentifier(exported.expression) || exported.expression.text !== "contracts")
    fail("catalog must be JSON.parse of one string literal, never executable TypeScript");
  return JSON.parse(expression.arguments[0].text);
}

function validateCatalog(catalog) {
  if (!exactKeys(catalog, ["schema", "sourcePins", "variants", "definitions", "wireDefinitions", "contracts",
    "routing", "floatPaths", "contractBytes"]) || catalog.schema !== "pkm.native-public-mcp-contracts/v1")
    fail("unsupported catalog schema");
  if (!exactKeys(catalog.sourcePins, nativePublicMcpContractSources)
    || !Object.values(catalog.sourcePins).every(hash))
    fail("sourcePins must contain exactly the approved relative defining-source paths and SHA-256 hashes");
  if (!exactKeys(catalog.variants, profileNames)) fail("unsupported immutable catalog profiles");
  for (const definitions of [catalog.definitions, catalog.wireDefinitions]) {
    if (!Array.isArray(definitions) || definitions.length !== coreNames.length
      || !definitions.every(definition => object(definition) && coreNames.includes(definition.name))
      || new Set(definitions.map(definition => definition.name)).size !== coreNames.length)
      fail("expected exactly the nine public tool definitions");
    for (const definition of definitions) {
      if (!object(definition.inputSchema) || definition.inputSchema.type !== "object"
        || !object(definition.inputSchema.properties))
        fail(`invalid public inputSchema: ${definition.name}`);
    }
  }
  if (!Array.isArray(catalog.contracts) || !catalog.contracts.length) fail("missing leaf contracts");
  const names = new Set(), ids = new Set();
  for (const contract of catalog.contracts) {
    if (!exactKeys(contract, ["id", "version", "transportName", "description", "inputSchema", "outputSchema",
      "readOnly", "authorization", "result", "lifecycle"])
      || typeof contract.transportName !== "string" || !/^[a-z][a-z0-9_]*$/.test(contract.transportName)
      || contract.id !== `mcp.tool.${contract.transportName}` || contract.version !== 1
      || coreNames.includes(contract.transportName) || names.has(contract.transportName)
      || typeof contract.readOnly !== "boolean" || typeof contract.description !== "string"
      || typeof contract.authorization !== "string" || typeof contract.result !== "string"
      || !object(contract.inputSchema) || contract.inputSchema.type !== "object" || !object(contract.inputSchema.properties)
      || contract.outputSchema !== null && !object(contract.outputSchema)
      || !exactKeys(contract.lifecycle, ["legacyAlias"]) || contract.lifecycle.legacyAlias !== contract.transportName)
      fail("invalid leaf contract or inputSchema");
    names.add(contract.transportName); ids.add(contract.id);
  }
  for (const [profile, variant] of Object.entries(catalog.variants)) {
    if (!exactKeys(variant, ["names", "revision"]) || !hash(variant.revision) || !uniqueStrings(variant.names)
      || !variant.names.length || variant.names.some(name => !names.has(name)))
      fail(`invalid catalog profile: ${profile}`);
  }
  if (catalog.variants["111"].names.length !== names.size
    || !exactKeys(catalog.contractBytes, [...ids])
    || !Object.values(catalog.contractBytes).every(value => Number.isSafeInteger(value) && value > 0)
    || !object(catalog.routing) || Object.keys(catalog.routing).some(name => !names.has(name))
    || !Array.isArray(catalog.floatPaths))
    fail("invalid catalog routing or byte metadata");
  for (const path of catalog.floatPaths) {
    if (!Array.isArray(path) || path.length < 2 || !ids.has(path[0])
      || path.slice(1).some(key => typeof key !== "string" && !Number.isSafeInteger(key))
      || path.slice(1).some(key => ["__proto__", "prototype", "constructor"].includes(key)))
      fail("invalid float metadata path");
    let value = catalog.contracts.find(contract => contract.id === path[0]);
    for (const key of path.slice(1)) {
      if (!object(value) && !Array.isArray(value) || !Object.hasOwn(value, key)) fail("missing float metadata path");
      value = value[key];
    }
    if (typeof value !== "number" || !Number.isFinite(value)) fail("invalid float metadata value");
  }
}

export function verifyNativePublicMcpContracts(root = packageRoot) {
  return checked(() => {
    const canonical = realpathSync(root), catalog = parseArtifact(readRegular(canonical, artifactPath).toString("utf8"));
    validateCatalog(catalog);
    const current = collectNativePublicMcpContractSourcePins(canonical);
    for (const source of nativePublicMcpContractSources)
      if (catalog.sourcePins[source] !== current[source]) fail(`stale defining source: ${source}`);
    return { schema: "pkm.native-public-mcp-contract-pins/v1", sourceFiles: nativePublicMcpContractSources.length,
      profiles: profileNames.length, operations: catalog.contracts.length };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.length === 1 && args[0] !== "--source-pins")
      fail("usage: node scripts/verify-native-public-mcp-contracts.mjs [--source-pins]");
    console.log(JSON.stringify(args[0] === "--source-pins"
      ? collectNativePublicMcpContractSourcePins() : verifyNativePublicMcpContracts()));
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
