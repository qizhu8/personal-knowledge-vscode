import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Lifecycle-only test fixture; not a packaged-generation qualification or acceptance record. */
export async function legacyManagedFixture(parent) {
  const managedRoot = join(parent, "managed");
  const generation = randomUUID();
  const directory = join(managedRoot, "generations", generation);
  await mkdir(directory, { recursive: true });
  const manifest = {
    schema: "pkm.mcp.lifecycle/v1", generation, managedRoot, version: "0.1.0", extensionVersion: "0.1.0",
    runtimeBuild: createHash("sha256").update(generation).digest("hex"),
    components: { knowledge: "0.1.0", chat: "0.1.0", recipes: "0.1.0", agent_sessions: "0.1.0" },
    node: process.execPath, enabledFeatureDomains: [], files: {},
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(managedRoot, "active-generation.json"), JSON.stringify({ schema: manifest.schema, generation }));
  return directory;
}

export async function closeLegacyManagedFixture(client) {
  const receipt = await client.callTool({ name: "mcp_lifecycle_quiesce", arguments: {} });
  if (receipt.isError) throw new Error(JSON.stringify(receipt));
  await client.close();
}
