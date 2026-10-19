# Text newline rules (v1)

The shared ruleset is `LF_TEXT_EXTENSIONS` in
[text-format.ts](../../src/knowledge/text-format.ts). Matching uses the final
filename suffix, case-insensitively, with either Windows or POSIX separators.
The operating system does not select a different default.

## Policy

| Group | LF suffixes |
| --- | --- |
| Documents | `.md`, `.markdown`, `.rst`, `.txt`, `.tex`, `.log` |
| Structured text | `.json`, `.jsonc`, `.yaml`, `.yml`, `.toml`, `.cfg`, `.ini`, `.conf`, `.config`, `.xml`, `.csv`, `.tsv`, `.ipynb` |
| Web / templates | `.html`, `.htm`, `.css`, `.scss`, `.less`, `.svg`, `.jinja`, `.jinja2`, `.tmpl`, `.template`, `.vue`, `.svelte` |
| PKM / SQL | `.script`, `.scope`, `.sql`, `.usql` |
| Code | `.cs`, `.py`, `.pyi`, `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.c`, `.cpp`, `.cc`, `.h`, `.hpp`, `.java`, `.go`, `.rs`, `.r`, `.rb`, `.php`, `.pl`, `.lua`, `.fs`, `.fsx`, `.vb` |
| Shell / Windows scripts | `.sh`, `.bash`, `.zsh`, `.fish`, `.ps1`, `.psm1`, `.psd1`, `.bat`, `.cmd` |

All other suffixes and extensionless files use **preserve**. Even a listed suffix
is preserved if its bytes contain NUL or are not valid UTF-8. UTF-16 is not
implicitly decoded. Adding a suffix requires compatibility tests for its actual
consumer; the ruleset does not claim every legacy Windows tool accepts LF.

For listed UTF-8 text:

- CRLF becomes LF. Mixed CRLF/LF becomes LF.
- UTF-8 BOM is preserved; BOM presence remains a distinct content difference.
- Standalone CR is preserved, not interpreted as an old-Mac line ending.
- No final newline is added, and no other whitespace is changed.

## Conversion API

`convertTextNewlines(content: Buffer, target: "lf" | "crlf"): Buffer` is an
explicit, path-independent conversion function. It validates UTF-8/NUL and throws
on nontext or an unsupported target. It first collapses CRLF to LF, then expands
LF if requested, avoiding doubled CR. Uniform LF/CRLF round trips preserve BOM,
content and final-newline presence; a mixed input cannot recover its original
per-line style after normalization.

`normalizeTextNewlines(relative, content)` applies the suffix policy. Unknown or
nontext bytes are intentionally preserved, not treated as a conversion failure.
The ruleset currently has no CRLF-default suffix. Explicit CRLF conversion is
available for a future verified exception without making Windows a blanket
exception.

## GitHub Sync integration

Sync applies the same suffix policy to Local materialization, fallback source
reads, logical comparison, historical Base newline evidence, Git deletion
evidence, selected final repository content, Pull writes and approved manual
candidates. Recipe semantic canonicalization remains separate.

Current Remote blobs are hash-validated **before** normalization. The final
repository plan pins normalized bytes and their digest. Staging sets
`core.autocrlf=false` for that command, so a user's machine-wide setting cannot
reclassify unknown/text-like binary content. Staged blobs must equal the planned
bytes exactly. Repository attributes or filters that change the plan still
produce an explicit error; the safety check is not disabled or made
newline-tolerant. Sync does not rewrite user attributes or enable external
filters as a newline migration.

Approved candidate hashes are checked against the original approved bytes
before generating the LF write content. Original Local byte snapshots remain
unchanged: concurrent edits, including newline-only edits after capture, reject
the write. Ignored Remote members remain untouched.

There is no bulk source migration or silent global Git configuration change.
Unchanged Local CRLF files need not be rewritten by Sync; a genuine Pull or
approved replacement writes LF for listed text. A selected historical CRLF
Remote member can produce a normalization commit with a matching manifest.
This is a content-format policy change, not deletion authority or permission to
push without the existing remote compare-and-swap.

## Validation

```sh
npm run build
node tests/test-text-format.js
node tests/test-github-sync-newlines.js
node tests/test-github-sync-windows-review.js
node tests/test-github-sync-file-safety.js
node tests/test-github-sync-base-integrity.js
node tests/test-github-sync-acceptance-recovery.js
```

Fixtures cover every listed suffix, mixed endings, BOM, idempotency and round
trips, unknown/binary/invalid UTF-8/NUL preservation, real local Git pushes with
`autocrlf=true/false`, historical CRLF Pull, original-source guards, approved
candidate tampering and idempotent resync. No live Target or knowledge source
is modified. Ignored CRLF Remote content stays unchanged, and Git attributes
changing preserve-policy bytes are rejected before push. Linux Git configuration fixtures do not constitute native Windows
acceptance.
