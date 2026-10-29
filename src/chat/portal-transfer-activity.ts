import type { PortalTransferStatus } from "../chatroom/portal-files";

export interface PortalTransferRecord extends PortalTransferStatus {
  peerName: string;
  startedAt: string;
  updatedAt: string;
}

export const PORTAL_TRANSFER_RECORD_LIMIT = 50;
const STATES = ["awaiting-approval", "offered", "transferring", "completed", "cancelled", "failed"];
const TERMINAL = new Set(["completed", "cancelled", "failed"]);

export function recordPortalTransfer(records: PortalTransferRecord[] | undefined, status: PortalTransferStatus, peerName: string, now = new Date()): PortalTransferRecord[] {
  const list = (records || []).slice();
  const index = list.findIndex(record => record.transferId === status.transferId);
  const prior = list[index];
  if (prior && TERMINAL.has(prior.state)) return list;
  const record: PortalTransferRecord = {
    ...status,
    files: status.files.map(file => ({ ...file })),
    ...(status.reason !== undefined ? { reason: status.reason.slice(0, 500) } : {}),
    ...(status.savedPaths ? { savedPaths: status.savedPaths.map(entry => entry.slice(0, 4096)) } : {}),
    ...(status.verifiedFiles ? { verifiedFiles: status.verifiedFiles.map(file => ({ ...file })) } : {}),
    peerName: peerName.slice(0, 200),
    startedAt: prior?.startedAt || now.toISOString(),
    updatedAt: now.toISOString(),
  };
  if (index >= 0) list[index] = record; else list.push(record);
  return list.slice(-PORTAL_TRANSFER_RECORD_LIMIT);
}

export function validPortalTransferRecords(value: unknown): value is PortalTransferRecord[] {
  return Array.isArray(value) && value.length <= PORTAL_TRANSFER_RECORD_LIMIT && value.every(item => {
    if (!item || typeof item !== "object") return false;
    const files = (input: unknown): boolean => Array.isArray(input) && input.length <= 64 && input.every(file =>
      !!file && typeof file === "object" && typeof file.name === "string" && file.name.length <= 255
      && Number.isSafeInteger(file.size) && file.size >= 0 && /^[a-f0-9]{64}$/.test(file.sha256));
    return /^[a-f0-9-]{36}$/.test(item.transferId) && ["incoming", "outgoing"].includes(item.direction)
      && STATES.includes(item.state) && typeof item.peerName === "string" && item.peerName.length <= 200
      && Number.isSafeInteger(item.bytes) && item.bytes >= 0
      && Number.isSafeInteger(item.totalBytes) && item.totalBytes >= item.bytes
      && files(item.files) && (item.verifiedFiles === undefined || item.state === "completed" && files(item.verifiedFiles))
      && (item.reason === undefined || typeof item.reason === "string" && item.reason.length <= 500)
      && (item.savedPaths === undefined || Array.isArray(item.savedPaths) && item.savedPaths.length <= 64
        && item.savedPaths.every((entry: unknown) => typeof entry === "string" && entry.length <= 4096))
      && typeof item.startedAt === "string" && Number.isFinite(Date.parse(item.startedAt))
      && typeof item.updatedAt === "string" && Number.isFinite(Date.parse(item.updatedAt));
  }) && new Set(value.map(item => item.transferId)).size === value.length;
}
