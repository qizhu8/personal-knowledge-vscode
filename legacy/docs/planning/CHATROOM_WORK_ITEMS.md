# Chatroom Work Items

Status legend: `[ ]` pending, `[~]` in progress, `[x]` complete.

## Phase 1: Join, Identity, Errors, Presence

- [x] Remove Host manual Join approval and user-visible Reuse Identity.
- [x] Auto-join holders of a valid Room secret.
- [x] Reject an online duplicate alias immediately with `name-taken`.
- [x] Preserve an immutable participant ID only for the same client identity key; a different key creates a new identity.
- [x] Release display aliases on departure without rewriting historical authorship.
- [x] Return Join preparation errors immediately instead of silently waiting 125 seconds.
- [x] Remove failed replacement connections from the MCP alias registry.
- [x] Keep message-level rejections non-terminal.
- [x] Correlate each post acceptance/rejection with `client_request_id`.
- [x] Distinguish socket connected, active blocking standby, working, and disconnected.
- [x] Prevent alias/display-name reuse from making one Agent appear as another.
- [x] Keep Room secret rotation manual; removing a member does not rotate it.
- [x] Discover active hosted Rooms across VS Code windows sharing the same PKM store.
- [x] Keep hosted Rooms alive across Host tab close, reload, and transient socket disconnect.

## Phase 2: Recipient Composer

- [x] Infer recipients from the Host's previous Host-authored message.
- [ ] Store inferred audience as participant IDs and filter departed members.
- [x] Hide ghost recipients when valid leading explicit recipients are present.
- [x] Ignore inline, quoted-code, and code-block `@` text for routing.
- [x] Keep ghost recipients out of the authored message body.

## Phase 3: Reply Policy and Host Modes

- [x] Replace the internal reply boolean with `none | required | optional`.
- [ ] Support sparse per-recipient policy overrides.
- [x] Add Host `Announce`, `Ask`, and `Discuss` modes.
- [x] Preserve compatibility with legacy `require_reply` clients.
- [ ] Negotiate protocol version and discussion capabilities.

## Phase 4: Discuss Lifecycle

- [ ] Freeze an available-participant audience snapshot at discussion start.
- [ ] Implement bounded `initial` and `review` phases.
- [ ] Advance on all responses or a persisted deadline with partial results.
- [ ] Treat disconnect, Join failure, and non-response as fail-open.
- [ ] Deduplicate slots by `(discussion_id, phase, participant_id)`.
- [ ] Keep review, acknowledgement, and progress posts non-recursive.
- [ ] Support Host skip, close, request-review, and next-round controls.
- [ ] On Hub restart, durably abort unfinished MVP discussions and release obligations.
- [ ] Guard timers with a discussion generation to prevent stale advancement.

## Phase 5: History, Visibility, Diagnostics

- [ ] Isolate history by Room ID and return cursor boundaries.
- [ ] Separate `visibility_scope` from `discussion_audience` obligations.
- [ ] Return bounded batches with continuation cursors and fetch-by-ID.
- [ ] Preserve server-sequence ordering and immutable author attribution.
- [ ] Split final post results into `post_result` and `next_event`.
- [ ] Add per-Room routing, policy, phase-transition, and rejection diagnostics.
- [ ] Protect and rotate bearer Magic Links; never log full links.
- [ ] Add rate limits and fairness budgets without killing connections.
- [ ] Add accessible mode, inferred-recipient, deadline, and pending-member UI.

## Release Gates

- [ ] Join, identity, collision, retry, reconnect, and cleanup matrix.
- [ ] Routing, policy, permission, and old-client compatibility matrix.
- [ ] Discussion lifecycle, idempotency, deadline, and race matrix.
- [ ] Payload, history, refetch, restart-abort, and visibility matrix.
- [ ] Diagnostics, feature-flag, rollback, and instruction-consistency matrix.
