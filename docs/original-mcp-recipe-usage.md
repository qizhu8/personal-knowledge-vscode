# Original-root Recipe usage checkpoint

`original-mcp-recipe-usage.ts` implements **only** the captured
`mcp.tool.recipe_usage_summary` read. It uses the actual `RootOwner`, its
`Storage/core.sqlite`, a current original native host, and independently verified
sealed custody. It never invokes the original execution-capable run getter,
Python runtime, model, credentials, or a Recipe worker.

The original `legacy/resources/recipe_runtime.py` `_recipe_usage_groups`,
`_run_retry_count`, `_run_failure_count` and `_atomic_write` are the regression
oracles. Newest-5000 scanning precedes identity filtering; malformed JSON still
counts as scanned, revisions and child runs remain separate, loop failure
attempts are deduplicated, and public errors/Unicode ordering/averages preserve
the original result shape. Source changes fail closed, rather than falling back
to retained state. Numbers beyond native exact-integer capacity are explicitly
unsupported, not silently rounded.

## Parent integration

1. After independent original custody and current native-host admission, call
   `planOriginalMcpRecipeUsage(owner, host, {maxFiles, maxFileBytes, maxTotalBytes})`.
2. Compose `await createOriginalMcpNativeRecipeSourcePolicy(owner, host, session)`
   from `original-mcp-native-recipe-policy.ts` using the actual authenticated
   native attachment. Pass its **branded `policy`** to admission/activation.
   `assertOriginalMcpNativeRecipeSourcePolicy(producer.policy, owner, host)`
   rejects copies, unrelated owners and callback substitutes. Its synchronous
   checks retain the actual RootOwner, native receipt, profile, custody, actor,
   catalog and epoch. The native UI binds the **entire** request SHA-256, a fresh
   UUID decision, `mcp:external`, and an expiry within five minutes.
3. Call `admitOriginalMcpRecipeUsage(owner, host, source, policy)`. Publication
   atomically seals rows and admission with immutable SQLite triggers. No public
   request or model permission implicitly admits this source.
4. In the existing exact `withOriginalMcpPublicRequest` branch for
   `recipe_usage_summary`, return the original JSON from
   `readOriginalMcpRecipeUsage(owner, host, actor, arguments, signal)`. Pass the
   unchanged captured arguments, not default-expanded substitutes.
5. After restart, `activateOriginalMcpRecipeUsage(owner, host, policy)` requires a
   **new** independent current source decision. Stored admission grants nothing.
   Use `revokeOriginalMcpRecipeUsage(storage)` for explicit source revocation.

## Exact shared-lane patch for the parent

Recipe-specific implementations are held; shared registration is deliberately
not edited in this checkpoint.

In `src/original-mcp-native-request.ts`:

- Import `originalNativeRecipeMethods`, `originalNativeRecipePayloadSchemas`,
  `originalNativeRecipeResultSchemas`, `isOriginalNativeRecipeMethod` and
  `parseOriginalNativeRecipePayload` from `original-mcp-native-recipe-contracts.ts`.
- Append `...originalNativeRecipeMethods` to the method tuple, append
  `...originalNativeRecipePayloadSchemas` to `payloadSchemas`, and raise
  `originalMcpNativeSupportsSchema.methods.max(13)` to `.max(14)`.
- Before generic host parsing, route `isOriginalNativeRecipeMethod(method)` to
  `parseOriginalNativeRecipePayload(method, value, context)` in `parsePayload`.
- Before generic decision parsing, route the same predicate to
  `originalNativeRecipeResultSchemas[method].parse(value)` in `parseResult`.

The sole method is `recipe.source.approve`. Payload is the strict
`{binding: <native-host-body-without-receiptSha256>, noExecution: true,
request: OriginalRecipeSourceApprovalRequest}`. Result is
`OriginalRecipeSourceApproval | null`, **not** a generic boolean or
`{decision:"approve"}`. Parser validates the whole source plan/files digests,
selection cardinality, scan count, byte limits and signed root/workspace/custody/
profile/catalog/actor/epoch/host-receipt binding.

In `clients/vscode-host/original-mcp-native-attachment.ts`:

- Import `createOriginalMcpNativeRecipeProducer` from
  `./original-mcp-native-recipe.js` and `isOriginalNativeRecipeMethod` from the
  pure `../../src/original-mcp-native-recipe-contracts.js`.
- Retain a `recipes` producer beside `actions`/`sources`.
- After authentication, create it with
  `{session, signal:lifetime.signal, assertCurrent:current, close:closeTransport}`.
- Advertise `...recipes.methods` in the existing **single** native-supports
  frame; preserve the 65536-byte transport limit.
- Include the Recipe predicate in the supported-method guard and route it to
  `recipes.handle(parsed.method, parsed.payload, parsed.requestId,
  controller.signal)`, preserving the existing exact result/cancellation frames.
- Dispose it alongside `sources` in attachment failure/close handling.

The Recipe UI bundles only pure DTOs, not Core/Storage/native authority. Its user
revoke command closes the **actual signed attachment**, aborting pending requests
and all cached source grants. Node's `producer.revoke()` also aborts the actual
typed Recipe approval signal while leaving other domains independent.
`retainOriginalMcpNativeRecipeSourceApproval` retains that brand across parsing;
the usage cache subscribes to `originalMcpNativeRecipeSourceApprovalSignal` and
is immediately removed on revocation/expiry. Stored source rows remain immutable.

The Node factory looks up `recipe.source.approve` in the existing method tuple.
Before the parent patch it fails `MISSING_NATIVE_METHOD`, with no alternative
transport or injected native/source grant. Preserve the 65536-byte **whole
signed frame** budget; oversized selections explicitly reject before UI.
Reviewed chunking is not implemented and cannot be replaced by truncated previews.

## Deliberate blockers

The parent registered the strict 14th method, advertised/routed the actual
Recipe UI producer, and connected the original public `recipe_usage_summary`
read to this same-owner adapter. Its public-route oracle and integrated signed
policy passed with the source/RPC regressions (16 cases); native
Recipe/Source/Chat selection UI regressions passed 19 cases. Core/client/host
typechecks and guarded builds also passed. These counts overlap other batches.
Installed/browser Recipe source qualification remains separate. UI/signer
test doubles and the actual signed-socket missing-method regression are not
installed source approval. Existing readonly Recipe library/search surfaces are
not full source/execution parity.

No lifecycle tool (`create_from_skill`, start/adhoc, get/next/progress/report/input),
new/native usage merge, native autonomous/script authority, or full original
Recipe/151-operation readiness is promoted by this checkpoint. Original usage
is historical accounting: old running records stay unchanged and are never
resumed, cancelled, or replayed.
