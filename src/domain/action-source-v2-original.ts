/** Additional frozen-source fixture evidence, not independent qualification or admission. */
export const ACTION_SOURCE_V2_CAPTURE = {
  schema: "pkm.action.source-capture/v2",
  identity: "frozen-original-v2",
  predecessor: "compiler-capture-v1",
  qualification: "fixture-only",
  sourceRoot: "legacy",
  sourceHashes: {
    "resources/action_runtime.py": "62377e17bfaf7e0f6dbdd98d7b206bd4ae3f622d566e8a456d6833d98563d56b",
    "resources/action_modules.py": "ec347620aa94e8ff56db91e66382542262bade79907b617968ffeae69a1c72d5",
    "resources/action_run_store.py": "ae79232105b21940f0addc26f1fc28a125a158ec60af7558d374f3f16531c479",
    "resources/action_recovery.py": "7ff3d346e19964419001c4c1e8b642bfef5380596cd810f01a532c7d6573d5bc",
    "resources/recipe_runtime.py": "2342ea420959b25e80394e18ea0a8c4c4dca43bb2231a41837c3f6920a5ce41a",
  },
  componentEngineHash: "200079020024367d0a72717d6de36ee8d9bd7005a2bb356e96edd3acb23f2a05",
  builtinContentHashes: {
    "core.date.parse": "80083ad59db6e238a508c8959850a1744835db2a0cfa06da78b60bbc268d4afd",
    "core.cast.integer-to-string": "f1e0b0826131edd27274c8310744a936978b8354084b0a8efcb66e362d461d3b",
    "core.cast.string-to-integer": "c61ca22cd356b32b653a6d790a070745a42998d335533b5c8d30aebd76d98c64",
    "core.cast.string-to-float": "d7965558d5d30e4ed8ed216a03698c1ba426d570dca77266bd69335e1ac1478f",
    "core.artifact.write": "cf4b40b9cb0c2b11b1fa25079f65a6d3712d5733d036faf3e29f803f2a73e8a9",
    "core.artifact.copy": "335c13a70fa0c80738b3eb91e942ec0ce5291f62e3a1fe2ae24939017681f151",
    "core.delay": "92715b9db2fc55ff6585c8804ccb1ad17dbb43767ee63f7ffd875a0bb5c7acf4",
    "core.ask-user": "21191c6cc492a204afc3329d1f032f084eb9ab29e1ed1d5dec40f8444bd39093",
    "core.chatroom-alias": "df905d8ff4be1a83fa4e74d3d8145830cb60d5e49151026941e4717b11e1910f",
  },
  remainingEvidence: [
    "independent exact-scope source and native-runtime qualification",
    "independent admission, trust-revocation and no-replay verification",
    "authorized acceptance and production-switch evidence",
  ],
} as const;
