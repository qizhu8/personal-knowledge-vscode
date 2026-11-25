import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { CoreError, type Actor } from "./contracts.js";
import type { Storage } from "./storage.js";
import { assertOriginalMcpNativeHost, type OriginalMcpNativeHost } from "./original-mcp-native-host.js";
import { admitLegacyActionPackage } from "./legacy-action-catalog.js";
import { admitLegacyActionArtifactPath } from "./legacy-action-artifacts.js";
import { actionPackageParentPin } from "./original-mcp-action-package-native-contracts.js";

export async function approveOriginalMcpActionPackageSource(storage: Storage, host: OriginalMcpNativeHost,
  actor: Actor, sourcePath: string, signal?: AbortSignal): Promise<void> {
  assertOriginalMcpNativeHost(host, storage);
  if (!host.actionPackageApprovalAvailable) return;
  const decision = await host.approveActionPackageSource(sourcePath, signal);
  if (!decision) throw new CoreError("ACCESS_DENIED", "A separate exact native package source review is required.");
  let current = false;
  const prepareCurrent = async () => {
    current = false; await host.assertActionPackageDecisionCurrent(decision, signal); current = true;
  };
  await prepareCurrent();
  await admitLegacyActionPackage(storage, actor, {
    sourceRoot: decision.sourceRoot, sourcePath, expectedPackageSha256: decision.packageSha256,
    sourceProtocol: decision.sourceProtocol, authorityId: `native-package-source:${decision.decisionId}`,
    expectedSourceFilePin: decision.sourceFilePin, expectedSourceRootPin: decision.sourceRootPin,
    expectedSourceParentPin: decision.sourceParentPin, prepareCurrent,
    authorize(binding) {
      assertOriginalMcpNativeHost(host, storage);
      return current && decision.expiresAtMs > Date.now() && binding.actorId === actor.id
        && binding.workspaceId === decision.workspaceId && binding.workspaceRoot === decision.root
        && binding.sourcePath === sourcePath && binding.sourceRoot === decision.sourceRoot
        && binding.packageSha256 === decision.packageSha256 && "sourceProtocol" in binding
        && binding.sourceProtocol === decision.sourceProtocol;
    },
  });
}

export async function approveOriginalMcpActionPackageDestination(storage: Storage, host: OriginalMcpNativeHost,
  actor: Actor, input: { moduleSetId: string; version: number; actionIds: string[]; destination: string },
  bytes: Buffer, signal?: AbortSignal): Promise<{ refresh(): Promise<void>; assertCurrent(): void } | undefined> {
  assertOriginalMcpNativeHost(host, storage);
  if (!host.actionPackageApprovalAvailable) return undefined;
  const packageSha256 = createHash("sha256").update(bytes).digest("hex");
  const decision = await host.approveActionPackageDestination({ ...input, packageSha256, size: bytes.length }, signal);
  if (!decision) throw new CoreError("ACCESS_DENIED", "A separate exact native package destination review is required.");
  let current = false;
  const refresh = async () => {
    current = false; await host.assertActionPackageDecisionCurrent(decision, signal); current = true;
  };
  const assertCurrent = () => {
    assertOriginalMcpNativeHost(host, storage);
    if (!current || decision.expiresAtMs <= Date.now()
      || actionPackageParentPin(lstatSync(dirname(input.destination))) !== decision.parentPin)
      throw new CoreError("ACCESS_DENIED", "The native package destination grant changed.");
  };
  await refresh(); assertCurrent();
  await admitLegacyActionArtifactPath(storage, actor, {
    kind: "destination", selectedRoot: decision.selectedRoot, path: decision.destination,
    authorityId: `native-package-destination:${decision.decisionId}`, prepareCurrent: refresh,
    authorize(binding) {
      assertCurrent();
      return binding.actorId === actor.id && binding.workspaceId === decision.workspaceId
        && binding.workspaceRoot === decision.root && binding.path === decision.destination
        && binding.selectedRoot === decision.selectedRoot && binding.kind === "destination";
    },
  });
  return { refresh, assertCurrent };
}
