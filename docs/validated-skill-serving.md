# Validation-selected Skill serving

For manual user-facing deployment, use
[Offline Retrieval Solution Packages](retrieval-solution-packages.md).
That workflow exports weights/configuration without private corpus text and
requires explicit Router import and enablement. This document describes the
earlier private fixed-corpus deployment, not a distributable solution package.
An explicit package selection or Disable action takes precedence over a legacy
serving pointer; existing private deployments are not silently migrated.

PKM can admit an explicit private `serving-release.json` in its retrieval
state directory. No SI database is read during requests and ongoing training
does not promote or alter the serving release.

The opt-in path applies only to explicit `["skill"]` queries classified as
semantic/fuzzy. Exact syntax, mixed-content retrieval, and all non-Skill
contracts retain the existing engine. The public `semantic` route remains
unsupported; this is a scoped implementation inside the existing boundary.
Dense-section aggregates section matches into document hits; it is not a
new public L2 section-return API.

[`export-si-serving-release.py`](../scripts/export-si-serving-release.py)
selects the highest recall@5 among completed tasks on an explicitly chosen
snapshot and identical corpus/training budget (MRR breaks ties). It freezes
configuration, route weights, documents, local bundle fingerprint and
validation provenance. It rebuilds and compares every validation ranking
before exporting, and checks current label eligibility on a database copy.
It does not represent a small reused validation anchor as independent test
evidence or wait for every optimizer study to terminate.

Run the exporter in the verified SI environment with its frozen implementation
on `PYTHONPATH`. `--database`, `--snapshot`, `--pkm-root` and a new `--output`
path are required. The artifact contains private Skill text; never add it to
the repository or public extension package.

[`retrieval_serving.py`](../resources/retrieval_serving.py) verifies the
manifest digest, local model fingerprint, corpus revision and route identity.
Its index is reconstructed from the frozen inputs, never the changing
training database. Graph candidates are rejected until learned links can be
exported faithfully. Missing optional architecture/model dependencies fail
admission explicitly rather than installing packages or downloading models.

The lexical index becomes available before the model warms. Failure, Skill
addition/removal or changed title/description/body disables admission and
returns to Exact/BM25 with status diagnostics. Unrelated Note/Script changes
do not invalidate the frozen Skill corpus. Source visibility, read-only,
strict content filters, generations and deadline checks still apply.

`retrieval_status.skill_serving` and response `skill_serving` expose the
release, readiness and fallback reason. `search_skills` uses an admitted
path while preserving source priority; otherwise its FTS/substring fallback
is unchanged. `skill_context` preserves metadata admission, protected Skills
and source priority, and uses the admitted ranking within those constraints.
Its final results therefore must not be advertised as raw validation scores.
Query-text telemetry remains disabled.

## Local deployment and rollback

The recovered local deployment runs a separate user systemd worker using the
verified offline SI environment, not the lightweight MCP environment. The
existing persistent worker protocol/configuration hash is retained and the
worker version increases, allowing older compatible windows to reuse it.
The private service is `pkm-validated-skill-retrieval.service`.

To roll back, stop/disable that service and remove the state directory's
serving-release pointer (keep the immutable release and backups). Restart the
ordinary PKM worker or reload the extension; its default is Exact/BM25.
Updating the working tree/build does not hot-reload the installed MCP server.
The updated search adapters and built-in test Recipe require loading the
updated extension; the independently deployed worker can serve existing
`skill_context` and Skill-filtered `search_knowledge` callers immediately.
