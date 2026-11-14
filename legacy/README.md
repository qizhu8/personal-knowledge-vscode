# Legacy compatibility and oracle snapshot

This is a source-only snapshot of the original implementation at the v5
repository-root migration. It exists for retained compatibility adapters,
original-source provenance and migration regression fixtures. It is not an
independently maintained or published PKM product.

Do not make new product changes here or silently refresh the recorded hashes.
`snapshot.json` identifies the copied files. Dependencies and compiled output
are generated locally and ignored by Git.

From the repository root:

```sh
npm --prefix legacy ci --ignore-scripts
npm run build:compat
```
