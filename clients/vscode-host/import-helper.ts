import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { planLegacyImport, importLegacyWorkspace } from "../../src/legacy-import.js";

async function validateDestination(source: string, destination: string) {
  if (!isAbsolute(source) || !isAbsolute(destination)) throw new Error("Explicit absolute source and destination required.");
  if (source !== resolve(source) || destination !== resolve(destination)) throw new Error("Use canonical absolute paths.");
  const within = (a: string, b: string) => {
    const path = relative(a, b);
    return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  if (within(source, destination) || within(destination, source)) throw new Error("Source and destination must be disjoint.");
  const parent = dirname(destination);
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Destination parent must contain no symlinks.");
  }
  if (await realpath(parent) !== parent) throw new Error("Destination parent must be canonical.");
  try { await lstat(destination); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Destination already exists; choose a NEW isolated path. Nothing was overwritten.");
}

async function main(request: any) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || major === 22 && minor < 18) throw new Error("Node >=22.18 is required.");
  if (request.action === "inspect") {
    const { source, destination, python } = request;
    if (typeof python !== "string" || !isAbsolute(python)) throw new Error("Explicit absolute Python executable required.");
    const blockers = [];
    try { await validateDestination(source, destination); }
    catch (error) { blockers.push({ code: "destination-invalid", message: (error as Error).message }); }
    const plan = await planLegacyImport(source);
    return { source, destination, python, plan, blockers: [...plan.blockers, ...blockers] };
  }
  if (request.action !== "import") throw new Error("Unknown import action.");
  const { source, destination, python, plan, blockers } = request.inspection;
  if (!plan.ready || blockers.length || plan.sourceRoot !== source || !isAbsolute(python)) throw new Error("No ready inspected plan.");
  await validateDestination(source, destination);
  // The importer re-plans and compares the full digest before creating staging files.
  // No native snapshot/identity/Memory/trash/learner authorizers are manufactured here.
  return { receipt: await importLegacyWorkspace(plan, destination, { pythonExecutable: python }), cutover: false };
}

try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  console.log(JSON.stringify(await main(JSON.parse(input))));
} catch (error) {
  console.log(JSON.stringify({ error: {
    code: error instanceof Error && "code" in error ? error.code : "IMPORT_FAILED",
    message: error instanceof Error ? error.message : "Import failed",
  } }));
}
