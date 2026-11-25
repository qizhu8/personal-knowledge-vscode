# Native original-Board worker enrollment

`src/original-mcp-native-todo-worker-contracts.ts` defines the separate signed
`todo.worker.enroll` request. It binds the exact root, workspace, custody plan,
profile, native host/epoch, admitted Todo source/intent, current source decision,
Board digest, external worker actor, and hash of a newly generated token.
Neither a supplied token nor a public/model/source approval is an enrollment.

The client leaf `createOriginalMcpNativeTodoWorkerProducer` requires the actual
native signer, trusted workspace and current attachment. Its explicit modal
approval produces a bounded, exact-request decision. It starts no task, prompt,
model or queue, and never receives or returns the raw worker token. Pending UI
answers are discarded after cancellation or identity/attachment changes.

The Node entrypoint is:

```ts
const enrolled = await enrollOriginalMcpNativeTodoWorker(
  storage, nativeHost, actualAuthenticatedNativeSession,
  { boardSlug, actorId: "external:copilot:stable-worker-id" },
);
```

It creates/reuses the branded same-owner policy and calls the existing Core
enrollment protocol, which alone generates the fresh token and records/adopts
the exact Board grant. `enrolled.token` is private worker access, not an original
token or a native UI decision. The low-level `enrollOriginalMcpTodoWorker` remains
a trusted-embedding protocol; using an arbitrary embedding callback is not
genuine native enrollment.

## Parent-owned composition

No shared transport, attachment, Storage, worker, domain-state, or production
coordinator changes are included in this leaf batch.

1. In `src/original-mcp-native-request.ts`, merge
   `originalNativeTodoWorkerMethods`, `originalNativeTodoWorkerPayloadSchemas`
   and `originalNativeTodoWorkerResultSchemas` from the worker contracts.
   Dispatch the existing payload parser to
   `parseOriginalNativeTodoWorkerPayload(method, value, session)` when
   `isOriginalNativeTodoWorkerMethod(method)` is true. Dispatch the result parser
   to `originalNativeTodoWorkerResultSchemas[method].parse(value)`. Do not replace
   these with a generic approval boolean or an unparsed result.
2. In `clients/vscode-host/original-mcp-native-attachment.ts`, create
   `createOriginalMcpNativeTodoWorkerProducer(context, { session, signal,
   assertCurrent, close })` alongside—not instead of—the source producer. Pass
   the actual attachment close function. Advertise its `methods`, route its
   exact method to `handle(method, payload, requestId, signal)`, and dispose it
   when that attachment closes. Include the method predicate in the existing
   explicit handler-availability check.
3. Use the Node entrypoint above only with the actual retained signed session
   for that Storage/host. Do not expose an injectable policy, source approval,
   provided token or arbitrary native UI proxy as enrollment authority.

Until that registration exists, the Node policy throws `MISSING_NATIVE_METHOD`
and no worker row or token is published. Positive signed-enrollment tests are
explicitly gated by method registration, not counted as passed acceptance.

## Lifetime and permission matrix

The token's receipt expires no later than its current Todo source session and
the five-minute native decision. A source change while approval is pending
cancels it. Source replacement/revocation, host/signed-session closure, and
restart never revive durable worker rows or retained tokens.

Current Core has a Todo-session revocation SAB, but no independent per-worker
revocation channel. Therefore Node `policy.revoke()` conservatively invalidates
the **actual Todo session and all its workers**, leaving the signed connection
itself intact. Re-admit the Todo source and obtain new worker approvals/tokens.
Replacing a still-live grant for the same Board/actor requires that revocation
first; it is not an implicit token rotation. Native status-bar revocation closes
the whole signed attachment and all its grants. Finite worker expiry itself
does not extend or revoke independent source consent.

| Principal / target | Existing result |
|---|---|
| Old token or durable old worker row | No authority |
| Fresh exact Board worker / that Board | Existing Board-agent operations only |
| Fresh worker / another Board | Denied |
| Fresh worker / its own ordinary native Chat | Existing same-actor assignment rules |
| Fresh worker / manager-owned original Chat | Denied; enrollment does not make `external:*` equal `mcp:external` |
| Manager / original Chat | Conditional on the separately implemented genuine original binding and atomic assignment guard |
| Any worker / acceptance-review delegation | Not granted by enrollment |

An ordinary Chat in this matrix must already belong to an independently
authorized native principal with that actor ID. A Board token itself cannot
create/read arbitrary Chat sessions; Core restricts it to the exact Todo Board.

This is not an unconditional qualification of all Todo operations or the full
native engine. UI leaf mocks and actual signed-socket/RootOwner/Core fixtures
are separate evidence, not installed-native UI/assignment qualification.
