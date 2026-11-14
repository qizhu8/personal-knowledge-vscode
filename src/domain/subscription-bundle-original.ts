// @ts-nocheck
// Generated executable original cryptographic helpers; regenerate with capture-subscription-bundle.mjs.
import { createHash, createHmac, scryptSync, randomBytes, createCipheriv, createDecipheriv, verify } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
export function hash(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
export function deriveSecretKeys(secret, salt) {
    const base = scryptSync(secret, Buffer.from(salt, "base64url"), 32);
    return {
        authVerifier: createHmac("sha256", base).update("pkm-share-auth:v1").digest(),
        contentKey: createHmac("sha256", base).update("pkm-share-content:v1").digest(),
    };
}
export function encryptSnapshot(plaintext, key) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.from(JSON.stringify({ v: 1, alg: "A256GCM", iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") }));
}
export function nodeIdForPublicKey(publicKey) { return hash(Buffer.from(publicKey)).slice("sha256:".length); }
export function withoutSignature(value) {
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
export function decryptTransfer(bytes, keyValue) {
    if (bytes.length < 36 || bytes.subarray(0, 8).toString("ascii") !== "PKMENC1\n") {
        throw new Error("Secret Protected Broker returned an invalid encrypted transfer.");
    }
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyValue, "base64url"), bytes.subarray(8, 20));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return Buffer.concat([decipher.update(bytes.subarray(20, bytes.length - 16)), decipher.final()]);
}
export function decryptSnapshot(envelope, keyValue) {
    const parsed = JSON.parse(envelope.toString("utf8"));
    if (parsed?.v !== 1 || parsed?.alg !== "A256GCM")
        throw new Error("Encrypted Sync snapshot format is invalid.");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyValue, "base64url"), Buffer.from(parsed.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext, "base64url")), decipher.final()]);
}
export function forkPackage(storeRoot, source) {
    const pkg = source.package;
    const packagesRoot = path.resolve(storeRoot, "packages");
    const cleanName = (value, fallback) => value.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
    const originalName = cleanName(pkg.name, "package");
    const brokerName = cleanName(source.brokerName, "Broker");
    const baseName = `${originalName}_${brokerName}`;
    let targetName = baseName;
    let suffix = 0;
    while (fs.existsSync(path.join(packagesRoot, targetName)))
        targetName = `${baseName}${++suffix}`;
    const target = safeTarget(packagesRoot, targetName);
    const checked = pkg.files.map(file => ({ ...file, target: safeTarget(target, file.path) }));
    const staging = safeTarget(packagesRoot, `.${targetName}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
        for (const file of checked) {
            const staged = path.join(staging, path.relative(target, file.target));
            fs.mkdirSync(path.dirname(staged), { recursive: true });
            fs.writeFileSync(staged, file.content, "utf8");
        }
        fs.mkdirSync(staging, { recursive: true });
        fs.writeFileSync(path.join(staging, ".pkm-package.json"), JSON.stringify({
            schema: 1,
            kind: "subscription-fork",
            originalName: pkg.name,
            brokerName: source.brokerName,
            publisherUser: source.publisherUser,
            publisherHost: source.publisherHost,
        }, null, 2) + "\n", "utf8");
        fs.mkdirSync(packagesRoot, { recursive: true });
        fs.renameSync(staging, target);
    }
    catch (error) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw error;
    }
    return relativeDisplay(storeRoot, target);
}
export function safeTarget(root, ...relativeParts) {
    const segments = relativeParts.flatMap(part => part.replace(/\\/g, "/").split("/"));
    if (segments.some(segment => !segment || segment === "." || segment === ".."))
        throw new Error("Fork source contains an unsafe path.");
    const target = path.resolve(root, ...segments);
    if (!target.startsWith(path.resolve(root) + path.sep))
        throw new Error("Fork target escapes the Knowledge Root.");
    return target;
}
export function relativeDisplay(storeRoot, target) {
    return path.relative(storeRoot, target).replace(/\\/g, "/");
}
