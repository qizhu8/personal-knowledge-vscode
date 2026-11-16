"use strict";

const { commandFor } = require("./catalog.cjs");

const PROFILE_NAMES = ["audit", "quick", "ci", "regression", "browser", "native", "qualification", "runtime", "sync", "linux-candidate"];
const QUICK = [
  "tests/markdown.test.mjs", "tests/core-result-validation.test.mjs", "tests/document-path.test.mjs",
];
const LINUX_CANDIDATE_EXCLUSIONS = [
  {
    id: "tests/legacy-real-note-create-adoption.test.mjs",
    requirements: ["PKM_INSTALLED_LEGACY_WRITE_FIXTURE"],
    reason: "Requires a genuinely drained installed 4.0.22 Note-create history root, including its original diagnostic and usage records.",
  },
  {
    id: "tests/selected-chat-live-control-conflict.test.mjs",
    requirements: ["PKM_SELECTED_INSTALLED_EXTENSION"],
    reason: "Requires the actual installed original ApiChatStore and ApiChatAgentControl modules and their live heartbeat, not current-source substitutes.",
  },
  {
    id: "tests/next-room-private-admission.test.mjs",
    requirements: ["PKM_PRIVATE_ROOM_BASELINE_FIXTURE", "PKM_LEGACY_VSIX"],
    reason: "Requires an authorized historical installed Room capture with meeting-state.json, old-root and host-home; remaining cases also require the hash-authenticated original 4.0.22 VSIX. The separate original-controlled simulation remains included, not a replacement for this gate.",
  },
  {
    id: "tests/legacy-ui-recipe-metadata.test.mjs",
    requirements: ["PKM_TEST_LEGACY_RECIPE_METADATA_PROFILE", "PKM_TEST_LEGACY_RECIPE_INCOMPLETE_METADATA_PROFILE"],
    reason: "Requires actual closed original installed MCP metadata and incomplete-quiesce profiles under .migration-test-work, preserving original telemetry.",
  },
  {
    id: "tests/legacy-ui-recipe-receipts.test.mjs",
    requirements: ["PKM_TEST_LEGACY_RECIPE_PROFILE"],
    reason: "Requires a closed installed-original Recipe profile, its canonical receipt/control backups, workspace input and original-recipe-evidence.json.",
  },
];

function selectTests(catalog, options) {
  if (options.profile && (options.files?.length || options.suites?.length || options.domain || options.layer))
    throw new Error("Choose a profile or explicit file/suite/domain/layer selectors, not both.");
  const tests = catalog.entries.filter(entry => entry.role === "test");
  let entries;
  const profile = options.profile || ((!options.files?.length && !options.suites?.length && !options.domain && !options.layer) ? "ci" : null);
  if (profile && !PROFILE_NAMES.includes(profile)) throw new Error(`Unknown profile: ${profile}. Known: ${PROFILE_NAMES.join(", ")}`);
  if (profile === "audit") entries = [];
  else if (profile === "quick") entries = tests.filter(entry => entry.layer === "framework" || QUICK.includes(entry.id));
  else if (profile === "ci" || profile === "regression")
    entries = tests.filter(entry => ["framework", "component", "integration"].includes(entry.layer));
  else if (profile === "linux-candidate") {
    if (process.platform !== "linux") throw new Error("The linux-candidate profile requires Linux; Windows qualification remains separate.");
    const excluded = new Set(LINUX_CANDIDATE_EXCLUSIONS.map(entry => entry.id));
    entries = tests.filter(entry => !excluded.has(entry.id));
  }
  else if (profile === "browser") entries = tests.filter(entry => entry.layer === "browser");
  else if (profile === "qualification") {
    const suite = catalog.aliases.find(entry => entry.id === "test:qualification");
    if (!suite) throw new Error("v5 qualification requires the original provenance-gated test:qualification entrypoint.");
    entries = [suite];
  }
  else if (profile === "native") entries = [...tests.filter(entry => entry.layer === "native"),
    ...catalog.aliases.filter(entry => entry.layer === "native" && entry.role === "suite" && entry.id !== "test:release")];
  else if (profile === "runtime") entries = tests.filter(entry =>
    entry.domain === "runtime" && ["component", "integration"].includes(entry.layer));
  else if (profile === "sync") {
    entries = tests.filter(entry => entry.domain === "sync" && ["component", "integration"].includes(entry.layer));
  } else {
    entries = [];
    for (const file of options.files || []) {
      const entry = catalog.entries.find(candidate => candidate.id === file);
      if (!entry || entry.role !== "test") throw new Error(`Select a catalogued test, not a fixture or controller: ${file}`);
      entries.push(entry);
    }
    for (const name of options.suites || []) {
      if (name === "framework") entries.push(...tests.filter(entry => entry.layer === "framework"));
      else if (name === "core-unit") entries.push(...tests.filter(entry => QUICK.includes(entry.id) && !entry.file.startsWith("tests/runtime/")));
      else if (name === "runtime-node" || name === "runtime-python") entries.push(...tests.filter(entry =>
        entry.file.startsWith("tests/runtime/") && entry.language === (name === "runtime-node" ? "node" : "python")));
      else {
        const entry = catalog.aliases.find(candidate => candidate.id === name);
        if (!entry || entry.role !== "suite") throw new Error(`Unknown test suite or preparation-only command: ${name}`);
        entries.push(entry);
      }
    }
    if (options.domain || options.layer) {
      if (options.files?.length || options.suites?.length) throw new Error("Do not combine domain/layer selection with explicit files/suites.");
      entries = tests.filter(entry => (!options.domain || entry.domain === options.domain) && (!options.layer || entry.layer === options.layer));
    }
  }
  entries = [...new Map(entries.map(entry => [entry.id, entry])).values()].sort((a, b) => a.id.localeCompare(b.id));
  if (profile !== "audit" && !entries.length) throw new Error("Selection matched no tests.");
  if (options.testName && (entries.length !== 1 || entries[0].role !== "test"))
    throw new Error("--test-name requires exactly one test file.");
  return {
    profile: profile || "selected", fingerprint: catalog.fingerprint, audit: profile === "audit",
    ...(profile === "linux-candidate" ? {
      environment: { PKM_TEST_QUALIFICATION: "linux-candidate" },
      selectionPolicy: {
        scope: "Current v5 isolated Linux candidate regression and requalification only; not production-old-root takeover, historical installed-original/UI/private admission or Windows qualification.",
        inclusion: "Every catalogued test file is included regardless of layer or capability except the closed exact identities below. Browser, native, migration/provenance regressions and original-controlled simulations remain included. Native/external admission and all-skipped failures are unchanged.",
        excluded: LINUX_CANDIDATE_EXCLUSIONS.map(entry => ({ ...entry, requirements: [...entry.requirements] })),
      },
    } : {}),
    entries: entries.map(entry => ({
      ...entry, name: entry.id, group: entry.layer, command: entry.command || commandFor(entry, options.testName),
      testName: options.testName,
      resources: [
        ...(entry.capabilities.includes("browser") ? ["browser-runtime"] : []),
        ...(entry.capabilities.includes("model-runtime") ? ["model-runtime"] : []),
        ...(entry.domain === "retrieval" ? ["retrieval-runtime"] : []),
        ...(entry.layer === "native" ? ["native-runtime"] : []),
      ],
    })),
  };
}

module.exports = { PROFILE_NAMES, selectTests };
