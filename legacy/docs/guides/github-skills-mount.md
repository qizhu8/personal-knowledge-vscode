# Mount a GitHub branch's Skills only

Run **PKM: Mount GitHub Branch Skills Only**
(`personalKnowledge.mountGitHubSkills`) after configuring a Knowledge Root.
Enter an HTTPS GitHub repository, an existing branch and the expected VS Code
GitHub account. Confirm the disclosure. This saves an ordinary PKM GitHub Sync
target with an explicit, immutable Skills mount intent, then fetches an initial
comparison. It does **not** queue synchronization or enable Auto Sync.

The mapping is exactly remote `Skills/` ↔ local `<Knowledge Root>/skills/`.
This is a writable Sync mount, not a read-only subscription or a separate local
library. **All public and private local Skills** are selected, including future
Skills and owned Markdown assets. “Private” is a PKM classification, not
encryption or proof that the GitHub repository is private. No Notes, Prompts,
Scripts, Profiles, Recipes or other content areas are selected. No Skill is
executed and no execution grants are imported.

Review the initial comparison in GitHub Sync. Use the existing conflict
workbench to choose each result, or run Initial Sync explicitly for a
non-conflicting adoption. Auto Sync becomes eligible only after successful
manual synchronization; enable it separately if wanted. Scoped Skills search
finalization is reused, without an automatic full-library inventory refresh.

## Persisted target contract

The existing machine-local GitHub Sync target store is used; there is no new
global setting. In addition to the normal target fields, the contract is:

```json
{
  "name": "My branch Skills",
  "repository": "https://github.com/owner/repository.git",
  "branch": "skills-branch",
  "skillsMount": { "path": "Skills", "adoption": "explicit" },
  "selection": {
    "public": { "skills": { "items": [], "folders": [""] } },
    "private": { "skills": { "items": [], "folders": [""] } }
  },
  "automation": {
    "enabled": false,
    "intervalMinutes": 5,
    "syncOnChange": true,
    "initialSyncCompleted": false
  }
}
```

Normal target normalization fills unselected areas with empty selections.
Production UI authentication uses the existing per-target VS Code GitHub
authentication workflow; credentials are not part of this example. The engine
also accepts its existing local-Git transport for isolated tests. A mount cannot
select another area or be converted from an existing ordinary Sync target.
Saving an existing mount through the normal editor preserves its mount intent;
attempting to widen its selection fails. Other remote paths/branches are not
mounted. The lowercase remote `skills/` is distinct from `Skills/`.

## Safe adoption and limits

* Ordinary manifestless Sync safeguards are unchanged. Only the explicit mount
  intent permits adoption without a manifest.
* Adoption supports PKM-compatible Markdown Skills: frontmatter `name`, a
  non-empty body, unique names, and regular Git blobs. Category folders and
  `package/SKILL.md` work as Markdown documents, **not executable packages**.
  Their resources must use the existing owned `document.assets/` layout or
  referenced Markdown asset directories such as `_assets/`. Shared ownership,
  arbitrary package scripts/support files, hidden files, invalid identities,
  symlinks, submodules and ambiguous case/name/path ownership fail explicitly.
  Initial adoption is bounded to 10,000 files / 64 MiB.
* Different first-sync content or identity at the same Skill name/path raises
  an existing review conflict **before any push or local replacement**.
  Accepted choices record the reviewed remote commit as Base; normal guarded
  Sync then publishes that explicit choice. Name/identity collisions across
  different paths cannot be assigned safely by per-file choices: rename or
  reconcile those Skills explicitly before adopting. No automatic rename,
  overwrite, identity reassignment or destructive migration is guessed.
* Metadata is stored at `Skills/.pkm-github-sync.json`, with canonical internal
  `skills/…` locators. A root `.pkm-github-sync.json` and all outside-Skills blobs
  are left unchanged, including binary data and CRLF bytes. After adoption the
  existing manifest/digest contract applies: unmanifested additions or stale
  remote digests fail rather than being silently re-adopted.
* Force Local, Force Remote and publication migration are unavailable for mount
  targets. Use normal Sync and explicit conflicts. Existing local ignore rules,
  managed-writer guards, compare-and-swap push and transaction recovery remain
  in effect.

The mount command does not install Git or a runtime. Network fetches and writes
only occur through the existing explicit GitHub Sync workflow; test fixtures use
real local Git with a fake GitHub URL transport, never real GitHub writes.

Focused validation:

```sh
./node_modules/.bin/tsc -p tsconfig.json --outDir .skills-mount-build --pretty false
PKM_SYNC_TEST_BUILD=.skills-mount-build node --test \
  tests/test-github-sync-skills-mount.js \
  tests/test-github-sync-selection-isolation.js
```
