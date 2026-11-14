/** Source pins for the Batch14 oracle; changes require rerunning source-bound qualification. */
export const legacySnapshotRestoreSourcePins = Object.freeze({
  "src/agent-sessions/agent-snapshots.ts": "f5a17cc8f6ea00b9708e0e5a2bfa0484885ac0948737b9dc9d4184bfe3be7fa2",
  "src/agent-sessions/agent-session-lifecycle.ts": "0213d947184d24cadf6ac70a49d3efa7ca8beee8db64a1ee15291636df70e4b8",
  "resources/agent_session_runtime.py": "8ea17cbcb9207633f19ae5504f5afcfefd351d0829dae13f1a56f3fe736c0d5b",
  "src/chat/api-chat-store.ts": "0e9b9a0ddb502c0517c503b6a58634ecb27105bde9e2e6c160373a70f6063d86",
  "src/chat/api-chat-view.ts": "71ddd872aaf2e1fdf1a70616ebc4d50f03e4552152a6670b0e44cfcfdc2397e6",
  "src/chat/chat-budget-ledger.ts": "b8373370945fba369131b9d36d95bd72d96e10cd60b0958f8a00a2c40bac3d9a",
  "next-server/src/agent-runtime.ts": "0f2f8f733095574d8f2d2c7a0dfb1306da44a6e495d295cb7764963943f16585",
  "next-server/src/manager-runtime.ts": "f1fb84d411680628a95759c87403deed140ba3961679373d04ab3f846ae9611d",
  "next-server/src/chat-session-store.ts": "2ec00423522fb0430d7f985581779b74fd22e078e9e16fb64d2c88c5f3155ee0",
  "next-server/src/legacy-state-import.ts": "a3dd0b5236ce7fd2caa0675c157dd2fad7e55b66f52640af3e629698ef3bb039",
});
export const legacySnapshotRestoreSourceQualification = Object.freeze({
  oracle: "original continuationTodo + agentSnapshotRecovery, same fixture, fixed native-approved session/time/recovery key",
  chat: "original recoverAgentSnapshot user/assistant normalization, streaming interruption, tool failure, taskId remap",
  difference: "source recovery notice is not appended; validated original messages only; quiescent task status is paused",
  identities: "source ids/history/cipher preserved; target ids explicitly native-issued; deterministic Recipe ids are source clones, not worker identity claims",
  authority: "original Magic Code read-only recovery prompt; native approvals and key epochs are separate capabilities",
  originalTools: "register_agent_session_tools exposes capabilities/list/read only; checkpoint export/import/restore/spawn tools are retired, not implicit authority",
  trash: "restoreAgentSessionFromTrash permits PKM-owned records only; Batch14 is new-session Snapshot recovery, not adoption of external host ownership",
  unsupported: "original plans, delegation observations, raw auth/budget fields, unknown runtime fields explicitly blocked rather than filtered",
  effects: "original Recipe running nodes reset pending/receipts cleared is data-only; model/tool/process/collaboration outcome remains unknown",
});
