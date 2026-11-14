// @ts-nocheck
// Repeatable original executable signature verification capture.
import { createHash, verify } from 'node:crypto';
function hash(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function nodeIdForPublicKey(publicKey) { return hash(Buffer.from(publicKey)).slice("sha256:".length); }
function withoutSignature(value) {
    const { signature: _signature, ...unsigned } = value;
    return unsigned;
}
export function verifyShareSummary(summary, publicKey, nodeId, shareId) {
    if (nodeIdForPublicKey(publicKey) !== nodeId || summary.shareId !== shareId || summary.metadataOnly !== true)
        throw new Error("Share summary identity is invalid.");
    const serialized = JSON.stringify(withoutSignature(summary));
    if (!verify(null, Buffer.from(serialized), publicKey, Buffer.from(summary.signature, "base64url")))
        throw new Error("Share summary signature is invalid.");
    if (summary.content !== undefined || summary.items !== undefined)
        throw new Error("Control summary must not contain shared content.");
}
