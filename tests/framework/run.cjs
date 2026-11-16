#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { createCatalog } = require("./catalog.cjs");
const { selectTests, PROFILE_NAMES } = require("./profiles.cjs");
const { runSupervised } = require("./supervised.cjs");
const { reference } = require("./report.cjs");

function parseArguments(arguments_) {
  const options = { files: [], suites: [], jobs: 2 };
  const switches = { "--list": "list", "--inventory": "inventory", "--json": "json",
    "--dry-run": "dryRun", "--no-build": "noBuild", "--admit-native": "admitNative", "--admit-external": "admitExternal",
    "--admit-qualification": "admitQualification" };
  const values = { "--profile": "profile", "--suite": "suites", "--file": "files", "--domain": "domain",
    "--layer": "layer", "--group": "group", "--test-name": "testName", "--jobs": "jobs", "--timeout": "timeoutMs" };
  for (let index = 0; index < arguments_.length; index++) {
    const flag = arguments_[index];
    if (switches[flag]) { options[switches[flag]] = true; continue; }
    if (!values[flag] || !arguments_[index + 1] || arguments_[index + 1].startsWith("--"))
      throw new Error(`Unknown or incomplete argument: ${flag}. Use --profile ${PROFILE_NAMES.join("|")}, --domain, --layer, --suite or --file.`);
    const value = arguments_[++index], key = values[flag];
    if (key === "files" || key === "suites") options[key].push(value);
    else if (key === "jobs" || key === "timeoutMs") {
      const max = key === "jobs" ? 4 : 3600;
      if (!/^[1-9]\d*$/.test(value) || Number(value) > max) throw new Error(`${flag} must be 1-${max}.`);
      options[key] = Number(value) * (key === "timeoutMs" ? 1000 : 1);
    } else {
      if (options[key]) throw new Error(`Repeated selector: ${flag}`);
      options[key] = value;
    }
  }
  if (options.group) {
    if (options.profile || options.domain || options.layer || options.files.length || options.suites.length)
      throw new Error("Choose --group or other selectors, not both.");
    if (options.group === "unit") options.profile = "quick";
    else if (options.group === "e2e") options.profile = "native";
    else if (["framework", "component", "integration", "browser", "native"].includes(options.group)) options.layer = options.group;
    else options.domain = options.group;
  }
  if (options.inventory && (options.profile || options.domain || options.layer || options.files.length || options.suites.length || options.testName))
    throw new Error("--inventory describes the whole checkout, not a partial selection.");
  return options;
}

function catalogSummary(catalog) {
  const counts = key => catalog.entries.reduce((result, entry) => {
    const name = entry[key] || "not-applicable";
    result[name] = (result[name] || 0) + 1;
    return result;
  }, {});
  return { schema: catalog.schema, fingerprint: catalog.fingerprint, files: catalog.files,
    tests: catalog.tests, aliases: catalog.aliases.length, roles: counts("role"), layers: counts("layer"), domains: counts("domain") };
}

async function main(arguments_) {
  const repositoryRoot = path.resolve(__dirname, "../..");
  const options = parseArguments(arguments_);
  options.files = options.files.map(file => path.relative(repositoryRoot, path.resolve(repositoryRoot, file)).split(path.sep).join("/"));
  const catalog = createCatalog(repositoryRoot);
  if (options.inventory) {
    console.log(JSON.stringify(options.json ? {
      ...catalog, entries: catalog.entries.map(entry => ({ ...entry, reference: reference(entry.id) })),
      aliases: catalog.aliases.map(entry => ({ ...entry, reference: reference(entry.id) })),
    } : catalogSummary(catalog), null, 2));
    return;
  }
  if (options.list) {
    const filtered = options.profile || options.layer || options.domain || options.files.length || options.suites.length;
    const selection = filtered ? selectTests(catalog, options) : null;
    const entries = selection ? selection.entries
      : [...catalog.entries.filter(entry => entry.role === "test"), ...catalog.aliases];
    const referenced = entries.map(entry => ({ ...entry, reference: reference(entry.id) }));
    if (options.json) console.log(JSON.stringify(selection?.selectionPolicy ? { ...selection, entries: referenced } : referenced, null, 2));
    else {
      if (selection?.selectionPolicy) {
        console.log(`PROFILE ${selection.profile}: ${selection.selectionPolicy.scope}`);
        console.log(selection.selectionPolicy.inclusion);
        for (const entry of selection.selectionPolicy.excluded)
          console.log(`EXCLUDED ${entry.id}: ${entry.reason} Requirements: ${entry.requirements.join(", ")}`);
      }
      for (const entry of entries) console.log(`${entry.layer.padEnd(12)} ${entry.domain.padEnd(16)} ${entry.id}`);
    }
    return;
  }
  const plan = selectTests(catalog, options);
  if (options.dryRun) { console.log(JSON.stringify(plan, null, 2)); return; }
  if (plan.audit) { console.log(JSON.stringify(catalogSummary(catalog), null, 2)); return; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runSupervised(plan, {
      repositoryRoot, jobs: options.jobs, noBuild: options.noBuild, timeoutMs: options.timeoutMs,
      environment: plan.environment,
      admitNative: options.admitNative, admitExternal: options.admitExternal,
      admitQualification: options.admitQualification, signal: controller.signal,
      onEvent: options.json ? undefined : event => {
        if (event.type === "build") console.log(`BUILD once; ${event.total} selected tests; ${options.jobs} jobs`);
        if (event.type === "complete") console.log(`${event.outcome.toUpperCase()} ${event.name} ${event.durationMs}ms`);
      },
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(JSON.stringify(result.summary, null, 2));
      if (result.report) console.error(`Failure summary (entire run <=64 KiB): ${result.report}`);
    }
    if (!result.summary.successful || controller.signal.aborted) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

module.exports = { main, parseArguments, catalogSummary };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
