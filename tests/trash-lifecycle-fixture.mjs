const freeze = value => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
export const trashLifecycleTransportFixture = freeze({
  ids: ["knowledge.trash.lifecycle.preview", "knowledge.trash.move", "knowledge.trash.restore"],
  readOnly: [true, false, false],
  moveKeys: ["operationId", "area", "path", "kind", "expectedTreeSha256", "expectedScanRevision", "entryIdFormat"],
  restoreKeys: ["operationId", "entryId", "expectedScanRevision"],
  resultKeys: ["operationId", "action", "entryId", "area", "path"],
  forbidden: ["knowledge.delete", "knowledge.restore", "knowledge.trash.empty", "knowledge.trash.delete"],
});
