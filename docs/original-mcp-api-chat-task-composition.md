# Original API native Task composition

This adapter is source-complete behind a mandatory, independently negotiated
`execution.task.run` lane. The distinct lane, strict callbacks, actual retained
driver hooks and guarded terminal reconciliation are now integrated; old
producers without that handler still fail closed. Positive actual socket/Core
API cases and the separately documented
[installed fresh-native-text Task scope](./installed-native-managed-task.md)
pass. Advertising a method alone is not qualification.

## Ownership and behavior

`original-mcp-api-chat-task-adapter.ts` composes the accepted
`createNativeManagedChatTasks` service with the **same singleton**
`createOriginalMcpNativeExecution` used by ordinary Chat. It owns no model loop,
scheduler, database, RootOwner, alternate provider or Task persistence engine.

The original API still returns asynchronous command receipts and applies the
same command-ID/payload conflict and replay rules. The complete original
`Start a new task:`/`开始新任务：` input remains consent-bound. Canonical Core
start/finish, not the API transcript path, append the UUID input and reply.

Fresh native-created text Chats can create one Task. Explicit same-goal
follow-ups use a fresh native resolve/send consent and the canonical next-attempt
transaction. Resolved-goal replacement requires a fresh Chat; it is not silently
manufactured. Owned cancellation disarms the actual capability and cancels that
same executor. Pending preparation is independently abortable after genuine
native cancel consent.

`api_chat_get` adds `managedTask` only for actual canonical Task rows.
`sessionAuthority: native_core` requires a successful read through the real
current native capability. Without it, the data is `historical-only`/
`archive_only`, never an execution grant. Goal resolution and Harness reports are
agent claims; `taskCompletion` remains `not-claimed`, including after a complete
model response.

Archived Session/worker ownership, uncertain attempts, images, checkpoints,
Recipe/file-version/worker evidence and more than 100 native history messages
remain closed. Those uncomposed tool families and generic capability-dispatch
tools are also excluded from the scoped Task catalog; the model cannot bypass
that boundary by choosing a nested operation. No live Memory recall is implicitly added to Task execution:
that separate per-request composition is not qualified here.

## Integrated shared wiring

The new pure contracts are in
`original-mcp-api-chat-task-execution-contracts.ts`. Existing producers without a
distinct Task port must not advertise `execution.task.run`.

1. Extend the producer execution composition with
   `OriginalNativeTaskCapableExecutionPort`: optional
   `execution.managedTask.run` implements `OriginalNativeManagedTaskExecutionPort`.
   Only that handler advertises the Task method. Its callbacks require
   `taskContext`. The frozen ordinary SDK port routes strict `managedTask` plans
   to this method and refuses a missing negotiated lane, never ordinary fallback.
2. Extend the strict native plan payload with `originalNativeTaskBinding`.
   Authorize/bind the additional `taskContext` callback only on the active Task
   call and actual current authorized inference. Its request/result schemas are
   `originalNativeTaskContextRequest`/`originalNativeTaskContextResult`. Server
   dispatch uses the actual authenticated server session, plan and
   `dispatchOriginalMcpApiChatTaskContext`; never reconstruct a session from JSON.
3. In the existing executor's tool-port construction, for Task plans only,
   call `originalMcpApiChatTaskToolCatalog(host, plan, base)`. The real registered
   opaque attempt and Core scope are required. Ordinary tool catalogs remain
   unchanged. The three semantic tools retain the same canonical native
   review/approval/receipt machinery.
4. After the exact native tool intent commits and before its canonical gateway
   executes, call `beforeOriginalMcpApiChatTaskTool` **inside** the existing tool
   failure handling. Do not fabricate `report_work` for a Host transition.
5. Narrowly register native-only `chat.task.action_started`, using
   `originalManagedTaskActionStartedInput` and the existing snapshot output.
   Include it in execute-scope lifecycle admission, never model-tool admission.
   The existing Task worker transaction calls
   `applyOriginalManagedTaskActionStarted(db, admission.guard, args)` before its
   existing revision increment/snapshot. Existing worker source/owner/Chat
   guards and receipt transaction remain mandatory. The helper validates an
   actual current authorized business-tool intent, then reuses original
   `agent_started_action` acceptance reset semantics.
6. Permit `chat.task.attempt.finish`, alongside cancel/get, through the
   **attempt-only** revocation check in `managed-chat-task-admission.ts`.
   Bound cancellation currently disarms that flag, otherwise preventing actual
   terminal native-journal reconciliation. Independent source/host/owner/Chat
   checks must remain unchanged; no inference/tool admission is restored.

## Retained driver hooks—not another driver

`clients/vscode-host/original-mcp-native-task-hooks.ts` supplies only hooks for the
existing retained `streamVscodeChat`:

- Once each observed round ends, call `beginRound` with its actual inference,
  round, observed tool-call presence and retained final-summary flag; await
  `afterRound` before retained synchronous `beforeFinish`.
- After the final actual tool result of a batch is acknowledged and receipted,
  await `afterTools` before the retained synchronous `stopAfterTools`.
  Fresh Tasks have no worker/plan handoff, so this remains false.
- Invoke `settled` after the retained stream and text/usage sinks finish, before
  returning native `complete`. A hard-limit tool-free summary does not inject
  another inference and cannot resolve an open Goal.
- Catch the actual `OriginalNativeTaskSemanticError` class as a known policy
  failure, returning native `failed` only after settled observed I/O. Do not
  recognize arbitrary caller flags/error strings as known settlement. Existing
  cancellation, pending-effect and genuine network-uncertainty classification
  takes precedence.

The Core callback reads real current Goal state and canonical terminal tool
receipts. It preserves the SHA-pinned original context and stale-ending evidence
key behavior. Plain response completion cannot substitute for `report_work`.
After rejection/settlement, additional inference/tool callbacks are refused.

The retained tool batch queries its synchronous `afterTools` callback before
individual tools as a stop probe too. Native Task context is therefore
requested only after every actual proposed call has a terminal `onTool` event.
That asynchronous context/acknowledgement drains before the next inference;
the existing retained driver remains the only loop. Known semantic policy
errors are captured by their actual class before the retained wrapper can
translate them; settled policy failure is not mislabelled network uncertainty.

## Verification and remaining gate

Private UID-preserving Linux PID/mount/network/procfs isolation, private fixture
HOME, and selective leaf overlays were used; no shared build/package output or
live data was changed.

- New composition/hooks/original-oracle/actual socket-Core missing-method tests
  plus accepted Task suites: **12/12 passed**.
- Original API/Source/Memory/31-round native regression suite: **20/20 passed**.
- Root and VS Code host noEmit: passed.

`tests/original-mcp-api-chat-task-live.test.mjs` contains explicit positive
socket/Core API scenarios. Run it with `PKM_TEST_MANAGED_TASK_LANE=1` after the
above shared integration. It hard-fails a missing Task handler instead of
qualifying an ordinary callback. Its deterministic model/UI ports are labelled
fixtures, not native installed/provider proof. Parent enabled that run and both
positive scenarios pass, including actual asynchronous inspection receipts.
The loader uses the one emitted contract module so semantic-error identity is
not duplicated. The actual installed leaf also passes on its exact candidate;
full-eight-operation, human Task acceptance, older source authorities and
commercial-provider/keyring/cutover qualification remain separate.
