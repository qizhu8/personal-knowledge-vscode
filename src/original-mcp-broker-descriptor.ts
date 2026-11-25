import { readOriginalMcpBrokerDescriptor, originalMcpBrokerError } from "./original-mcp-relay.js";

/** Read-only, redacted provider verification. This neither opens a root nor mints admission authority. */
export async function verifyOriginalMcpBrokerDescriptor(path: string, independentSha256: string,
  expectedProfileSha256?: string) {
  const { descriptor } = readOriginalMcpBrokerDescriptor(path, independentSha256);
  if (expectedProfileSha256 !== undefined && descriptor.profileSha256 !== expectedProfileSha256)
    originalMcpBrokerError();
  return {
    schema: "pkm.original-mcp-broker-verification/v1" as const,
    root: descriptor.root.path, rootDevice: descriptor.root.device, rootInode: descriptor.root.inode,
    workspaceId: descriptor.workspaceId, profileSha256: descriptor.profileSha256, operatorId: descriptor.operatorId,
    scope: descriptor.scope, writable: descriptor.writable,
    nodePath: descriptor.runtime.node.path, nodeSha256: descriptor.runtime.node.sha256,
    relayPath: descriptor.runtime.relay.path, relaySha256: descriptor.runtime.relay.sha256,
    runtimeBuildSha256: descriptor.runtime.buildSha256,
    descriptorPath: path, descriptorSha256: independentSha256, brokerId: descriptor.brokerId,
    brokerPid: descriptor.process.pid,
    enabledOperationIds: [...descriptor.availability.enabledOperationIds],
    disabledOperationIds: [...descriptor.availability.disabledOperationIds],
    limitations: [...descriptor.availability.limitations],
  };
}
