import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, relative, sep } from "node:path";
import type { ActionAuthorizationBinding } from "./action-runtime.js";
import { RUNTIME_PROCESS_LIMITS } from "./runtime-process-contracts.js";

type Source = { path: string; sha256: string };
export type ActionBuildPlan = {
  compiler: string; compilerSha256: string; args: string[]; sources: Source[];
  outputs: string[]; timeoutSeconds: number; runtime: string; runtimeSha256?: string;
};
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function resolveActionExecutable(program: string): string | undefined {
  if (!program || program.includes("\0")) return undefined;
  const names = process.platform === "win32" && !/\.(exe|com)$/i.test(program)
    ? [`${program}.exe`, `${program}.com`] : [program];
  const candidates = isAbsolute(program) ? names
    : program.includes("/") || program.includes("\\") ? []
      : (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)
        .flatMap(directory => names.map(name => join(directory, name)));
  for (const candidate of candidates) {
    try {
      const executable = realpathSync(candidate);
      if (statSync(executable).isFile()) {
        accessSync(executable, constants.X_OK);
        return executable;
      }
    } catch (error) {
      if (error instanceof Error && "code" in error
        && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES" || error.code === "EPERM")) continue;
      throw error;
    }
  }
  return undefined;
}

function privateDirectory(path: string): void {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))
      throw new Error("Action build requires an existing private .pkm-action-sources directory.", { cause: error });
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
    || process.platform !== "win32" && ((stat.mode & 0o077) !== 0
      || typeof process.getuid === "function" && stat.uid !== process.getuid()))
    throw new Error("Action build directory must be private, owned and free of symlinks.");
}
function fileHash(file: string, maximum: number, source = false): string {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum
    || (source && (stat.nlink !== 1 || process.platform !== "win32"
      && typeof process.getuid === "function" && stat.uid !== process.getuid())))
    throw new Error("Action build file is unsafe or exceeds its size limit.");
  const content = readFileSync(file);
  if (content.length > maximum) throw new Error("Action build file exceeds its size limit.");
  return sha256(content);
}
function argumentsValid(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= RUNTIME_PROCESS_LIMITS.arguments
    && value.every(item => typeof item === "string" && !item.includes("\0"))
    && Buffer.byteLength(JSON.stringify(value)) <= RUNTIME_PROCESS_LIMITS.argumentBytes;
}

/** Only freshly authored files in the private source directory may enter this build path. */
export function inspectActionBuild(root: string, binding: ActionAuthorizationBinding): ActionBuildPlan {
  const implementation = binding.implementation, build = implementation.build;
  if (implementation.kind !== "program" || !isRecord(build) || typeof build.program !== "string"
    || !argumentsValid(build.args) || !argumentsValid(implementation.args ?? [])
    || !Array.isArray(build.source_files) || build.source_files.length < 1 || build.source_files.length > 16
    || !Array.isArray(build.outputs) || build.outputs.length < 1 || build.outputs.length > 16
    || Object.keys(build).some(key => !["program", "args", "source_files", "outputs", "timeout_seconds"].includes(key))
    || implementation.files !== undefined)
    throw new Error("Unsupported Action build shape; declare bounded sources, outputs and argv only.");
  const timeoutSeconds = build.timeout_seconds ?? 120;
  if (!Number.isSafeInteger(timeoutSeconds) || Number(timeoutSeconds) < 1 || Number(timeoutSeconds) > 300)
    throw new Error("Action build timeout must be an integer from 1 to 300 seconds.");
  const sourcesDir = join(root, ".pkm-action-sources");
  privateDirectory(root);
  privateDirectory(sourcesDir);
  const sources = build.source_files.map(value => {
    if (typeof value !== "string" || !isAbsolute(value) || !safeName.test(basename(value))
      || relative(sourcesDir, value) !== basename(value) || realpathSync(value) !== value)
      throw new Error("Action build sources must be direct files in the private .pkm-action-sources directory.");
    return { path: value, sha256: fileHash(value, 512 * 1024, true) };
  });
  if (new Set(sources.map(source => source.path)).size !== sources.length)
    throw new Error("Action build sources must be unique.");
  const outputs = build.outputs.map(value => {
    if (typeof value !== "string" || !safeName.test(value) || value === "." || value === "..")
      throw new Error("Action build outputs must be safe direct filenames.");
    return value;
  });
  if (new Set(outputs).size !== outputs.length) throw new Error("Action build outputs must be unique.");
  const compiler = resolveActionExecutable(build.program);
  if (!compiler) throw new Error(`Missing Action build toolchain: ${build.program}; PKM does not install or download tools.`);
  const program = implementation.program;
  if (typeof program !== "string") throw new Error("Action runtime program is missing.");
  const builtProgram = program.startsWith("${build_dir}/") ? program.slice("${build_dir}/".length) : undefined;
  const runtime = builtProgram ? program : resolveActionExecutable(program);
  if (!runtime || builtProgram && !outputs.includes(builtProgram))
    throw new Error(`Missing Action runtime or undeclared build executable: ${program}; PKM does not install tools.`);
  const runArgs = implementation.args as string[] | undefined ?? [];
  if (!builtProgram && !outputs.some(output => runArgs.includes(`\${build_dir}/${output}`)))
    throw new Error("The runtime arguments must name a declared fresh build output.");
  const buildArgs = build.args as string[];
  if (sources.some(source => !buildArgs.includes(source.path)))
    throw new Error("Every declared build source must be a separate compiler argument.");
  for (const arg of buildArgs) {
    if (sources.some(source => arg !== source.path && arg.includes(source.path)))
      throw new Error("Build source arguments must not be embedded in other arguments.");
  }
  return {
    compiler, compilerSha256: fileHash(compiler, 128 * 1024 * 1024),
    args: [...buildArgs], sources, outputs, timeoutSeconds: Number(timeoutSeconds), runtime,
    ...(!builtProgram ? { runtimeSha256: fileHash(runtime, 128 * 1024 * 1024) } : {}),
  };
}

export function materializeActionBuild(root: string, plan: ActionBuildPlan): { directory: string; args: string[] } {
  privateDirectory(root);
  const builds = join(root, ".pkm-action-builds");
  try { mkdirSync(builds, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  privateDirectory(builds);
  const directory = join(builds, randomUUID());
  mkdirSync(directory, { mode: 0o700 });
  const replacements = new Map<string, string>();
  for (const [index, source] of plan.sources.entries()) {
    const bytes = readFileSync(source.path);
    if (bytes.length > 512 * 1024 || sha256(bytes) !== source.sha256)
      throw new Error("Action build source changed after consent.");
    const target = join(directory, `source-${index}-${basename(source.path)}`);
    writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    replacements.set(source.path, target);
  }
  return { directory, args: plan.args.map(arg => replacements.get(arg) ?? arg.replaceAll("${build_dir}", directory)) };
}

export function validateActionBuildOutputs(directory: string, outputs: string[]): void {
  privateDirectory(directory);
  for (const output of outputs) {
    const file = join(directory, output), rel = relative(directory, realpathSync(file));
    if (rel !== output || rel.startsWith(`..${sep}`))
      throw new Error("Action build output escapes its private directory.");
    fileHash(file, 128 * 1024 * 1024, true);
  }
}
