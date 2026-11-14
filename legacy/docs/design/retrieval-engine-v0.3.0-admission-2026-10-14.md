# Retrieval engine v0.3.0 admission record

Date: 2026-10-14. This validates a candidate delivery only. It does not install
the engine into PKM, build a production index, change preferred routing, reload
an Extension Host or authorize deployment.

## Delivery identity

| Artifact | Observed identity |
| --- | --- |
| Source ZIP | `pkm-pca-retrieval-engine-v0.3.0-source.zip`, 1.5 MiB, SHA-256 `e11f5b10f2b464fa94f0e361dbed225d3d55f32fa3afca15b101f967407c1bf2` |
| Weight ZIP | `intfloat-multilingual-e5-small-614241f622f5-weights.zip`, 271 MiB, SHA-256 `8411b31c1b0f9c24fa32427944d78ddfcc72be4bd707651856999ad2e1aa3895` |
| Engine API | `pkm.retrieval/v1`, engine `0.3.0`, methods `index/search/status/close` |
| Python distribution | `adaptive-skill-retrieval==0.3.0.dev2026091701`, Python `>=3.11` |
| Model | `intfloat/multilingual-e5-small`, revision `614241f622f53c4eeff9890bdc4f31cfecc418b3` |
| Model directory fingerprint | `1ad5b08b5dcd604813d6e101e761a0f5f291ff183bd2804e853f09331492558e` |
| Score/output | reciprocal-rank fusion; document IDs for both profiles |

Both ZIP central directories and compressed members passed `unzip -t`. The model
preparation CLI independently accepted the provided weight ZIP and reproduced
the declared whole-directory fingerprint.

The weight bundle includes an MIT license. The source ZIP has no `LICENSE` file
and its source manifest has no source-license field; it only declares
`external_model_license: MIT`. Source-license provenance therefore remains an
admission blocker even though the Python project can be built.

## Isolated environment

All work was performed under the session artifact directory in a Python 3.11.14
venv. The active PKM Python environment was not modified.

The first strict offline install failed because PEP 517 attempted to resolve
`setuptools>=68` without a local wheel. Retrying with the venv's installed
setuptools and `--no-build-isolation --no-deps` built the source package.
The resulting minimal venv could not launch the model preparation CLI because
the package-level imports require PyYAML.

A second isolated venv reused host packages but installed the delivery's declared
`transformers<5` and `huggingface-hub<1` constraints locally. This was necessary
because the host had versions 5.7.0 and 1.29.0. The venv then provisioned the
fixed local model with `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`.

This proves offline runtime with pre-provisioned dependencies and weights. It
does not prove a self-contained air-gapped installation from these two ZIPs.
An air-gapped deployment also needs a pinned dependency wheelhouse and trusted
source-license metadata.

## Smoke results

Both profiles loaded the local model, replaced a nonempty in-memory index,
reported `ready=true`, serialized finite JSON and returned the expected relevant
document first.

| Profile | Documents | Create | Index | Search | Peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| L1 PCA dense document | 2 | 0.330 s | 5.037 s | 0.015 s | 1,080,244 KiB |
| L2 hierarchical section-informed document ranking | 8 | 0.293 s | 5.014 s | 0.016 s | 1,110,976 KiB |

These tiny warm-host measurements are smoke evidence, not startup or latency
SLA evidence. L2 still reported `output_granularity=document`; it did not return
passage ranges and is not admitted as PKM `l2-passage`.

The process emitted a `RequestsDependencyWarning` from reused host packages.
That warning does not invalidate the local-model smoke result, but it reinforces
the need for a clean locked deployment environment before performance testing.

## Negative-path results

| Case | Result |
| --- | --- |
| Unexpected engine version | Rejected with `ValueError` before serving |
| Missing model directory | Rejected as an incomplete local model bundle |
| Modified model file/fingerprint | Rejected with local model digest mismatch |
| Empty corpus | Rejected; prior index replacement contract remains explicit |
| Search after close | Rejected with `RuntimeError` |
| Missing provided archive | CLI exited nonzero with the missing path |
| Truncated/corrupt ZIP | CLI exited nonzero with `File is not a zip file` |
| Existing PKM rule retrieval | `npm run test:retrieval-boundary` passed |

No implicit model download or learning was observed in offline provisioning or
runtime smoke. Full network syscall isolation was not instrumented, so that
stronger claim remains for installed-host acceptance.

## Admission decision

Status: **conditional candidate; not integration-ready**.

Passing:

- archive integrity and stable ZIP hashes;
- fixed local model revision and whole-directory fingerprint;
- Python 3.11 package build in an isolated environment;
- offline local-weight provisioning and L1/L2 smoke;
- explicit failures for version, model, corpus, closed-engine and corrupt-input
  cases;
- existing rule-based retrieval regression suite.

Blocking:

- source license metadata/file is absent;
- a pinned offline dependency wheelhouse/lock is absent;
- target-corpus quality, cold startup, p50/p95, concurrency, RSS and rebuild
  measurements are absent;
- L2 returns document IDs, not validated passage spans;
- PKM provider adapter, generation switching, cancellation and rollback are not
  implemented;
- no installed Extension Host acceptance was run.

The rule engine remains the only admitted serving route. RET-01 can be closed
only after source-license provenance and reproducible offline dependency
provisioning are supplied; the remaining model-routing work belongs to RET-02
and later tasks.
