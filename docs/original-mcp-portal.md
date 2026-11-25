# Original public Portal protocol

`mcp.tool.portal_control` uses the original asynchronous Host/request/context
contract, not `portal.lifecycle.*`. The public dispatcher, MCP facade and native
consent transport share one server-owned Portal runtime and canonical RootOwner.

The runtime bundles and reuses the existing `PortalRelay`, `ChatClient`,
`PeerSession`, `PortalFiles`, route selector and private-link parser. Native VS Code
only supplies local decisions and private pairing-code input/clipboard actions;
it does not own the peer protocol or proxy arbitrary remote commands.

## Safety and custody

- Select the exact current native Host. Every public call requires its own native
  approval; external access, pairing, executing commands/tasks, role changes and
  each file batch require independent local decisions.
- Temporary credentials remain in the live connection and private native
  transport. No pairing code, bearer, task result or connection history is
  persisted in the public receipt database.
- Existing immutable `original_api_chat_requests` and request-state tables hold
  command identity, digest and status only. Python-compatible request identifiers
  and payload fingerprints retain the original protocol. An archived identity
  cannot be reused.
- Interrupted or detached receipts become `outcome_unknown`; duplicate identities
  inspect existing receipts and never call the peer again. Reconnect uses the
  original two-minute live-connection grace, not task replay.
- Linux process execution uses the existing native process service with an empty
  environment, exact per-command executing-side approval and bounded output.
  Executable/directory descriptor custody and process-group cancellation use
  the existing native launch path.
  The original explicit 1–86400-second command deadline is available only through
  the native Portal authority; ordinary process-service limits remain unchanged.
- File delivery uses the original manifest/hash/size/no-overwrite protocol.
  Offering a batch is not delivery, indexing or installation.
- RootOwner retains the runtime and drains cancellation before releasing its
  lease. Revocation clears live connections and does not restore credentials.

## Qualification boundary

The isolated regression exercises the actual public facade, signed native
transport, two real owned loopback Portal peers, actual controlled native process
execution, command denial/deduplication, cancellation, changed context, immutable
unknown receipts and verified per-batch file delivery. Fixture UI decisions are
explicitly synthetic; they are not installed VS Code or external-account proof.

| Operation | Native business adapter |
| --- | --- |
| `open`, `connections`, `status` | Temporary and named connections use the original endpoint store. Native workspace-prefixed Memento/SecretStorage isolates current pairing from archived credentials. Inventory is metadata-only; reconnect independently approves current endpoint/revision/credential custody and never replays work. |
| `command`, `route`, `get`, `cancel`, `disconnect`, `switch` | Existing peer handlers execute with current direction/capability/approval guards. |
| `files` | Existing verified batch engine; permission requests are independent. |
| `permissions` | Fixed-deadline connection dimensions filter native Task tools before Core effects, in addition to current model, Task and exact native tool approval. Read-only cannot authorize writes/code; unknown tool dimensions require explicit unscoped All. File batches remain separate. |
| `send` | Existing source-admitted native Chat/Task/model execution starts an explicitly NEW Task, including on an already managed Chat. Separate native approval pins the previous Task/revision/attempt/goal digest. Only a reconciled terminal binding may retire; old goals, inputs, Harness, replies and receipts remain intact. UNKNOWN cannot be replaced. |
| `attempts` | The actual original helper shares only service-issued original reply links and explicitly confirmed manual predecessor links. It never runs a model. `personalKnowledge.originalPortalTaskRerun` independently approves a NEW same-Task attempt with fresh native model/Task/tool gates; live intents are consumed once, expire in two minutes and cannot replay after restart. Local outcome notifications reference actual receipts. |

`personalKnowledge.originalPortalEndpointSettings` configures current named
endpoints. Changed/deleted source is checked every 500 ms, invalidates grants and
cancels old execution. Authenticated presence is required for connected status.
There are at most 32 live connections, eight queued manual intents per workspace
and 128 live Task references; the original sharing helper returns at most 16
attempt metadata entries and 8000-byte result content. These bounds do not delete
durable Task history.

The model/Task regression uses two actual public native Hosts, the signed native
request/execution transport and actual Core Note/Harness/Goal operations with an
explicitly synthetic deterministic model vendor and UI decisions. It is not
installed VS Code LM, remote account or production hot-switch qualification.
Task sends require an existing current native-created or independently adopted
text Chat and preserve the native Task engine's bounded context/model gates.
They cannot implicitly adopt an archived Goal, credentials or image/worker state.

The default native bootstrap declares only the Task semantic tools `session_info`,
`record_harness` and `report_work`, not a general document/file/process catalogue.
All three require a fresh exact native tool review and effect approval. They use
the Original `progress-read` connection dimension: recording Harness/work state
is a Task semantic mutation, not proof of file or knowledge write permission.
Separately supplied general tools retain their own dimension and authority gates;
the default reviewer does not admit other operations without that catalogue.
If native execution fails before a reply exists, Portal preserves the underlying
native failure rather than replacing it with an unavailable attempt projection.
The original receipt, prepared Task and UNKNOWN/no-replay fences remain intact.

There is no canonical DDL, record-version or historical schema relaxation:
schema SHA256 remains `21ccb53a2f9bb10064507ce822b516998d5db81310c6ffcbb8997e790e0c01fa`
(129 tables). New optional native guards and transcript `metadata.planning`
lineage are stored in existing records; absent old metadata is never reconstructed
as authority. Retired Task rows use the existing cancelled status. Unknown effects,
unanswered tool intents and old receipts remain fenced.
New native-method and retained-bundle bytes require the normal rebuilt, signed
native release and fresh admission; generated profiles belong to final source
freeze qualification.
