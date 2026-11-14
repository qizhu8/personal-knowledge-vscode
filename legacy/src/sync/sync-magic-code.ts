import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

export interface SyncMagicCodeCredentials {
  syncUrl: string;
  username: string;
  password: string;
}

const magicCodeKey = createHash("sha256").update("uone", "utf8").digest();

export function createSyncMagicCode(session: { url: string; username: string; password: string }): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", magicCodeKey, iv);
  const plaintext = Buffer.from(JSON.stringify({ v: 3, u: session.url, n: session.username, p: session.password }), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const body = `${iv.toString("base64url")}.${encrypted.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  const checksum = createHash("sha256").update(body, "utf8").digest("base64url").slice(0, 16);
  return `pk:v3:${body}.${checksum}`;
}

export function parseSyncMagicCode(value: unknown): SyncMagicCodeCredentials {
  const raw = String(value || "").trim();
  if (!raw.startsWith("pk:")) throw new Error("Magic Code must start with 'pk:'.");
  if (!raw.startsWith("pk:v3:")) throw new Error("This legacy Magic Code is not encrypted. Ask the host to generate a new one.");
  const match = /^pk:v3:([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{16})$/.exec(raw);
  if (!match) throw new Error("Magic Code format is invalid or incomplete.");
  const [, ivText, encryptedText, authTagText, suppliedChecksum] = match;
  const body = `${ivText}.${encryptedText}.${authTagText}`;
  const expectedChecksum = createHash("sha256").update(body, "utf8").digest("base64url").slice(0, 16);
  if (suppliedChecksum !== expectedChecksum) throw new Error("Magic Code checksum failed. It may have been copied incorrectly.");

  let decoded: any;
  try {
    const decipher = createDecipheriv("aes-256-gcm", magicCodeKey, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(authTagText, "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]);
    decoded = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("Magic Code authentication failed. It may be corrupted or incompatible.");
  }

  const syncUrl = String(decoded?.u || decoded?.url || "").trim().replace(/\/$/, "");
  const username = String(decoded?.n || decoded?.username || "").trim();
  const password = String(decoded?.p || decoded?.password || "").trim();
  let parsedUrl: URL;
  try { parsedUrl = new URL(syncUrl); } catch { throw new Error("Magic Code contains an invalid URL."); }
  if ((parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") || !username || !password) {
    throw new Error("Magic Code is missing valid connection credentials.");
  }
  return { syncUrl, username, password };
}