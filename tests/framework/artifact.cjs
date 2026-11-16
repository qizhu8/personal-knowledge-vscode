"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function exportVsix(repositoryRoot, workspace, filename) {
  if (path.basename(filename) !== filename || !/^[A-Za-z0-9._-]+\.vsix$/.test(filename))
    throw new Error("Package export requires one explicit VSIX filename.");
  workspace.validate();
  const source = path.join(workspace.directory, "upper", filename);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Package export must come from this run's generated regular file, not a pre-existing archive.");
  const destination = path.join(repositoryRoot, filename);
  const previous = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || (process.getuid && previous.uid !== process.getuid())))
    throw new Error("Refusing to overwrite a foreign or symlinked package artifact.");
  const temporary = path.join(repositoryRoot, `.pkm-vsix-${randomUUID()}.tmp`);
  try {
    fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return destination;
}

module.exports = { exportVsix };
