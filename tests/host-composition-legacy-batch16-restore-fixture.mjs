import { createHash } from "node:crypto";

// Only for isolated test fixtures whose independent owner knows their lineage.
export const nativeRestoreAuthority = {
  actorId: "disposable-fixture-owner",
  authorize(request) {
    return {
      authorityId: "disposable-fixture",
      actorId: request.actorId,
      requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
      expiresAt: Date.now() + 60_000,
      lineage: "unrelated",
      trustedEpoch: null,
    };
  },
};
