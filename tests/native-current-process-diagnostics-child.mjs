import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { openOriginalMcpRoot } from "../dist/original-mcp-root.js";
import { createOriginalMcpNativeHost } from "../dist/original-mcp-native-host.js";
import { createNativePublicOwnerBackend } from "../dist/native-public-mcp-owner.js";
import { originalPublicMcpContracts } from "../dist/native-public-original-mcp-contracts.js";

const plan = JSON.parse(await readFile(process.argv[2], "utf8"));
const opened = await openOriginalMcpRoot(plan);
let host, backend;
try {
  host = await createOriginalMcpNativeHost(opened.storage, {
    profileSha256: plan.profileSha256,
    sourceCatalogSha256: originalPublicMcpContracts().provenance.metadataSha256,
    authorityId: "fresh-process-native-profile", epoch: randomUUID(), signal: new AbortController().signal,
    assertCurrent() {}, async authorizeAdmission() { return true; }, async authorizePublic() { return true; },
    models: {
      configuration: { aiEndpoint: "https://native.invalid/v1", aiModel: "not-invoked" },
      registryAvailability: {}, async credentialAvailable() { return false; }, async authorizeRequest() { return false; },
      transport: { supports: () => false, async open() { throw new Error("No model transport selected."); } },
    },
  });
  backend = createNativePublicOwnerBackend(opened.owner, {
    actor: { id: "mcp:external", canWrite: false }, originalMcpHost: host,
  });
  const response = await backend.invoke("original_mcp_public", { tool: "diagnostics_latest", arguments: {} });
  console.log(JSON.stringify(response.structuredContent));
} finally {
  await backend?.close(); await host?.close(); await opened.owner.close();
}
