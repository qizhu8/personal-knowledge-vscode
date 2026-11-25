# Installed Recipe leaf: parent wiring checkpoint

The new `clients/vscode-host/installed-native-recipe.mjs` is a bounded leaf,
not another installed runner. It does not modify or package shared code, start
VS Code, publish business MCP, or claim installed qualification before the
parent executes it against the exact candidate.

The parent now wires this leaf through `installed-test.mjs --native-identity
--cold-component --native-recipe --legacy-vsix <original.vsix> --vsix <host.vsix>`.
This scenario is separate from Source, Action, Memory and Worker. The actual
cold component retains/coalesces `recipeSourceControl()` on its authenticated
session and admits only the four existing public lifecycle tools.

Parent actual-installed acceptance passed on VSIX SHA-256
`ee8fd7df3acc61efc4ad0b7e9b09131f4288bf4630a751e566d476c215dbcd8e`,
payload `e92c2be64da08ee1966e92fabdffb032d32d0ad214ce7ea46bbb8d56d22e09c5`.
The final cold report retains the successful separate `recipePreservation`
B1/B0 proof alongside the actual native UI/scheduler/original-oracle evidence.
The private profile was removed. Only the static NoOp external-report scope
below is qualified, not automatic model/process work, the full original Recipe
contract, or an actual user profile/keyring.

## Executable exports and required component method

```js
const sourceFixture = await prepareInstalledNativeRecipeFixture({
  installed, componentFixture, legacyVsix, python,
});
// Parent captures genuine B0/custody and boots the exact candidate normally.
const evidence = await verifyInstalledNativeRecipe({
  root, installed, component, sourceFixture,
  python, env, port, payloadBuildId,
});
// Parent closes the component AND entire editor, preserves B1, retires,
// and restores a fresh B0 with the existing actual recovery functions:
const preservation = await verifyInstalledNativeRecipeRestored(
  sourceFixture, { retirement, restored });
```

Preparation must run **after the full editor has stopped and before B0/custody**.
It requires the independently pinned original package SHA-256
`1804071cb3b9fc86edc5933d5001db6ea1a8d7a9adf30d6d2b3166fcd6048f27`.
Only eight bounded original Recipe writer/compiler/oracle members plus their
unaltered original package manifest are extracted
outside the original root. No legacy checkout, caller-supplied success policy or
unverified file hash can replace the package. Original `RecipeFilesystemStore`
writes the real canonical record/control into the disposable component root.
The unmodified original Python registration/compiler produces the full expected
start/claim/report/get/replay/conflict trace in a separate oracle root.
Its audit hook permits only the exact original pure compiler bridge command and
denies unrelated subprocesses/network. No old Recipe run executes on the native side.

The sole additional cold-component composition method needed is:

```ts
recipeSourceControl(): Promise<
  Awaited<ReturnType<typeof createOriginalMcpNativeRecipeSourcePolicy>>
>
```

Inside the **parent-owned** component closure, retain one factory result:

```ts
let recipeControl:
  Awaited<ReturnType<typeof createOriginalMcpNativeRecipeSourcePolicy>> | undefined;

async recipeSourceControl() {
  if (closed || !completed || !host || !nativeSession)
    fail("COMPONENT_NATIVE_RECIPE_UNAVAILABLE");
  host.assertCurrent();
  recipeControl ??= await createOriginalMcpNativeRecipeSourcePolicy(
    actual.owner, host, nativeSession);
  recipeControl.assertCurrent();
  return recipeControl;
}
```

Use the retained actual signed session; do not expose a caller-injected policy,
approval callback or new arbitrary session setter. The installed leaf verifies
the returned `policy`'s existing same-RootOwner/host WeakMap brand. Also admit
`recipe_run_start`, `recipe_run_next`, `recipe_run_report`, and `recipe_run_get`
in the component's existing `invoke` whitelist. All calls still traverse the
existing original public dispatcher; the leaf never calls the engine directly.

## Independent modal driver and exact stages

The leaf starts its own bounded Python/Playwright CDP observer on the existing
installed workbench. **No shared `installed-ui.py` modification is required**.
The exported `installedNativeRecipeUiProgram` and
`installedNativeRecipeUiStages` are the exact observer/stage contracts.

The observer reads `native-recipe-ui-contract.json` and requires one native
dialog, exact title/button and complete JSON request identity:

| Stage | Exact choice |
|---|---|
| `native-recipe-source-deny` | `Deny` |
| `native-recipe-source-admit` | `Admit this exact Recipe source only` |
| `native-recipe-start-deny` | `Deny` |
| `native-recipe-start` | `Approve this request` |
| `native-recipe-get-deny` | `Deny` |
| `native-recipe-get-initial` | `Approve this request` |
| `native-recipe-next` | `Approve this request` |
| `native-recipe-get-claimed` | `Approve this request` |
| `native-recipe-report-first` | `Approve this request` |
| `native-recipe-report-second` | `Approve this request` |
| `native-recipe-get-terminal` | `Approve this request` |
| `native-recipe-start-replay` | `Approve this request` |
| `native-recipe-report-replay` | `Approve this request` |
| `native-recipe-report-conflict` | `Approve this request` |
| `native-recipe-revoke` | Observe exact Recipe source tooltip; **do not click** |
| `native-recipe-get-revoked` | `Approve this request`; Core must still refuse missing source |
| `native-recipe-complete` | No modal |

Source title is `Admit this exact original Recipe library source?`.
Public title is `Allow PKM v5 <tool> for this exact request?`. Each getter
explicitly checks the native disclosure that inspection can synchronize durable
execution state. Source review checks the entire plan/request digest, exact
source files/authorities, root/workspace/custody/profile, actual identity and
native epoch. It cannot inherit public/model/usage/terminal permissions.

Only the Recipe-specific UI observer handles these stages. The parent-owned
general cold UI driver must leave Recipe-stage modals to it, and wait for
`native-recipe-complete`/the normal later cold stages rather than closing the
editor early. No UI evidence file itself is a permission grant.

## Logical revocation preserves the shared session

Run this leaf **before** the Todo source leaf, which closes the global session.
The Recipe leaf deliberately calls the actual returned Node source control's
`revoke()` instead of clicking the existing Recipe status command (that command
closes the whole signed attachment).

It observes the real typed Library signal abort, proves a newly
**UI-approved** public getter is rejected for absent Library consent, and
requires the native host/session to remain current for other leaves. The status
indicator is not used as authority and is not claimed to have been cleared by
this logical revocation; granular UI revoke notifications are not implemented.
Evidence explicitly identifies this as logical typed-source revocation, not a
human status-button/session-close test.

## Real results and preservation

The runtime scope is only two static unbound NoOp nodes with external caller
reports. The external caller actually reads/hashes its own synthetic input;
native code only claims/records reported work. No model/provider/process/Script/
subflow or automatic Agent effect is implied.

The leaf verifies actual same owner/lease/Core, exact original JSON trace
(excluding only volatile observation timestamps/ages), denial without admission
or mutation, terminal output, idempotency/conflict handling, real native
scheduler/source/protocol receipts, and unchanged original source bytes.

Parent recovery remains mandatory. The restore export verifies the actual
parent retirement and B0-restored receipt paths/SHA-256/baseline linkage,
unchanged canonical Recipe/control bytes in both B1 and B0, and the exact native
scheduler/source/receipt journal in the retired B1 SQLite. Fresh B0 must have no
native SQLite or original-MCP grant journal. It does not restore actual profile,
keyring or credentials, and never qualifies full nine-operation/151 cutover.

## Focused validation, not installed acceptance

`installed-native-recipe.test.mjs` tests rejection of copied/unpinned/presealed
inputs, actual pinned original writer/oracle preparation and candidate compiler
identity, missing-component fail-closed behavior, and Python observer syntax.
It does **not** mock a successful installed workflow or launch the full runner.
Use the existing private Linux framework and an explicit `PKM_LEGACY_VSIX`.
The parent must execute the real leaf against its exact packaged candidate
before claiming installed Recipe acceptance.
