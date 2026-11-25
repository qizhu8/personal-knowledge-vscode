import * as vscode from "vscode";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import {
  actionPackageParentPin, actionPackageSourcePin, nativeActionPackageSourceDecision,
  nativeActionPackageDestinationDecision, nativeActionPackageMethods, parseNativeActionPackagePayload,
  type NativeActionPackageMethod,
} from "../../src/original-mcp-action-package-native-contracts.js";
import { nativeActionModuleSourceProtocol } from "../../src/action-module-bytes.js";
import { decodeLegacyActionPackage, readBoundedActionPackageFile } from "../../src/legacy-action-package.js";
import { originalDigest } from "../../src/domain/action-compiler-validation.js";
import type { OriginalNativeActionSession } from "../../src/original-mcp-native-action-contracts.js";

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
export function createOriginalMcpNativeActionPackageProducer(options: {
  session: OriginalNativeActionSession;
  assertCurrent(signal: AbortSignal): void;
  approve(title: string, detail: object, signal: AbortSignal): Promise<boolean>;
}) {
  const session = options.session;
  const decisions = new Map<string, { purpose: "source" | "destination"; requestSha256: string; expiresAtMs: number }>();
  const wait = <T>(work: Thenable<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("NATIVE_PACKAGE_CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
  const parent = (path: string) => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) fail("NATIVE_PACKAGE_UNSAFE_PARENT");
    return stat;
  };
  const common = (input: unknown) => ({
    root: session.binding.root, workspaceId: session.binding.workspaceId, profileSha256: session.binding.profileSha256,
    actorId: "mcp:external" as const, epoch: session.epoch, decisionId: randomUUID(),
    requestSha256: originalDigest(input), expiresAtMs: Date.now() + 300000,
  });
  return Object.freeze({
    methods: nativeActionPackageMethods,
    revoke() { decisions.clear(); },
    async handle(method: NativeActionPackageMethod, input: unknown, signal: AbortSignal) {
      options.assertCurrent(signal);
      const payload = parseNativeActionPackagePayload(method, input, session);
      for (const [id, value] of decisions) if (value.expiresAtMs <= Date.now()) decisions.delete(id);
      if (method === "action.package.decision.current") {
        const request = payload as ReturnType<typeof parseNativeActionPackagePayload<"action.package.decision.current">>;
        const value = decisions.get(request.decisionId);
        return { current: !!value && value.purpose === request.purpose && value.requestSha256 === request.requestSha256 };
      }
      if (decisions.size >= 4096) fail("NATIVE_PACKAGE_DECISION_LEDGER_FULL");
      if (method === "action.package.source.approve") {
        const request = payload as ReturnType<typeof parseNativeActionPackagePayload<"action.package.source.approve">>;
        const selected = await wait(vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false,
          canSelectMany: false, defaultUri: vscode.Uri.file(request.sourcePath),
          title: "Review this exact Action ModuleSet package as source only" }), signal);
        options.assertCurrent(signal);
        if (!selected?.length) return null;
        if (selected.length !== 1 || selected[0]!.fsPath !== request.sourcePath) fail("NATIVE_PACKAGE_SELECTED_PATH_MISMATCH");
        const sourceRoot = dirname(request.sourcePath), root = parent(sourceRoot), before = lstatSync(request.sourcePath);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 32 * 1024 * 1024
          || realpathSync(request.sourcePath) !== request.sourcePath) fail("NATIVE_PACKAGE_UNSAFE_SOURCE");
        const descriptor = openSync(request.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let bytes: Buffer;
        try {
          if (actionPackageSourcePin(fstatSync(descriptor)) !== actionPackageSourcePin(before)) fail("NATIVE_PACKAGE_SOURCE_CHANGED");
          bytes = readBoundedActionPackageFile(descriptor, before.size);
          if (actionPackageSourcePin(fstatSync(descriptor)) !== actionPackageSourcePin(before)
            || actionPackageSourcePin(lstatSync(request.sourcePath)) !== actionPackageSourcePin(before))
            fail("NATIVE_PACKAGE_SOURCE_CHANGED");
        } finally { closeSync(descriptor); }
        const source = decodeLegacyActionPackage(bytes), packageSha256 = createHash("sha256").update(bytes).digest("hex");
        const allowed = await options.approve("Admit this exact reviewed ModuleSet package without execution?", {
          purpose: "Native package source custody only. This does not register, execute or qualify its Actions or inherit old process/path grants.",
          sourcePath: request.sourcePath, archiveSha256: packageSha256, size: bytes.length, manifest: source.manifest,
        }, signal);
        options.assertCurrent(signal);
        if (!allowed) return null;
        if (actionPackageSourcePin(lstatSync(request.sourcePath)) !== actionPackageSourcePin(before)
          || actionPackageParentPin(parent(sourceRoot)) !== actionPackageParentPin(root)) fail("NATIVE_PACKAGE_SOURCE_CHANGED");
        const result = nativeActionPackageSourceDecision.parse({ ...common(payload),
          schema: "pkm.native-action-package-source-decision/v1", scope: "native-action-package-source/v2", noExecution: true,
          sourcePath: request.sourcePath, sourceRoot, sourceFilePin: actionPackageSourcePin(before),
          sourceRootPin: `${root.dev}:${root.ino}`, sourceParentPin: actionPackageParentPin(root),
          packageSha256, size: bytes.length, sourceProtocol: nativeActionModuleSourceProtocol,
        });
        decisions.set(result.decisionId, { purpose: "source", requestSha256: result.requestSha256, expiresAtMs: result.expiresAtMs });
        return result;
      }
      const request = payload as ReturnType<typeof parseNativeActionPackagePayload<"action.package.destination.approve">>;
      const selected = await wait(vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(request.destination),
        title: "Approve this exact new Action ModuleSet package destination" }), signal);
      options.assertCurrent(signal);
      if (!selected) return null;
      if (selected.fsPath !== request.destination) fail("NATIVE_PACKAGE_SELECTED_PATH_MISMATCH");
      const selectedRoot = dirname(request.destination), before = parent(selectedRoot);
      if (lstatSync(request.destination, { throwIfNoEntry: false })) fail("NATIVE_PACKAGE_DESTINATION_EXISTS");
      if (!await options.approve("Publish this exact package to this one new destination?", {
        purpose: "One native package file write of the selected declared resources, which may contain reviewed private source bytes. No artifact, execution or other destination grant.",
        destination: request.destination, packageSha256: request.packageSha256, size: request.size,
        moduleSetId: request.moduleSetId, version: request.version, actionIds: request.actionIds,
      }, signal)) return null;
      options.assertCurrent(signal);
      if (lstatSync(request.destination, { throwIfNoEntry: false })
        || actionPackageParentPin(parent(selectedRoot)) !== actionPackageParentPin(before)) fail("NATIVE_PACKAGE_DESTINATION_CHANGED");
      const result = nativeActionPackageDestinationDecision.parse({ ...common(payload),
        schema: "pkm.native-action-package-destination-decision/v1", scope: "native-action-package-destination/v1",
        destination: request.destination, selectedRoot, parentPin: actionPackageParentPin(before),
        packageSha256: request.packageSha256, size: request.size,
      });
      decisions.set(result.decisionId, { purpose: "destination", requestSha256: result.requestSha256, expiresAtMs: result.expiresAtMs });
      return result;
    },
  });
}
