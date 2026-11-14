import { readFile } from "node:fs/promises";
import { readinessDigest } from "../scripts/readiness.mjs";

export const contract = JSON.parse(await readFile(new URL("../migration/readiness-contract.json", import.meta.url), "utf8"));
export const inventory = JSON.parse(await readFile(new URL("../migration/inventory.json", import.meta.url), "utf8"));

export function blockedFixture() {
  const clonedContract = structuredClone(contract);
  const clonedInventory = structuredClone(inventory);
  const serverContracts = [...new Set(clonedContract.workstreams.flatMap(gate => gate.contracts))]
    .sort().map(id => ({ id, version: clonedContract.operationVersion, readOnly: false }));
  return {
    contract: clonedContract,
    inventory: clonedInventory,
    currentInventory: structuredClone(clonedInventory),
    manifest: {
      schema: clonedContract.manifestSchema,
      workstreams: clonedContract.workstreams.map(({ id }) => ({ id, title: id, parity: false })),
    },
    implementationDigest: readinessDigest("current readiness evaluator test context"),
    captureIssues: [],
    serverContracts,
    sourceContractsCurrent: true,
    trustedAuthorities: [],
    artifactDigests: {},
    evidence: [],
  };
}
