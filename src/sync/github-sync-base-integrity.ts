import { createHash } from "crypto";

const digest = (content: Buffer): string => createHash("sha256").update(content).digest("hex");

export interface GitHubSyncBaseEvidence {
  commit: string;
  manifestDigest: string;
  blobDigest: string;
  comparisonDigest: string;
  reason: "verified-line-endings";
}

/** Historical Base only. Latest Remote must continue using byte-strict validation. */
export function verifyGitHubSyncBaseDigest(commit: string, relative: string, expected: string, content: Buffer):
  { digest: string; evidence?: GitHubSyncBaseEvidence } {
  const actual = digest(content);
  if (!expected || expected === actual) return { digest: actual };
  const text = content.toString("utf8");
  if (!content.includes(0) && Buffer.from(text, "utf8").equals(content)) {
    const lf = Buffer.from(text.replace(/\r\n/g, "\n"), "utf8");
    const crlf = Buffer.from(lf.toString("utf8").replace(/\n/g, "\r\n"), "utf8");
    // Only a proven hash of the same text with uniform LF/CRLF is compatible.
    if (expected === digest(lf) || expected === digest(crlf)) {
      const comparisonDigest = digest(lf);
      return { digest: comparisonDigest, evidence: {
        commit, manifestDigest: expected, blobDigest: actual, comparisonDigest, reason: "verified-line-endings",
      } };
    }
  }
  throw new Error(`Base manifest digest does not match the blob at ${commit}: ${relative}`);
}
