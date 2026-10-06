# Structured Test Result Gate

The built-in **Structured Test Result Gate** Recipe invokes
[`recipe_test_gate.py`](../resources/recipe_test_gate.py) as a bounded command
Module. It uses native JUnit reports, not an LLM log summarizer.

Supply absolute `python`, `gate_script` and `config_file` Recipe inputs. A
configuration for pytest is:

```json
{
  "runner": "pytest",
  "command": ["/path/to/python", "-m", "pytest", "-q", "--cov=my_package"],
  "cwd": "/path/to/project",
  "artifact_directory": "/path/to/private/test-artifacts",
  "timeout_seconds": 1200,
  "coverage_threshold": 100
}
```

For existing Node assertion scripts, use `"runner": "node"` and
`"command": ["node", "tests/test-example.js"]`. The module adds Node's native
test harness and JUnit reporter. Node coverage gating is not yet supported;
requesting it fails explicitly. Pytest coverage requires the project's
existing pytest-cov installation and `--cov` target. No packages are installed.
Legacy assertion-only Node scripts appear as one case per script; named
`node:test` cases retain their own case identities. Assertion counts are not
invented from console output.

The compact JSON contains `all_passed`, test/skipped counts, failed cases,
independent `gate_failures`, coverage and artifact paths. Successful cases
and full logs are not printed. At most ten failure diagnostics are printed;
`failure_count` and `diagnostics_truncated` make truncation explicit. Full
diagnostics remain in `result.json`, with complete runner output in `full.log`
and `junit.xml` (Node reporter output, including captured test stdout).

Nonzero exit, startup failure, timeout, missing/corrupt reports, no non-skipped
cases, test failures, and unmet/missing coverage all fail the Module. Every
invocation creates a fresh private artifact subdirectory, so stale reports
cannot turn a failed run into a pass. Logs may contain private source or test
data; keep the artifact root local and outside published packages.

Run without the Recipe runtime using:

```sh
python resources/recipe_test_gate.py --config /absolute/path/config.json
```

The Recipe becomes available through normal built-in reconciliation after
loading the updated extension. It is not a replacement for test selection,
independent acceptance, or the broader validation Recipe.
