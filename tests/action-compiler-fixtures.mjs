export function actionCompilerTransportFixture(operation, args, result) {
  return { operation, args, result };
}

export function moduleSetSource(manifest, files, enabled = false) {
  return { kind: "moduleSet", manifest, files, enabled };
}
