# Finalized original Recipe run inspection checkpoint

## Concrete supported slice

`original-mcp-recipe-terminal.ts` adds **only already-finalized**
`mcp.tool.recipe_run_get` inspection. It never uses the original Python
business adapter at runtime. The original captured input remains
`{run_id: string, detail?: string}`; the response is the original
`pkm.recipe.api/v1` JSON, including compact/full distinctions, exact run identity,
version, counts, completed results, usage, loop state, automation metadata and
`next_action: none`. Repeated reads remain `replayed:false` as in the original
getter: this is inspection, not receipt replay.

The real original getter synchronizes command/subflow results, advances graphs
and may finalize health even though its captured tool is read-only. This
checkpoint refuses running/cancelled/unfinalized/inconsistent records and
archived background/subflow ownership. It does **not** approximate those
continuations or inherit any old worker/credential/permission. No model,
toolchain, script, command result path, native effect or reference URL is opened.
Historical result references remain opaque.

## Separate exact source admission

1. Select the original `runId`, independently observed `expectedSha256`, and a
   `maxFileBytes` budget (at most 16 MiB).
2. Call `planOriginalMcpRecipeTerminal(owner, host, selection)`. It validates
   actual RootOwner/Storage/custody and terminal invariants, producing
   `pkm.original-recipe-terminal-source/v1`.
3. Use the actual branded
   `createOriginalMcpNativeRecipeSourcePolicy(owner, host, authenticatedSession)`
   producer. **Callback copies are refused** by terminal admission, even if they
   return a plausible approval. Aggregate usage consent grants no result access.
4. Call `admitOriginalMcpRecipeTerminal(owner, host, source, producer.policy)`.
   The existing signed `recipe.source.approve` method now accepts a discriminated
   union: unchanged usage requests, or the new exact selected-terminal source
   request. No new transport method is required.
5. Sealed source/raw bytes/decision publish atomically in append-only
   `original_recipe_terminal_sources` on the same owner's `core.sqlite`.
   Updates/deletes are forbidden; subsequent reads also verify sealed schema,
   exact source hash, decoded record digest, custody and current original bytes.
6. After restart call
   `activateOriginalMcpRecipeTerminal(owner, host, runId, producer.policy)`.
   Persisted admission is **not** current permission. Every read requires the
   actual current selected-run approval and exact public request scope.

The source request binds root/workspace/custody/profile, actual host receipt,
actor, epoch, run/path/raw SHA, record SHA, status and byte budget. The pure parser
checks the complete plan digest and existing 65536-byte whole signed frame.
The installed Recipe producer prompts specifically for the selected finalized
run; it does not silently widen a usage prompt.

The current native Recipe policy intentionally has one current Recipe decision:
new Recipe source consent revokes the preceding Recipe source's typed signal.
Thus multiple immutable source rows can be preserved, but switching selections
requires explicit new activation. Todo/Memory/Chat domains remain separate.
Expiry, producer revocation and actual native session closure remove cached
terminal read grants via the real typed approval signal.

## Parent integration patch

No shared dispatcher/activation/transport/readiness files were changed here.
The 14th method's existing imports already point to the Recipe pure payload
schema/parser, so compiling the held union enables the new request subtype.

Add a branch in the parent's original public dispatcher **inside the existing
`withOriginalMcpPublicRequest` callback**, before the generic Recipe blocker:

```ts
if (request.tool === "recipe_run_get") {
  const { readOriginalMcpRecipeTerminal } =
    await import("./original-mcp-recipe-terminal.js");
  return result(await readOriginalMcpRecipeTerminal(
    owner, host, actor, request.arguments, signal));
}
```

`result` is the dispatcher's existing original JSON/MCP serializer. Forward
unchanged captured arguments, not normalized/default-expanded substitutes.
The adapter checks the exact public tool/operation/readOnly/argument digest and
actor against this actual Storage/host before returning any result.

The parent/trusted coordinator must also expose the **separate** terminal
selection/plan/admit/activate journey. Do not autoadmit it when usage, model or
public permissions are approved. Unselected valid run IDs remain access denied,
not global filesystem discovery. Syntax/detail errors retain original
`recipe-run-get-failed` results; errors needing live continuations are explicit
planning refusals, not fabricated successful original getters.

## Evidence and blockers

`tests/original-mcp-recipe-terminal.test.mjs` runs cold original `_atomic_write`
and the real original `recipe_run_get` function plus its real reconciliation,
advance and response functions as the oracle, under the private Linux framework.
It compares completed/failed compact/full results and errors; verifies source
bytes stay unchanged; and exercises actual signed sockets, RootOwner/Storage,
independent source requests, revocation, restart, cancellation, denial and drift.
Signer/UI identities in these socket tests are explicit doubles, not installed
qualification. Recipe UI tests separately verify the terminal-specific prompt
and prohibit importing Node/Core/Storage authority into the UI.
Run cold-writer files serially (`--test-concurrency=1`) inside the private Linux
framework: concurrent fixture subprocess exits can legitimately trip the real
uninspectable-writer gate. Do not ignore processes or weaken that gate.

The parent integrated the exact public route and compared its returned JSON
against the original getter. The active Room/terminal-Recipe/cold group passed
17 cases serially; native Room/Recipe UI cases passed 13, with Core/host
typechecks and guarded builds also passing. Installed terminal-source approval
and installed/browser acceptance remain separate gates. Original library/source execution admission,
`create_from_skill`, start/adhoc, next/progress/report/input and mutation-capable
get continuations remain incomplete. This checkpoint does not promote full
nine-operation Recipe or full-151 native readiness.
