# Script identity and content versions

Scripts remain executable files under `scripts/`. Their identity lives in an adjacent hidden
`.filename.pkm.json` sidecar (`pkm.script/v1`), not in comments added to executable content.
Script listing and inventory ignore the sidecar. GitHub Sync publishes it as a dependency
of the selected Script, with the same selection and privacy.

- `knowledgeId` is the immutable object key. The canonical URL is
  `pkm://script/<knowledgeId>`; references and retrieval use this URL rather than the file path.
- `source_revision` is `sha256:<digest>` of the current Script UTF-8 content. It changes on
  content edits, not on a move or a local timestamp change. This is a content version, not
  a metadata or history revision. GitHub Sync hashes file bytes independently and includes
  repository-relative destinations in its tree fingerprint so real moves remain visible.
- `path` is the current location. The sidecar retains old `pkm://scripts/<encoded-path>`
  and `pkm://script/<legacy-path-id>` references as aliases. A move takes the sidecar with
  the Script; a new file cannot overwrite the Script or sidecar at the destination.

Existing Scripts adopt their previous path-derived `script_<24 hex>` ID once, then persist
it. This preserves existing canonical links and makes independent first reads on machines
with the same pre-migration tree converge. New raw files use the same bootstrap rule until
they have a sidecar. After adoption, neither path nor hash determines their identity again.
Identical content in two different files does not merge their IDs.
Direct sync-bundle exports carry the sidecar identity; unprefixed imports preserve it and
merge aliases for the same ID. Prefixed imports create independent copies with new IDs.
If a new file reuses a moved Script's former path, that path's old URI still belongs to
the moved Script and the replacement receives a new ID. Remote snapshot restore includes
the published sidecar with a selected Script or rejects both when overwrite is disabled.

## Migration gate

Do not physically relocate the 327 classified Scripts yet. First publish and pull their
sidecars across participating machines, verify unique IDs and alias ownership, then apply
the prepared path manifest and validate canonical and old references against the moved
files. An unregistered Script independently introduced under different paths has no
provable shared object identity; resolve that case explicitly before moving it. A deleted
Script has no tombstone redirect yet, so deletion must not be used as a migration step.