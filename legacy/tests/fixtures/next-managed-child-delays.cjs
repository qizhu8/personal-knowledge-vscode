"use strict";

const { registerHooks } = require("node:module");
const storage = `
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export class Storage {}
const wait = type => new Promise(resolve => {
  const listener = message => { if (message?.type === type) { process.off("message", listener); resolve(); } };
  process.on("message", listener);
});
export async function initialize(directory) {
  process.send({type: "test-initializing"});
  await wait("test-release-initialize");
  if (process.env.PKM_TEST_FAIL_INITIALIZE) throw new Error("synthetic initialize failure");
  await mkdir(directory);
  await writeFile(join(directory, ".pkm-next-workspace"), JSON.stringify({id: "12345678-1234-1234-1234-123456789abc"}));
  await writeFile(join(directory, "initialized"), "finished");
}`;
const host = `
export function bindImportedReadOnlyHost() { throw new Error("Not used by this startup fixture"); }
const wait = type => new Promise(resolve => {
  const listener = message => { if (message?.type === type) { process.off("message", listener); resolve(); } };
  process.on("message", listener);
});
export async function startManagedClientHost() {
  process.send({type: "test-starting-host"});
  await wait("test-release-host");
  let closeAttempts = 0;
  return {close: async () => {
    process.send({type: "test-closing-host"});
    await wait("test-release-close");
    if (process.env.PKM_TEST_FAIL_FIRST_HOST_CLOSE && ++closeAttempts === 1)
      throw new Error("synthetic host close failure");
  }};
}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./domain/legacy-import.js") return {
      url: "data:text/javascript,export const legacyImportPlanSchema={parse(){throw new Error('Not used by this startup fixture');}};export const legacyImportOutcomeSchema=legacyImportPlanSchema;export const legacyImportLimitsSchema=legacyImportPlanSchema;export const legacyImportReceiptSchema=legacyImportPlanSchema;export function legacyImportNoReplacePlatformError(){throw new Error('Not used');}",
      shortCircuit: true,
    };
    if (!context.parentURL?.endsWith("/managed-client-child.js")) return nextResolve(specifier, context);
    if (specifier === "./managed-import-audit.js") return {
      url: "data:text/javascript,export function auditImportedWorkspace(){throw new Error('Not used by this startup fixture');}",
      shortCircuit: true,
    };
    if (specifier === "./managed-import-write.js") return {
      url: "data:text/javascript,export const experimentCoverage={}; export function openImportedExperiment(){throw new Error('Not used by this startup fixture');}",
      shortCircuit: true,
    };
    if (specifier === "./storage.js") return { url: `data:text/javascript,${encodeURIComponent(storage)}`, shortCircuit: true };
    if (specifier === "./managed-client-host.js") return { url: `data:text/javascript,${encodeURIComponent(host)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
