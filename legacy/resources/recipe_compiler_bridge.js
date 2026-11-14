"use strict";

// A transport only: normalization and hashing belong to the shipped TS compiler.
const fs = require("node:fs");
try {
  const { compileWorkflowDefinitionV1 } = require(process.argv[2]);
  const definition = JSON.parse(fs.readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify(compileWorkflowDefinitionV1(definition)));
} catch (error) {
  process.stderr.write(`Recipe compiler bridge failed: ${error.message}\n`);
  process.exitCode = 1;
}
