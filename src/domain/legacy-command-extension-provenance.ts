export const originalLegacyCommandSources = [
  { path: "src/workflows/project-model.ts", sha256: "505f56e2351a9f173268007990eaf02f1014abe0dc4f722b12a8f6aa81c94195",
    symbols: ["createRecipe", "updateRecipe"] },
  { path: "src/workflows/project-store.ts", sha256: "a88568af85c6cbf714cc8c9efcfb641da12502df888b4c6dd9e4b7e24dacc010",
    symbols: ["ProjectStore.mutate", "ProjectStore.lifecycleProject", "ProjectStore.createRecipe", "ProjectStore.updateRecipe"] },
  { path: "src/workflows/project-cockpit.ts", sha256: "1952d5b2f4c7969fbd8f27beef3a955b9f36d3af7dc608c5776a26c0c499d617",
    symbols: ["projectLifecycle", "projectEvent"] },
  { path: "src/workflows/project-filesystem-store.ts", sha256: "20c0f58161b3f82181e48049e3ad95f0091ec41e1a1fba61413514c97502e0f8",
    symbols: ["ProjectFilesystemStore.checkCommand", "ProjectFilesystemStore.mutate", "syncProjectTree", "atomicWriteJson"] },
  { path: "src/workflows/recipe-filesystem-store.ts", sha256: "3ecfb22753d16455ff7427993fd4d017dc00c1d2ffd65be9414157e31421b6f5",
    symbols: ["RecipeFilesystemStore.replaceFromState", "prepareStoredRecipe", "writeJson"] },
] as const;

// Native dependency pins record the implementation used for qualification,
// not historical source provenance or authorization to change those files.
export const legacyCommandNativeQualificationPins = [
  { path: "next-server/src/project-mutations.ts", sha256: "fee77b4ff41e503520b2e3919ad4000b3ebf60e42d9273114d65ca6c70c60b2c" },
  { path: "next-server/src/legacy-control-import.ts", sha256: "4a2a4af61185239813a306d4feb1654b0c27f3e8bf349887e3df571574b956bf" },
  { path: "next-server/src/storage-worker.ts", sha256: "b1b086f621fa76565d605c5c0d1c19b587fb9cfd3a57aa84d097628e5207a525" },
] as const;
