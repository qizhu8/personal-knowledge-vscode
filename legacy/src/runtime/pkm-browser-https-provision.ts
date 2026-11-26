import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID, X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import { isIP } from "node:net";
import { PkmServiceClient, pkmServiceIdentity, withPkmServiceLifecycleLock, type PkmServiceBootOptions } from "./pkm-service";
import { PKM_SERVICE_TRANSCRIPT_PROVISION, type PkmServiceTranscriptProvision } from "./pkm-service-browser-transcript";
import { withCrossProcessLock } from "./cross-process-lock";

export async function provisionBrowserHttps(options: PkmServiceBootOptions,
  provision: PkmServiceTranscriptProvision, assertCurrent: () => void): Promise<void> {
  const identity = pkmServiceIdentity(options);
  if (provision.serviceIdentity !== identity.identity || provision.root !== identity.knowledgeRoot)
    throw new Error("The HTTPS service does not match the selected PKM account and Knowledge Root.");
  const origin = new URL(provision.httpsOrigin);
  const root = fs.lstatSync(identity.knowledgeRoot);
  if (!root.isDirectory() || root.dev !== provision.rootDevice || root.ino !== provision.rootInode ||
      !isIP(provision.address) || ["0.0.0.0", "::"].includes(provision.address) ||
      !Number.isInteger(provision.port) || provision.port < 1 || provision.port > 65535 ||
      Number(origin.port || 443) !== provision.port || !/^[A-Za-z0-9_-]{43}$/.test(provision.token))
    throw new Error("The HTTPS binding has an invalid root, interface, port or sign-in credential.");
  const certificate = new X509Certificate(provision.cert);
  const hostname = origin.hostname.replace(/^\[|\]$/g, "");
  if (origin.protocol !== "https:" || origin.origin !== provision.httpsOrigin ||
      !(isIP(hostname) ? certificate.checkIP(hostname) : certificate.checkHost(hostname, { subject: "default" })))
    throw new Error("The TLS certificate must identify the exact HTTPS hostname.");
  const now = Date.now();
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now)
    throw new Error("The TLS certificate is not currently valid.");
  createSecureContext({ cert: provision.cert, key: provision.key, minVersion: "TLSv1.2" });
  const serialized = JSON.stringify(provision);
  if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error("The HTTPS service authorization exceeds its private provision limit.");
  fs.mkdirSync(identity.serviceDirectory, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(identity.serviceDirectory);
  if (!directory.isDirectory() || fs.realpathSync(identity.serviceDirectory) !== identity.serviceDirectory ||
      directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
    throw new Error("The PKM service directory must be private and owned by this account.");
  const clientOptions = { ...options, execute: async () => { throw new Error("The browser setup client cannot execute GitHub Sync."); } };
  await withCrossProcessLock(path.join(identity.serviceDirectory, "browser-setup.lock"), "PKM HTTPS setup", 5_000, async () => {
    assertCurrent();
    const file = path.join(identity.serviceDirectory, PKM_SERVICE_TRANSCRIPT_PROVISION);
    if (fs.existsSync(file)) throw new Error("Revoke the existing HTTPS browser access before configuring a new one.");
    const client = await PkmServiceClient.connect(clientOptions);
    try {
      await withPkmServiceLifecycleLock(options, async () => {
        await client.drain();
        assertCurrent();
        const temporary = path.join(identity.serviceDirectory, `browser-${randomUUID()}.tmp`);
        try {
          const descriptor = fs.openSync(temporary, "wx", 0o600);
          try { fs.writeFileSync(descriptor, serialized); fs.fsyncSync(descriptor); }
          finally { fs.closeSync(descriptor); }
          fs.linkSync(temporary, file);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      });
    } finally { client.dispose(); }
    // The normal singleton handshake waits for the old daemon to exit before restarting.
    const pinned = fs.lstatSync(file);
    try {
      const ready = await PkmServiceClient.connect(clientOptions);
      try {
        assertCurrent();
        const current = fs.lstatSync(file);
        if (current.dev !== pinned.dev || current.ino !== pinned.ino || current.ctimeMs !== pinned.ctimeMs)
          throw new Error("HTTPS access was revoked or replaced during startup.");
      } finally { ready.dispose(); }
    } catch (error) {
      let current: fs.Stats | undefined;
      try { current = fs.lstatSync(file); }
      catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError; }
      if (current && (current.dev !== pinned.dev || current.ino !== pinned.ino))
        throw new Error("HTTPS startup failed and the provision changed; revoke it before retrying setup.");
      if (current) fs.unlinkSync(file);
      throw error;
    }
  });
}

export async function revokeBrowserHttps(options: PkmServiceBootOptions): Promise<void> {
  const identity = pkmServiceIdentity(options);
  const file = path.join(identity.serviceDirectory, PKM_SERVICE_TRANSCRIPT_PROVISION);
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0) throw new Error("The browser provision has unsafe ownership or permissions.");
  fs.unlinkSync(file);
}
