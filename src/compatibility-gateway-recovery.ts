import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { compatibilityGatewayRootDirectory } from "./compatibility-gateway-custody.js";
import { acquireLinuxRootWriterFence } from "./linux-root-writer-fence.js";
import { originalMcpPrivateBytes } from "./original-mcp-root-custody.js";
import { assertOriginalMcpBrokerDirectory } from "./original-mcp-relay.js";
import { acquireSharedManagerControlGuard } from "./shared-manager-control.js";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const pinSchema = z.strictObject({ pid: z.number().int().positive(),
  startTimeTicks: z.string().regex(/^\d+$/), bootId: z.uuid() });
const eventSchema = z.strictObject({ schema: z.literal("pkm.compatibility-recovery-event/v1"),
  owner: z.uuid(), id: z.uuid(), category: z.enum(["operation", "participant"]),
  label: z.string().min(1).max(256), process: pinSchema });
const endSchema = z.strictObject({ schema: z.literal("pkm.compatibility-recovery-event/v1"), owner: z.uuid(), id: z.uuid() });
const markerSchema = z.strictObject({ schema: z.literal("pkm.compatibility-gateway-custody/v1"),
  recoverySchema: z.literal("pkm.compatibility-recovery/v1"), owner: z.uuid(),
  root: z.string(), device: z.string(), inode: z.string(), process: pinSchema,
  launchGrantSha256: z.string().regex(/^[a-f0-9]{64}$/) });

/** Absence alone is insufficient: a different boot, replaced PID or unreadable procfs is not death proof. */
async function processState(pin: z.infer<typeof pinSchema>) {
  try {
    if ((await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() !== pin.bootId) return "unverifiable-boot";
    try {
      const owner = await lstat(`/proc/${pin.pid}`);
      if (owner.uid !== process.getuid!()) return "unverifiable-owner";
      const raw = await readFile(`/proc/${pin.pid}/stat`, "utf8"), close = raw.lastIndexOf(")");
      const fields = raw.slice(close + 1).trim().split(/\s+/);
      if (close < 0 || !/^\d+$/.test(fields[19] ?? "")) return "unverifiable-stat";
      if (fields[19] !== pin.startTimeTicks) return "replacement-pid";
      return fields[0] === "Z" ? "dead" : "live";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unverifiable-proc";
      try { process.kill(pin.pid, 0); return "unverifiable-proc"; }
      catch (probe) { return (probe as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unverifiable-proc"; }
    }
  } catch { return "unverifiable-proc"; }
}

/**
 * Read-only review. Results deliberately contain labels and hashes, not endpoint credentials
 * or tool arguments. Missing/old evidence must be investigated offline, never inferred clean.
 */
export async function inspectCompatibilityGatewayRecovery(root: string) {
  const { directory, identity } = await compatibilityGatewayRootDirectory(root);
  const entries = (await readdir(directory)).sort();
  const files: Record<string, string> = {};
  const read = (name: string, maximum = 16_384) => {
    const bytes = originalMcpPrivateBytes(join(directory, name), maximum);
    files[name] = hash(bytes);
    return JSON.parse(bytes.toString());
  };
  const parsed = markerSchema.safeParse(read("owner-pending.json", 4096));
  if (!parsed.success) throw new Error("Custody has missing/unsupported process or recovery evidence. Preserve it for owner-specific offline recovery; no marker was released.");
  const marker = parsed.data;
  if (marker.root !== root || marker.device !== String(identity.dev) || marker.inode !== String(identity.ino))
    throw new Error("Recovery root identity changed; no custody was released.");
  if (entries.includes("owner-live.json")) {
    const descriptor = read("owner-live.json");
    if (descriptor.schema !== "pkm.compatibility-gateway-owner/v1" || descriptor.root !== root
      || descriptor.device !== marker.device || descriptor.inode !== marker.inode
      || descriptor.custodySha256 !== files["owner-pending.json"]
      || JSON.stringify(pinSchema.parse(descriptor.process)) !== JSON.stringify(marker.process))
      throw new Error("Recovery descriptor binding is unverifiable; retain all evidence.");
  }
  const evidence = `evidence-${marker.owner}`;
  assertOriginalMcpBrokerDirectory(join(directory, evidence));
  const names = (await readdir(join(directory, evidence))).sort();
  const begins = new Map<string, z.infer<typeof eventSchema>>(), ends = new Set<string>();
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.(begin|end)\.json$/.test(name)) throw new Error("Unrecognized recovery evidence; retain it for offline review.");
    const value = read(`${evidence}/${name}`, 4096);
    if (name.endsWith(".begin.json")) {
      const event = eventSchema.parse(value);
      if (event.owner !== marker.owner || name !== `${event.id}.begin.json`) throw new Error("Recovery event binding changed.");
      begins.set(event.id, event);
    } else {
      const event = endSchema.parse(value);
      if (event.owner !== marker.owner || name !== `${event.id}.end.json`) throw new Error("Recovery terminal binding changed.");
      ends.add(event.id);
    }
  }
  if ([...ends].some(id => !begins.has(id))) throw new Error("Recovery terminal has no admission evidence.");
  const outstanding = [...begins.values()].filter(event => !ends.has(event.id));
  const processes = await Promise.all([{ label: "custody-owner", process: marker.process },
    ...outstanding.filter(event => event.category === "participant")].map(async event => ({
    label: event.label, process: event.process, state: await processState(event.process),
  })));
  const unresolved = outstanding.filter(event => event.category === "operation")
    .map(({ id, label }) => ({ id, label, evidence: join(directory, evidence, `${id}.begin.json`) }));
  const blockers = entries.filter(name => /^(?:original|cold)-pending-/.test(name));
  // Hash all competing admission markers, so even refused reports are exact reviews.
  for (const name of blockers) read(name, 4096);
  const stateEntries = await readdir(join(root, ".pkm/state"));
  for (const name of ["managed-writer-session", "managed-writer-session-compatible", "managed-writer-session.lock"]) {
    if (stateEntries.includes(name)) blockers.push(`../${name}`);
  }
  const reasons = [
    ...processes.filter(item => item.state !== "dead").map(item => `${item.label}: ${item.state} (PID ${item.process.pid})`),
    ...unresolved.map(item => `Unresolved operation ${item.id}: ${item.label}. Inspect ${item.evidence}; establish its actual outcome offline. Do not retry/replay.`),
    ...blockers.map(name => `Independent writer evidence ${name} requires its own verified manual resolution; this command cannot clear or resolve native writer-session journals.`),
  ];
  return { schema: "pkm.compatibility-recovery-review/v1" as const, root, owner: marker.owner,
    device: marker.device, inode: marker.inode, processes, unresolved, blockers, files,
    reviewSha256: hash(JSON.stringify({ root, device: marker.device, inode: marker.inode, files, processes, unresolved, blockers })),
    recoverable: reasons.length === 0, reasons, automaticReplay: false };
}

async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}

/** Exact confirmation is revalidated under both kernel guards; release is a final atomic marker archive. */
export async function recoverCompatibilityGateway(root: string, reviewSha256: string) {
  if (!/^[a-f0-9]{64}$/.test(reviewSha256)) throw new Error("An explicit inspect review SHA-256 confirmation is required.");
  const { directory } = await compatibilityGatewayRootDirectory(root);
  const guard = await acquireSharedManagerControlGuard(join(directory, "owner.guard"));
  let fence: Awaited<ReturnType<typeof acquireLinuxRootWriterFence>> | undefined;
  try {
    const check = async () => {
      guard.assertHeld(); fence?.assertHeld();
      const review = await inspectCompatibilityGatewayRecovery(root);
      if (review.reviewSha256 !== reviewSha256) throw new Error("Recovery review changed; inspect and confirm again.");
      if (!review.recoverable) throw new Error(`Recovery refused:\n${review.reasons.join("\n")}`);
      return review;
    };
    await check();
    fence = await acquireLinuxRootWriterFence(root, 1_000);
    const review = await check();
    const archive = join(directory, `recovered-${review.owner}-${randomUUID()}`);
    await mkdir(archive, { mode: 0o700 });
    const receipt = await open(join(archive, "review.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await receipt.writeFile(JSON.stringify(review, null, 2)); await receipt.sync(); } finally { await receipt.close(); }
    await syncDirectory(archive);
    await syncDirectory(directory);
    // Recheck after all asynchronous preparation. The original evidence directory is retained.
    await check();
    if (review.files["owner-live.json"]) await rename(join(directory, "owner-live.json"), join(archive, "owner-live.json"));
    await syncDirectory(archive);
    await syncDirectory(directory);
    guard.assertHeld(); fence.assertHeld();
    await rename(join(directory, "owner-pending.json"), join(archive, "owner-pending.json"));
    await syncDirectory(archive);
    await syncDirectory(directory);
    return { recovered: true, archive, reviewSha256, automaticReplay: false };
  } finally { try { await fence?.release(); } finally { await guard.release(); } }
}
