"use strict";

const path = require("node:path");
const { createCatalog } = require("./catalog.cjs");
const { selectTests } = require("./profiles.cjs");

function suitesFor(repositoryRoot) {
  const catalog = createCatalog(repositoryRoot);
  return [...selectTests(catalog, { profile: "regression" }).entries, ...catalog.aliases];
}

function fileSuite(repositoryRoot, filename) {
  const file = path.relative(repositoryRoot, path.resolve(repositoryRoot, filename)).split(path.sep).join("/");
  return selectTests(createCatalog(repositoryRoot), { files: [file] }).entries[0];
}

module.exports = { suitesFor, fileSuite };
