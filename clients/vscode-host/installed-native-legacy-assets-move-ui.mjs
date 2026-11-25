import { installedKnowledgeMoveUiProgramFor, startInstalledKnowledgeMoveUiProfile } from "./installed-native-knowledge-move-ui.mjs";

export const installedNativeLegacyAssetsMoveUiProgram = installedKnowledgeMoveUiProgramFor("legacy-unshared");
export async function startInstalledNativeLegacyAssetsMoveUi(args) {
  return startInstalledKnowledgeMoveUiProfile({ ...args, profile: "legacy-unshared" });
}
