// Observed verification results, not a cutover authorization.
export const baselineObservations = {
  referenceTests: 1130,
  initialAttempt: {
    command: "node --test-concurrency=4 --test <sorted *.test.mjs excluding storage-io-fault, legacy-recipe-trash, legacy-regression-batch12>",
    tests: 1121, passed: 1119, failed: 2,
    failures: [
      { file: "tests/batch08-browser-workflows.test.mjs", observed: "Playwright Route.fetch: Request context disposed" },
      { file: "tests/batch09-client-browser.test.mjs", observed: "Expected Skill edited; observed empty content" },
    ],
  },
  unchangedTargetedRetry: {
    command: "node --test-concurrency=4 --test tests/batch08-browser-workflows.test.mjs tests/batch09-client-browser.test.mjs",
    tests: 2, passed: 2, failed: 0,
  },
  historicalSchema15Baseline: {
    databaseSchema: 15,
    command: "node --test-concurrency=4 --test $(find tests -maxdepth 1 -name '*.test.mjs' ! -name 'storage-io-fault.test.mjs' | sort)",
    tests: 1144, passed: 1144, failed: 0,
    nativeSourceDigest: "83f47ea0026b6dc554b4d55098b7e394daa0e20003fe8427ee52ce562a58a532",
    scope: "Existing-suite regression check excluding the new fault matrix; NOT parent full acceptance or verification.json authority.",
  },
  historicalSchema16Baseline: {
    databaseSchema: 16,
    command: "node --test-concurrency=4 --test $(find tests -maxdepth 1 -name '*.test.mjs' ! -name 'storage-io-fault.test.mjs' | sort)",
    tests: 1157, passed: 1151, failed: 6,
    nativeSourceDigest: "dbf2a040dfb605d0bf06f21e03a5890d6267a8e9e9da4c030e1592db47627730",
    failures: [
      { file: "tests/batch10-native-commands.test.mjs", line: 184, observed: "RECOVERY_CONFLICT: Multiple durable workspace intents require reconciliation before any effect." },
      { file: "tests/batch10-native-commands.test.mjs", line: 222, observed: "RECOVERY_CONFLICT: Multiple durable workspace intents require reconciliation before any effect." },
      { file: "tests/legacy-command-extension-recovery.test.mjs", line: 350, observed: "RECOVERY_CONFLICT: Multiple durable workspace intents require reconciliation before any effect." },
      { file: "tests/migration.test.mjs", line: 49, observed: "Curated original/captured source hash records mismatch." },
      { file: "tests/provenance-readonly.test.mjs", line: 25, observed: "Native-only --check rejects changed native source hashes." },
      { file: "tests/readiness.test.mjs", line: 134, observed: "Native source-identity mapping hashes mismatch." },
    ],
    scope: "Existing-suite regression check excluding the new fault matrix; failed and NOT parent full acceptance or verification.json authority.",
  },
  fullBaseline: {
    databaseSchema: 23,
    command: "npm test --prefix next-server",
    serverTests: 1444, clientTests: 12, tests: 1456, passed: 1456, failed: 0,
    implementationDigest: "4121634d6631b29803de9046652b7d054902d0cf9069d03b750836503ea53a3f",
    nativeSourceDigest: "6a558e463215f7812044748eb8ba88950bdccbe46e934c1cc40ab00b1e9e7227",
    scope: "Actual parent run before this baseline record and subsequent qualification output changed; matches native src/dist bytes only. It is not current full-fingerprint verification or cutover authority.",
  },
  currentFunctionalRegression: {
    databaseSchema: 23,
    command: "npm --prefix next-server run build && node --test next-server/tests/legacy-skill-lifecycle.test.mjs next-server/tests/legacy-skill-lifecycle-native.test.mjs next-server/tests/legacy-skill-source.test.mjs next-server/tests/legacy-skill-source-native.test.mjs next-server/tests/host-composition-legacy-skill-source-transport.test.mjs next-server/tests/host-composition-legacy-skill-source-backup.test.mjs next-server/tests/host-composition-legacy-batch15-transport.test.mjs next-server/tests/host-composition-legacy-batch15-backup.test.mjs",
    tests: 80, passed: 80, failed: 0,
    nativeSourceDigest: "bb834f4b5b94a34479c44381072e20ceea192c996c2ed7245afb104ed261f980",
    scope: "Batch22 Skill source bridge related actual functional qualification only; NOT a new full baseline, parent acceptance, or Skill/classification/engine/memory filesystem-fault qualification. Historical schema15/16 baseline records preserved; no prior test-count carry-forward.",
  },
  readinessApproval: false,
};
