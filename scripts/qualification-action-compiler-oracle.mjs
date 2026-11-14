import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  originalActionCompilerFixtures as fixture,
  originalActionCompilerRegression,
  originalActionCompilerSource,
} from "../tests/action-compiler-original-fixtures.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "legacy");
const generator = await readFile(resolve(root, "scripts/capture-action-compiler.mjs"), "utf8");
const match = generator.match(/const python = String\.raw`\n([\s\S]*?)\n`;/);
if (!match) throw new Error("Read-only legacy oracle boundary changed.");
const runOracle = () => JSON.parse(execFileSync(process.env.PYTHON ?? "python3", ["-c", match[1]], {
  cwd: repository,
  env: { ...process.env, PKM_REPOSITORY: repository, PYTHONDONTWRITEBYTECODE: "1" },
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
}));
const text = await readFile(resolve(root, "src/domain/action-compiler-original.ts"), "utf8");
const candidateText = text.match(/^export const ORIGINAL_ACTION_COMPILER_CAPTURE = ([\s\S]*) as const;\n$/);
if (!candidateText) throw new Error("Action compiler candidate format changed.");
const candidate = JSON.parse(candidateText[1]);
const current = runOracle();
const repeatedOracleIdentical = isDeepStrictEqual(current, runOracle());
const candidateDiff = [...new Set([...Object.keys(current), ...Object.keys(candidate)])]
  .filter(key => !isDeepStrictEqual(current[key], candidate[key]));
const expectedFixture = {
  example: current.example,
  diagnostics: current.diagnostics,
  orderedDiagnostics: current.orderedDiagnostics,
  orderedDefinition: current.orderedDefinition,
  moduleSet: current.moduleSet,
  moduleSetFile: current.moduleSetFile,
  originalRuntimeContentHash: current.originalRuntimeContentHash,
  originalRuntimeDigest: current.originalRuntimeDigest,
  componentEngineHash: current.componentEngineHash,
  sourceHashes: current.sourceHashes,
  builtins: current.builtinDefinitions,
};
const fixtureDiff = [...new Set([...Object.keys(expectedFixture), ...Object.keys(fixture)])]
  .filter(key => !isDeepStrictEqual(expectedFixture[key], fixture[key]));
const sourceDeclarationsEqual = isDeepStrictEqual(current.source, originalActionCompilerSource);
const regressionStatementsEqual = isDeepStrictEqual(current.regression, originalActionCompilerRegression);
console.log(JSON.stringify({
  repeatedOracleIdentical,
  candidateKeys: Object.keys(current).length,
  candidateDiff,
  fixtureDiff,
  sourceDeclarationsEqual,
  regressionStatementsEqual,
}, null, 2));
if (!repeatedOracleIdentical || candidateDiff.length || fixtureDiff.length
  || !sourceDeclarationsEqual || !regressionStatementsEqual) process.exitCode = 1;
