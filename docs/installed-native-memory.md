# Installed native Memory/Chat experiment

These new helpers are an executable scenario for a **disposable, cold original
Root**, using the real installed extension, signed native source/model APIs,
one actual RootOwner/Core and a **deterministic registered native LM provider**.
They do not qualify a commercial provider, actual user profile/keyring, live
library deployment or full native-engine cutover.

## Verified installed result

The parent completed the positive installed scenario with the actual native
UI, signed source/model lanes and same cached Core. Default off, missing-source
refusal, explicit exact scope/query and full Memory manifest, real canonical
`get_document` review/effect, tool-free summary and transcript readback passed.
Logical Memory revocation while model approval was pending blocked the late
approval from reaching either provider or tool; the independent host, Chat
source and owner lease stayed live. Original Chat/Engine bytes stayed intact.
After actual whole-editor exit, B1 retention, typed retirement and fresh B0
restore also passed.

Run this bounded created-fixture scenario:

```sh
node clients/vscode-host/installed-test.mjs --native-identity --cold-component \
  --native-memory --legacy-vsix <pinned-original-4.0.22.vsix> \
  --vsix <reviewed-native-candidate.vsix> --evidence <private-evidence.json>
```

Accepted candidate SHA-256:
`b93c12581836afe2f63375b3db1c2ead266edabc796fec6956673869aab1e924`.
Installed payload:
`b49b973f7c8cbfdc265649e367b5d179a862a0e8f6e80d86d36a2f46c085d79c`.
The deterministic provider is real `vscode.lm` registration, not a commercial
provider or actual user's keyring. No production profile/library was installed
or migrated.

## Preparation before sealing

After actual native identity enrollment **and whole-editor exit**, call:

```js
const sourceFixture = await prepareInstalledNativeMemoryFixture({
  installed, componentFixture,
  legacyChatStore: {path: pinnedOriginalChatStorePath, sha256: independentlyCapturedSha256},
  memoryEngine: {
    python: absolutePythonPath,
    moduleRoot: absoluteOriginalEngineModuleRoot,
    files: {
      "pkm_memory_engine/__init__.py": pinnedSha256,
      "pkm_memory_engine/engine.py": pinnedSha256,
      "pkm_memory_engine/memory.py": pinnedSha256,
    },
  },
});
```

The original ChatStore creates four actual original-layout Chats inside the
fixture Root. The original Python Engine creates/confirms one sourced record
in a closed private SQLite file **outside** the Root. Their hashes/identities
are pinned; no copied Source DTO, fake policy callback or success receipt is
accepted. The same source fixture object is process-branded. Do this before
`bootstrapOriginalMcpColdComponent` captures B0/custody. Never replace the
enrolled profile digest or reseal custody after native enrollment.

The existing Todo-source preparation may run alongside it. Memory verification
must run **before the Todo-source verification**, whose final native statusbar
revocation deliberately closes the complete signed session.

## Parent-owned opt-in cold composition

The existing source-only cold component intentionally has no model bundle.
Keep that default. A separate typed experiment opt-in must compose this exact
path inside its existing same-owner `prepareNative`, not start another Core:

```ts
const session = await server.waitForSession({timeoutMs: 300000});
await waitForOriginalMcpNativeSupport(session, {timeoutMs: 120000});
await waitForOriginalMcpNativeChatSupport(session, {timeoutMs: 120000});
const nativeChat = createOriginalMcpNativeChatRpcPort(session);
// Require execution.run, models catalogue/select/count, all three high-level
// Chat methods and optional chat.memory.select. Missing methods refuse.
const policy = createOriginalMcpNativeRequestPolicy(session, {
  toolCatalog: [{name:"get_document", operation:"knowledge.document.get", approvalRequired:true}],
});
host = await createOriginalMcpNativeHost(storage, policy, {nativeChat});
sourcePolicies = createOriginalMcpNativeSourcePolicies(storage, host, session);
return host.options;
```

No HTTP/default provider is configured; the original API runtime uses that
frozen authenticated `host.nativeChat`. Ordinary source-only cold runs retain
their old unavailable-model behavior. The verifier explicitly refuses with
`INSTALLED_MEMORY_COLD_MODEL_RESOURCE_COMPOSITION_REQUIRED` if composition is
missing.

## Driver and native UI hooks

In the existing development driver, contribute the native provider vendor
`pkm-native-memory-fixture` only for this experiment. Register it through:

```js
await registerInstalledNativeMemoryProvider(
  vscode, installedNativeMemoryProviderOptions(sourceFixture, root),
);
```

The provider options are plain synthetic-data configuration, not authority.
Use the actual `vscode` API; do not mock or replace it for installed evidence.
On the cold activation, immediately after actual native attach, call the
existing `pkm.nextHost.enableNativeModels` command and drive its real native
modal. Register the provider in that **new** editor process too. The fixture
driver must not wait for `component.complete()` before enabling models:
the opted-in composition waits for actual support advertisement.
The parent may publish `native-memory-enable` for this earlier UI stage; it is
not part of the verifier's later stage list. Pass the plain provider options in
the cold fixture JSON so the **new** driver process can register before enabling
the channel; do not make enabling conditional on a file written only after
`component.complete()`. The primary enrollment-only activation need not run
this scenario or the unrelated 31-round model fixture.

After the public Note/Skill effects and before Todo source revocation:

```js
const evidence = await verifyInstalledNativeMemory({
  root, installed, component, sourceFixture, payloadBuildId, python, env, port,
});
```

The helper writes `native-memory-ui-contract.json` with the exact current
Root/profile/source digests, scope/query/model and stage list. The parent
now only passes the actual existing Playwright Python/environment/CDP port:
the helper starts its **own bounded observer** from
`installed-native-memory-ui.mjs`, then stops it before returning. It attaches
only to the unique workbench renderer on that loopback CDP endpoint and writes
`native-memory-ui-ready.json`. No shared `installed-ui.py` change is needed for
the Memory business stages. The shared cold UI still owns attach/enable/public
Note/Skill modals and waits for cold effects completion. Start Memory only
after the final Skill update, and start the Todo-source observer only after
Memory returns.

The UI contract contains exact actual model/wire IDs, per-phase original
request/argument digests and Chat URLs. These files synchronize and constrain
UI only; they grant no source/model permission. At each stage:

| Stage | Actual UI actions |
|---|---|
| `native-memory-chat-source-admit` | Admit exact original Chat source with the existing source-only native producer; check Root/profile/source plan and no-execution detail. |
| `native-memory-default-off` | Approve exact public send; choose the labelled synthetic model, bind it, select **No live Memory recall (default)**; approve exact model selection/send/run/inference. |
| `native-memory-missing-grant` | Select **live** recall before Memory admission; it must refuse with no query/empty fallback/provider call. |
| `native-memory-source-admit` | Admit the exact original SQLite database/scope through the real native Memory source producer; no model execution grant. |
| `native-memory-positive` | Select live recall, enter exact query, approve exact scope/query choice; approve selection/send/run/inference and the real canonical `get_document` review/tool approval, then the tool-free summary inference. |
| `native-memory-revoke-pending` | Select live recall and proceed only until the initial **Send this inference to native VS Code model …?** modal is visible. Write `native-memory-revoke-model-visible.json`. Wait for `native-memory-revoked-before-click.json`, then approve that existing modal and write `native-memory-revoke-clicked.json`. |
| `native-memory-complete` | Read final evidence; allow existing Todo-source workflow or cold shutdown to continue. |

Use normalized exact text matching for Monaco. Do not select multiple handlers
for one modal, skip negative stages or replace native decisions with files.
The Memory scope is independently revoked through the actual
`component.sourcePolicies().revoke("memory")` while the model modal is pending;
this is logical source revocation, **not** an installed statusbar-erasure or
transport-revocation test. The same host, Chat source, model channel and cached
Core must remain live. A late approval must dispatch neither that prompt nor
another tool. No source was reactivated to bypass this refusal.

The native provider records actual received prompt manifests and calls, not
injected inference receipts. The verifier compares full canonical confirmed
records/source references, Memory revision and Chat/request/source/model/draft
binding; checks actual durable model/tool receipts and Core transcript/readback;
and confirms no HTTP fallback, no dispatch after revocation, unchanged original
Chat/Engine bytes and the same owner lease/cached Core.

After the actual editor exits and the existing B1 retirement/fresh B0 restore
completes, call
`verifyInstalledNativeMemoryRestored(sourceFixture, restored.root)`.
Do not run B0/B1 while any editor/writer is alive or alter production guards.

## Evidence status

Helper tests validate independently pinned actual Engine/ChatStore preparation,
copied-identity rejection and the synthetic provider's fail-closed input rules.
All **4/4** passed in the existing UID/PID/mount/network-isolated Linux
framework, with fixture files kept beneath the checkout and short paths visible
only inside that private mount namespace. Core and host noEmit checks passed.
Provider API doubles in that unit test are **not installed-native proof**.
The installed positive scenario uses the parent composition/driver/UI hooks
above and a coherent candidate; the helper does not emit or repackage itself.
Its successful installed result is recorded separately above. A previous
31-round/high-level Chat result alone is not that evidence.

## Exact observer behavior and titles

The owned observer parses the displayed structured modal detail and verifies
the synthetic fixture Root/workspace/profile/request/model/source identities
before clicking a unique exact button. Quick Picks admit only the two known
Memory choices, the exact labelled provider row and the exact bounded query
input. It never uses an “approve any visible dialog” loop.

Production model-channel button: **Allow this native model request**.
The exact high-level titles are:

* `Bind this exact native VS Code model to this PKM Chat?`
* `Use this independently admitted live Memory scope for this exact native Chat request?`
* `Select this exact native VS Code model?`
* `Send this exact request to the bound native PKM Chat?`
* `Run this native PKM Chat request with the displayed limits?`

Independent native approval button: **Approve this request**.
The actual Core tool titles use the canonical operation, not its model alias:

* `Review native PKM execution knowledge.document.get`
* `Allow native PKM tool knowledge.document.get?`

The actual inference title is
`Send this inference to native VS Code model ${wireModelId}?`.
At the revoke stage the observer records that exact visible modal and its
request digest, waits for the helper's real logical source revocation, then
checks the same title/text fingerprint before clicking **that existing**
modal. It does not open a new request or revoke the full native transport.

Four additional observer regressions passed using real headless Chromium,
CDP and rendered DOM in an isolated synthetic workbench: complete exact flow,
wrong-Root refusal with no click, and refusal of an unexpected third Memory
choice, plus replacement of the pending modal with identical text. The full
flow asserts that the last inference remains unclicked until the revocation
handshake; that click uses the captured original DOM button, not a locator that
could resolve to a replacement. These DOM fixtures are **not installed VS Code
authority proof**; the parent must still execute the actual coherent candidate.
