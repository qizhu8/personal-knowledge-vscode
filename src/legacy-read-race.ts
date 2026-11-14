import { createHash } from "node:crypto";
import { CoreError } from "./contracts.js";

export interface LegacyReadPin {
  area: string;
  path: string;
  identity: string;
  revision: string;
  sha256: string;
}

export interface LegacyReadSnapshot {
  schema: "pkm.legacy-read-snapshot/v1";
  digest: string;
  pins: readonly Readonly<LegacyReadPin>[];
}

export type LegacyReadSnapshotSource = () => Promise<LegacyReadSnapshot> | LegacyReadSnapshot;

const digestPattern = /^[a-f0-9]{64}$/;

export function createLegacyReadSnapshot(pins: readonly LegacyReadPin[]): LegacyReadSnapshot {
  const ordered = [...pins].map(pin => {
    if (!pin || typeof pin.area !== "string" || !pin.area || typeof pin.path !== "string" || !pin.path ||
      typeof pin.identity !== "string" || !pin.identity || typeof pin.revision !== "string" || !pin.revision ||
      !digestPattern.test(pin.sha256)) {
      throw new CoreError("INVALID_ARGUMENT", "A legacy read pin must include its area, path, identity, revision, and SHA256.");
    }
    return Object.freeze({ ...pin });
  }).sort((left, right) => Buffer.compare(
    Buffer.from(`${left.area}/${left.path}\0${left.identity}`),
    Buffer.from(`${right.area}/${right.path}\0${right.identity}`),
  ));
  const keys = new Set<string>();
  for (const pin of ordered) {
    const key = `${pin.area}/${pin.path}\0${pin.identity}`;
    if (keys.has(key)) throw new CoreError("CONFLICT", "A legacy read snapshot contains a duplicate source identity.");
    keys.add(key);
  }
  const canonical = JSON.stringify(ordered.map(pin => [pin.area, pin.path, pin.identity, pin.revision, pin.sha256]));
  return Object.freeze({
    schema: "pkm.legacy-read-snapshot/v1",
    digest: createHash("sha256").update(canonical, "utf8").digest("hex"),
    pins: Object.freeze(ordered),
  });
}

export function assertLegacyReadSnapshot(
  expected: LegacyReadSnapshot,
  actual: LegacyReadSnapshot,
  phase: "preflight" | "postflight" = "postflight",
): void {
  if (expected.schema !== "pkm.legacy-read-snapshot/v1" || actual.schema !== expected.schema ||
    !digestPattern.test(expected.digest) || !digestPattern.test(actual.digest) || expected.digest !== actual.digest) {
    throw new CoreError("CONFLICT", `Knowledge changed during ${phase}; retry the read from its first page.`);
  }
}

/**
 * Guards an existing read seam with caller-supplied source pins. This detects
 * observed changes; it is not a filesystem lock or an atomic cross-process snapshot.
 */
export async function withLegacyReadPreflight<T>(
  capture: LegacyReadSnapshotSource,
  read: () => Promise<T>,
): Promise<T> {
  const before = await capture();
  let value: T;
  try {
    value = await read();
  } catch (error) {
    const after = await captureAfterRead(capture);
    assertLegacyReadSnapshot(before, after);
    throw error;
  }
  const after = await captureAfterRead(capture);
  assertLegacyReadSnapshot(before, after);
  return value;
}

async function captureAfterRead(capture: LegacyReadSnapshotSource): Promise<LegacyReadSnapshot> {
  try {
    return await capture();
  } catch {
    throw new CoreError("CONFLICT", "Knowledge changed during read; retry from its first page.");
  }
}
