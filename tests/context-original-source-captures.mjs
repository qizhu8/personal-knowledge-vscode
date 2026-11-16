import { packageRoot, readOriginalSource } from "../scripts/migration.mjs";

const archive = "migration/evidence/context-authentication-originals.zip";
const archiveSha256 = "814693241e47577674ca0b3b862c8d8048a643124372ebc400d9b3841ba0dbaa";
const pins = Object.freeze({
  "src/mcp/mcp.ts": "2a5f623b20b71e3d3ce12283db1fbcb01fb5fa4b43ebbf29d2fd9a28a992f948",
  "src/chatroom/meeting-state.ts": "777ea01d26cd721e61b8cb6599b640086d5bb10e80e3f8753732c83983f9201a",
  "src/chatroom/chat-meeting-lifecycle.ts": "fa9f4506dcc167cbba00ae4b1ef4886455781676fbeda51f73786458e60d09f8",
  "src/chat/api-chat-view.ts": "71ddd872aaf2e1fdf1a70616ebc4d50f03e4552152a6670b0e44cfcfdc2397e6",
  "src/knowledge/storage.ts": "a1a6be3f373ce0d89f8ecbe7b51d30e7c773621fd0bccfc234a0b6ce6c27b55d",
  "scripts/capture-subscription-bundle.mjs": "b5f14b79cb85abd2a8605b560b880f2f94afd64eacfb3f8c7badd80e1cb65b06",
});
const members = Object.freeze(Object.fromEntries(Object.keys(pins)
  .map(path => [path, `context-authentication-original/source/${path}`])));

export async function readContextOriginal(path, { sha256, kind = "source", root = packageRoot } = {}) {
  if (kind !== "source" || !Object.hasOwn(pins, path) || sha256 !== pins[path]) {
    throw new Error("No exact Context original path/role/digest binding.");
  }
  return readOriginalSource(`${archive}!/${members[path]}`, { root, kind, sha256, archiveSha256 });
}

export async function authenticateContextSources(records) {
  for (const { source, sourceSha256 } of records) {
    if (Object.hasOwn(pins, source)) {
      await readContextOriginal(source, { sha256: sourceSha256 });
    } else {
      await readOriginalSource(source, { kind: "source", sha256: sourceSha256 });
    }
  }
}
