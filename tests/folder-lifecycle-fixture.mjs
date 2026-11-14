const sourceSha256 = "a".repeat(64);
const scanRevision = "b".repeat(64);

export const folderLifecycleTransportFixture = Object.freeze({
  preview: {
    operation: "knowledge.folder.lifecycle.preview",
    args: { area: "notes", path: "Archive/Team", destinationPath: "Current/Team" },
    result: {
      area: "notes",
      sourcePath: "Archive/Team",
      destinationPath: "Current/Team",
      sourceSha256,
      scanRevision,
      entries: 5,
      files: 3,
      bytes: 42,
      documents: 2,
      rewrittenDocuments: 1,
      destinationAbsent: true,
      scannedDocuments: 3,
      scannedBytes: 120,
    },
  },
  move: {
    operation: "knowledge.folder.move",
    args: {
      operationId: "8a142f3e-b9bc-4f34-963c-5798479d316a",
      area: "notes",
      path: "Archive/Team",
      destinationPath: "Current/Team",
      expectedSourceSha256: sourceSha256,
      expectedScanRevision: scanRevision,
      expectedDestinationSha256: null,
    },
    result: {
      operationId: "8a142f3e-b9bc-4f34-963c-5798479d316a",
      action: "move",
      folder: {
        area: "notes",
        sourcePath: "Archive/Team",
        destinationPath: "Current/Team",
        sourceSha256,
        scanRevision,
        entries: 5,
        files: 3,
        bytes: 42,
        documents: 2,
        rewrittenDocuments: 1,
      },
    },
  },
});
