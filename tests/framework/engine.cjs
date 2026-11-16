"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createWorkspace, executeSuite } = require("./workspace.cjs");
const { pythonExecutable } = require("./catalog.cjs");
const { summarize, writeRunFailure } = require("./report.cjs");
const { exportVsix } = require("./artifact.cjs");
const { preparationCommand } = require("./fixtures.cjs");

function blocked(entry, error, outcome = "blocked") {
  return { suite: entry.name, status: "failed", outcome, error, code: null, cleaned: true, durationMs: 0, stdout: "", stderr: "" };
}

function prerequisites(entry, repositoryRoot, options) {
  if (entry.capabilities?.includes("qualification") && !options.admitQualification)
    return "Migration qualification requires --admit-qualification and the original provenance gates; source regressions remain in CI.";
  if (entry.capabilities?.includes("qualification")) {
    const missing = (entry.fixtures?.qualificationInputs || []).filter(name =>
      !(options.environment?.[name] || process.env[name]));
    if (missing.length) return `Missing explicit qualification inputs: ${missing.join(", ")}. No historical fixtures are synthesized or downloaded.`;
  }
  if (entry.capabilities?.includes("native") && !options.admitNative)
    return "Native runtime admission is required (--admit-native); fixture results still do not qualify production upgrades.";
  if (entry.capabilities?.includes("external") && !options.admitExternal)
    return "External SDK/model admission is required (--admit-external); no live provider is run implicitly.";
  for (const name of entry.nodeModules || []) {
    try { require.resolve(name === "playwright" && process.env.PKM_PLAYWRIGHT_PATH ? process.env.PKM_PLAYWRIGHT_PATH : name,
      { paths: [repositoryRoot] }); }
    catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
      return `Missing Node test dependency ${name}; restore the declared test environment first.`;
    }
  }
  return null;
}

function needsBuild(plan) {
  return plan.entries.some(entry => entry.layer !== "framework" && (entry.role === "test"
    || !entry.ownsBuild));
}

async function runPlan(plan, options) {
  const { repositoryRoot, reportDirectory } = options;
  const failureController = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, failureController.signal]) : failureController.signal;
  const jobs = options.jobs ?? 2;
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 4) throw new Error("Test concurrency must be 1-4 jobs.");
  if (!Array.isArray(plan.entries) || (!plan.audit && !plan.entries.length)) throw new Error("Execution requires a non-empty test plan.");
  if (plan.audit) return { summary: summarize(plan, [], 0), results: [] };
  const started = Date.now(), results = Array(plan.entries.length);
  const eligible = [];
  for (const [index, entry] of plan.entries.entries()) {
    const reason = prerequisites(entry, repositoryRoot, options);
    if (reason) results[index] = blocked(entry, reason);
    else if (!entry.finalizer) eligible.push({ index, entry });
  }
  const runWorkspace = options.runWorkspace || createWorkspace(repositoryRoot, options.temporaryParent);
  let preparedWorkspace, retainedWorkspace, report, build, artifacts = [];
  const environment = {
    PYTHON: pythonExecutable(), PKM_TEST_PYTHON: pythonExecutable(),
    PKM_BROWSER_CONCURRENCY: "1", ...options.environment,
  };
  try {
    if (eligible.length && needsBuild({ ...plan, entries: eligible.map(item => item.entry) }) && !options.noBuild) {
      preparedWorkspace = createWorkspace(repositoryRoot, path.join(runWorkspace.directory, "tmp"));
      options.onEvent?.({ type: "build", name: "build", total: plan.entries.length });
      const setup = await executeSuite({
        name: "build", command: options.buildCommand || preparationCommand(eligible.map(item => item.entry)), timeoutMs: 10 * 60 * 1000,
      }, {
        repositoryRoot, workspace: preparedWorkspace, retainSuccessfulWorkspace: true, aggregateReport: true,
        environment, signal,
      });
      build = { outcome: setup.outcome, code: setup.code, durationMs: setup.durationMs, error: setup.error || setup.cleanupError || null };
      if (setup.status !== "passed") {
        if (!setup.cleaned) retainedWorkspace = runWorkspace.directory;
        for (const { index, entry } of eligible) results[index] = {
          ...blocked(entry, `Build/setup failed before test execution: ${setup.error || setup.cleanupError}`,
            setup.outcome === "cancelled" ? "cancelled" : "blocked"),
          stdout: setup.stdout, stderr: setup.stderr,
        };
      }
    }
    const pending = eligible.filter(item => !results[item.index]);
    const activeResources = new Set();
    const waiters = new Set();
    async function worker() {
      while (pending.length) {
        if (signal?.aborted) {
          for (const { index, entry } of pending.splice(0)) results[index] = blocked(entry, "Cancelled before test execution.", "cancelled");
          break;
        }
        const position = pending.findIndex(item => (item.entry.resources || []).every(resource => !activeResources.has(resource)));
        if (position < 0) {
          await new Promise(resolve => waiters.add(resolve));
          continue;
        }
        const { index, entry } = pending.splice(position, 1)[0];
        const resources = entry.resources || [];
        for (const resource of resources) activeResources.add(resource);
        try {
          options.onEvent?.({ type: "start", name: entry.name, index, total: plan.entries.length });
          const steps = entry.steps;
          const result = await executeSuite({
            ...entry, ...(steps ? { command: [process.execPath, path.join(__dirname, "steps.cjs")] } : {}),
          }, {
            repositoryRoot, temporaryParent: path.join(runWorkspace.directory, "tmp"),
            preparedWorkspace: preparedWorkspace && fs.lstatSync(preparedWorkspace.directory, { throwIfNoEntry: false }) ? preparedWorkspace : undefined,
            environment: { ...environment,
              ...(steps ? { PKM_TEST_STEPS: JSON.stringify(steps) } : {}),
              ...(entry.file?.startsWith("modules/pkm-memory-engine/") ? {
                PYTHONPATH: [path.join(repositoryRoot, "modules", "pkm-memory-engine", "src"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
              } : {}),
            },
            timeoutMs: options.timeoutMs, signal, aggregateReport: true,
          });
          if (entry.role === "test" && result.status === "passed") {
            const node = [...result.stdout.matchAll(/# tests (\d+)[\s\S]*?# pass (\d+)[\s\S]*?# skipped (\d+)/g)].at(-1);
            const python = [...result.stderr.matchAll(/Ran (\d+) tests?/g)].at(-1);
            const skipped = [...result.stderr.matchAll(/OK \(skipped=(\d+)\)/g)].at(-1);
            result.cases = node ? { total: Number(node[1]), passed: Number(node[2]), skipped: Number(node[3]) }
              : python ? { total: Number(python[1]), passed: Number(python[1]) - Number(skipped?.[1] || 0), skipped: Number(skipped?.[1] || 0) } : null;
            if (entry.command?.includes("--test") && !node) {
              result.status = "failed"; result.outcome = "failed";
              result.error = "Node runner returned no TAP summary; assertion execution is not verified.";
            } else if (result.cases && result.cases.passed === 0) {
              result.status = "failed"; result.outcome = "failed";
              result.error = "The selected file executed no passing tests (zero matches or all cases skipped).";
            }
          }
          if (result.status === "passed") { result.stdout = ""; result.stderr = ""; }
          if (!result.cleaned) retainedWorkspace = runWorkspace.directory;
          results[index] = result;
          options.onEvent?.({ type: "complete", name: entry.name, index, outcome: result.outcome,
            durationMs: result.durationMs, error: result.error || result.cleanupError, cleaned: result.cleaned });
        } catch (error) {
          retainedWorkspace = runWorkspace.directory;
          results[index] = blocked(entry, `Harness execution failed: ${error.message}`, "cleanup_error");
          results[index].cleaned = false;
          failureController.abort(error);
        } finally {
          for (const resource of resources) activeResources.delete(resource);
          for (const resolve of waiters) resolve();
          waiters.clear();
        }
      }
    }
    await Promise.allSettled(Array.from({ length: Math.min(jobs, pending.length) }, worker));
    for (const [index, entry] of plan.entries.entries()) {
      if (!entry.finalizer || results[index]) continue;
      if (signal.aborted || results.some(result => result && result.outcome !== "passed")) {
        results[index] = blocked(entry, "Packaging was not run because a prerequisite test did not pass.",
          signal.aborted ? "cancelled" : "blocked");
        continue;
      }
      const artifactWorkspace = createWorkspace(repositoryRoot, path.join(runWorkspace.directory, "tmp"));
      const result = await executeSuite(entry, {
        repositoryRoot, workspace: artifactWorkspace, preparedWorkspace, environment, signal,
        aggregateReport: true, retainSuccessfulWorkspace: true,
      });
      try {
        if (result.status === "passed") artifacts.push(exportVsix(repositoryRoot, artifactWorkspace, entry.exportVsix));
      } catch (error) { result.status = "failed"; result.outcome = "failed"; result.error = `Package export failed: ${error.message}`; }
      finally {
        if (!result.cleaned) {
          try { artifactWorkspace.cleanup(); result.cleaned = true; delete result.retainedForPlan; }
          catch (error) { result.status = "failed"; result.outcome = "cleanup_error"; result.cleanupError = error.message; retainedWorkspace = runWorkspace.directory; }
        }
      }
      results[index] = result;
    }
  } finally {
    if (!retainedWorkspace && preparedWorkspace && fs.lstatSync(preparedWorkspace.directory, { throwIfNoEntry: false })) {
      try { preparedWorkspace.cleanup(); }
      catch (error) {
        retainedWorkspace = runWorkspace.directory;
        for (const result of results.filter(Boolean)) {
          result.status = "failed"; result.outcome = "cleanup_error"; result.cleanupError = error.message;
        }
      }
    }
    if (!retainedWorkspace) {
      try { runWorkspace.cleanup(); }
      catch (error) {
        retainedWorkspace = runWorkspace.directory;
        for (let index = 0; index < results.length; index++) if (results[index]) {
          results[index].status = "failed"; results[index].outcome = "cleanup_error";
          results[index].cleanupError = error.message;
        }
      }
    }
  }
  for (const [index, entry] of plan.entries.entries())
    if (!results[index]) throw new Error(`Test execution did not produce an outcome: ${entry.name}`);
  const summary = summarize(plan, results, Date.now() - started, retainedWorkspace);
  summary.build = build || { outcome: "not_requested", mode: options.noBuild ? "existing-artifacts" : "not-required" };
  summary.artifacts = artifacts;
  summary.interrupted = signal.aborted;
  summary.cases = results.reduce((counts, result) => {
    if (result.cases) for (const key of ["total", "passed", "skipped"]) counts[key] += result.cases[key];
    else counts.opaqueTasks++;
    return counts;
  }, { total: 0, passed: 0, skipped: 0, opaqueTasks: 0 });
  if (!summary.successful) report = writeRunFailure(repositoryRoot, summary, results, reportDirectory);
  return { summary, results, report };
}

module.exports = { runPlan, prerequisites, needsBuild };
