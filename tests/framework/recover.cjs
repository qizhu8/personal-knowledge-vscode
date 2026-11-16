"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { restoreWorkspace, outsideCheckout } = require("./workspace.cjs");
const { writeRunFailure } = require("./report.cjs");

function cleanupRegistered(repositoryRoot, records) {
  if (!records.length) throw new Error("Crash recovery requires registered workspace identities.");
  const root = records[0];
  if (!fs.lstatSync(root.directory, { throwIfNoEntry: false })) return;
  outsideCheckout(repositoryRoot, root.directory);
  const known = new Map(records.map(record => [record.directory, record]));
  const temporary = path.join(root.directory, "tmp");
  if (fs.existsSync(temporary)) for (const name of fs.readdirSync(temporary)) {
    const child = path.join(temporary, name);
    if (!known.has(child)) throw new Error(`Unregistered workspace retained after coordinator crash: ${child}`);
  }
  for (const record of records) {
    const relative = path.relative(root.directory, record.directory);
    if (record.directory !== root.directory && (relative.startsWith("..") || path.isAbsolute(relative)))
      throw new Error("Recovery registry contains a workspace outside its run.");
    if (fs.lstatSync(record.directory, { throwIfNoEntry: false })) restoreWorkspace(record).validate();
  }
  restoreWorkspace(root).cleanup();
}

function recover(input) {
  let retainedWorkspace, cleanupError;
  try { cleanupRegistered(input.repositoryRoot, input.records); }
  catch (error) { retainedWorkspace = input.records[0].directory; cleanupError = error.message; }
  const result = {
    suite: "coordinator", outcome: retainedWorkspace ? "cleanup_error" : "cancelled",
    error: input.cause, cleanupError, stdout: "", stderr: "",
  };
  const report = writeRunFailure(input.repositoryRoot, {
    schema: "pkm.test-run/v1", profile: input.profile, catalogFingerprint: input.fingerprint,
    successful: false, interrupted: true, selected: input.selected,
    scope: "Coordinator crash; managed descendants reaped before cleanup. Individual unfinished assertions are not qualified.",
    retainedWorkspace: retainedWorkspace || null, cleanupError: cleanupError || null,
  }, [result], input.reportDirectory);
  console.error(`Interrupted test run; ${retainedWorkspace ? `RETAINED ${retainedWorkspace}` : "managed workspaces removed"}; report ${report}`);
  return { report, retainedWorkspace };
}

module.exports = { cleanupRegistered, recover };
if (require.main === module) recover(JSON.parse(fs.readFileSync(0, "utf8")));
