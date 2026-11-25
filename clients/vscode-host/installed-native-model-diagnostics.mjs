import { constants, lstatSync, realpathSync } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const ownerStages = new Set(["setup", "attachment", "catalogue", "selection", "token-count", "model-stream", "execution",
  "before-inference", "tool", "text", "usage", "cleanup", "native-identity", "native-reload", "native-attachment",
  "native-model-enable", "native-model-select", "native-model-stream", "native-model-select-execution",
  "native-model-execution", "native-model-complete", "native-chat-resolve", "native-chat-authorize",
  "native-chat-presentation", "native-chat-cancel", "native-action-enable", "native-action-source",
  "native-action-invocation", "native-action-cancel", "native-action-revoke"]);
const providerStages = new Set(["provider-info", "info-persist", "registry-change", "token-count", "token-persist",
  "response-start", "response-persist", "response-progress", "response-cancel"]);
const counterNames = ["tokenCalls", "nativeCalls", "loopCalls", "infoCalls", "registryEvents"];
const codes = new Set(["EPIPE", "ECONNRESET", "ECONNREFUSED", "ENOENT", "EACCES", "ENOSPC", "ERR_STREAM_DESTROYED",
  "ABORT_ERR", "NATIVE_DENIED", "NATIVE_ATTACHMENT_HEARTBEAT_TIMEOUT", "NATIVE_ATTACHMENT_SESSION_REVOKED",
  "NATIVE_ATTACHMENT_CLOSED", "NATIVE_CHAT_CANCELLED", "NATIVE_CHAT_CLOSED", "NATIVE_CHAT_TIMEOUT",
  "NATIVE_CHAT_PROTOCOL_INVALID", "NATIVE_CHAT_SESSION_REVOKED", "NATIVE_CHAT_DISPATCH_UNCERTAIN",
  "NATIVE_CHAT_CORE_CALLBACK_FAILED", "NATIVE_REQUEST_CANCELLED", "DIAGNOSTIC_ROOT_UNSAFE",
  "DIAGNOSTIC_ROOT_CHANGED", "DIAGNOSTIC_FILE_LIMIT", "NATIVE_CHAT_SESSION_MISMATCH", "NATIVE_CHAT_FRAME_LIMIT",
  "NATIVE_CHAT_BACKPRESSURE", "NATIVE_REQUEST_BINDING_MISMATCH", "NATIVE_REQUEST_INVALID"]);
const ringLimit = 256, fileLimit = 256 * 1024;
const diagnosticError = code => Object.assign(new Error(code), { code });

function causeCodes(error) {
  const result = [];
  try {
    for (let depth = 0; error && typeof error === "object" && depth < 3; depth++) {
      const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
      result.push(typeof code === "string" && codes.has(code) ? code : "UNCLASSIFIED");
      error = Object.getOwnPropertyDescriptor(error, "cause")?.value;
    }
  } catch { result.push("UNAVAILABLE"); }
  return result.slice(0, 3);
}
function privateProfile(root) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root
    || !basename(root).startsWith(".installed-host-") || /[\u0000-\u001f]/.test(root))
    throw diagnosticError("DIAGNOSTIC_ROOT_UNSAFE");
  let stat;
  try {
    stat = lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid())
      || (stat.mode & 0o7777n) !== 0o700n || realpathSync(root) !== root)
      throw diagnosticError("DIAGNOSTIC_ROOT_UNSAFE");
  } catch {
    throw diagnosticError("DIAGNOSTIC_ROOT_UNSAFE");
  }
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}

function observation(root, role) {
  const rootPin = privateProfile(root), allowedStages = role === "owner" ? ownerStages : providerStages;
  const path = join(root, `native-model-${role}-diagnostics-${process.pid}-${randomUUID()}.json`);
  const startedAt = performance.now(), ring = [], problems = [], problemCodes = new Set();
  const maxima = { rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0, loopLagMs: 0 };
  const peaks = { rssBytes: null, heapUsedBytes: null, heapTotalBytes: null, loopLagMs: null };
  const stageDurations = {}, stageDurationPeaks = {}, maximumCounters = {}, firstRegistryEvents = [];
  let stage = role === "owner" ? "setup" : "provider-info", cursor = 0, totalEvents = 0;
  let lastTick = startedAt, ticks = 0, stopped = false, finishPromise, frozenReport;
  let firstAbort, expectedShutdown, onStop = () => {}, lastMemory = {}, registryEventCount = 0;
  function problem(code, error) {
    if (problemCodes.has(code) || problems.length >= 32) return;
    problemCodes.add(code); problems.push({ code, causeCodes: causeCodes(error) });
  }
  function record(event) {
    totalEvents++;
    if (ring.length < ringLimit) ring.push(event);
    else { ring[cursor] = event; cursor = (cursor + 1) % ringLimit; }
  }
  function timestamp() {
    return { epochTimeMs: Date.now(), monotonicMs: performance.now(), pid: process.pid };
  }
  function peak(name, value, at, measuredBy) {
    if (!Number.isFinite(value) || value < 0) { problem("DIAGNOSTIC_MEMORY_INVALID"); return; }
    if (!peaks[name] || value > maxima[name]) {
      maxima[name] = value;
      peaks[name] = { value, stage, ...at, measuredBy };
    }
  }
  function sample(measuredBy = "sampler") {
    try {
      const memory = process.memoryUsage(), at = timestamp();
      peak("rssBytes", memory.rss, at, measuredBy);
      peak("heapUsedBytes", memory.heapUsed, at, measuredBy);
      peak("heapTotalBytes", memory.heapTotal, at, measuredBy);
      peak("loopLagMs", Math.max(0, at.monotonicMs - lastTick - 50), at, measuredBy);
      lastMemory = { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal };
      return { ...lastMemory };
    } catch (error) { problem("DIAGNOSTIC_MEMORY_FAILED", error); return {}; }
  }
  function setStage(value) {
    if (stopped) return;
    if (!allowedStages.has(value)) { problem("DIAGNOSTIC_STAGE_INVALID"); return; }
    stage = value;
    try { record({ event: "stage", stage, ...timestamp() }); }
    catch (error) { problem("DIAGNOSTIC_RECORD_FAILED", error); }
  }
  function counterSnapshot(values) {
    const result = {};
    if (values === undefined) return result;
    if (!values || typeof values !== "object") { problem("DIAGNOSTIC_COUNTER_INVALID"); return result; }
    for (const name of counterNames) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(values, name);
        if (!descriptor) continue;
        if (!("value" in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) {
          problem("DIAGNOSTIC_COUNTER_INVALID"); continue;
        }
        result[name] = descriptor.value;
        maximumCounters[name] = Math.max(maximumCounters[name] ?? 0, descriptor.value);
      } catch (error) { problem("DIAGNOSTIC_COUNTER_INVALID", error); }
    }
    return result;
  }
  function stopSampling() {
    if (stopped) return;
    stopped = true; clearInterval(timer); onStop();
  }
  function peakSnapshot() {
    return Object.fromEntries(Object.entries(peaks).map(([name, value]) => [name, value ? { ...value } : null]));
  }
  function snapshot() {
    if (!stopped) sample("snapshot");
    return {
      ...timestamp(), role, stage, stopped, elapsedMs: performance.now() - startedAt,
      currentMemory: { ...lastMemory }, maxima: { ...maxima }, peaks: peakSnapshot(),
      diagnosticProblems: problems.map(value => ({ ...value, causeCodes: [...value.causeCodes] })),
    };
  }
  function report() {
    return {
      schema: "pkm.installed-native-model-diagnostics/v1", role, pid: process.pid, ...timestamp(),
      elapsedMs: performance.now() - startedAt, stage, stopped, ticks, firstAbort: firstAbort ?? null,
      pairedPingPongAvailable: false,
      pairedPingPongLimitation: "The public authenticated session exposes no raw socket; no private transport accessor is used.",
      totalEvents, ringLimit, recentEvents: cursor ? [...ring.slice(cursor), ...ring.slice(0, cursor)] : [...ring],
      maxima: { ...maxima }, peaks: peakSnapshot(), maximumCounters: { ...maximumCounters }, stageDurations: { ...stageDurations },
      stageDurationPeaks: Object.fromEntries(Object.entries(stageDurationPeaks).map(([name, value]) => [name, {
        ...value, counters: { ...value.counters },
      }])),
      firstRegistryEvents: firstRegistryEvents.map(value => ({
        ...value, counters: { ...value.counters }, causeCodes: [...value.causeCodes],
      })),
      registryEventCount, registryEventsTruncated: registryEventCount > firstRegistryEvents.length,
      diagnosticProblems: problems.map(value => ({ ...value, causeCodes: [...value.causeCodes] })),
    };
  }
  function assertRoot() {
    const current = privateProfile(root);
    if (current.dev !== rootPin.dev || current.ino !== rootPin.ino || current.uid !== rootPin.uid)
      throw diagnosticError("DIAGNOSTIC_ROOT_CHANGED");
  }
  async function persist(value) {
    let handle, directory, bytes;
    try {
      assertRoot();
      bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
      if (bytes.length > fileLimit) throw diagnosticError("DIAGNOSTIC_FILE_LIMIT");
      directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const pin = await directory.stat({ bigint: true });
      if (pin.dev !== rootPin.dev || pin.ino !== rootPin.ino || pin.uid !== rootPin.uid)
        throw diagnosticError("DIAGNOSTIC_ROOT_CHANGED");
      // The owned directory FD prevents a replaced profile path redirecting the evidence write.
      handle = await open(`/proc/self/fd/${directory.fd}/${basename(path)}`,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(bytes); await handle.sync();
      await directory.sync();
      assertRoot();
    } catch (error) {
      problem("DIAGNOSTIC_FLUSH_FAILED", error);
    } finally {
      if (handle) try { await handle.close(); }
      catch (error) { problem("DIAGNOSTIC_CLOSE_FAILED", error); }
      if (directory) try { await directory.close(); }
      catch (error) { problem("DIAGNOSTIC_CLOSE_FAILED", error); }
    }
    if (problems.length) throw Object.assign(new AggregateError(
      problems.map(item => diagnosticError(item.code)), "Native model diagnostics failed; preserve the original workload outcome."),
    { code: "DIAGNOSTIC_OBSERVATION_FAILED", path,
      report: { ...value, diagnosticProblems: problems.map(item => ({ ...item, causeCodes: [...item.causeCodes] })) } });
    return { path, bytes: bytes.length, report: value };
  }
  function finish() {
    if (!finishPromise) {
      try {
        stopSampling();
        sample("finish");
        frozenReport ??= report();
        finishPromise = persist(frozenReport);
      } catch (error) {
        problem("DIAGNOSTIC_FINALIZE_FAILED", error);
        finishPromise = Promise.reject(diagnosticError("DIAGNOSTIC_OBSERVATION_FAILED"));
      }
      // The owner still receives this same failure by awaiting finish()/stop().
      void finishPromise.catch(() => {});
    }
    return finishPromise;
  }
  sample();
  const timer = setInterval(() => {
    try {
      const now = performance.now();
      peak("loopLagMs", Math.max(0, now - lastTick - 50),
        { epochTimeMs: Date.now(), monotonicMs: now, pid: process.pid }, "sampler");
      lastTick = now; ticks++;
      const memory = sample();
      if (ticks % 5 === 0) record({ event: "sample", stage, ...timestamp(), ...memory });
    } catch (error) { problem("DIAGNOSTIC_SAMPLE_FAILED", error); }
  }, 50);
  timer.unref();
  return {
    path, setStage, snapshot, finish, stop: finish,
    setOnStop(callback) { onStop = callback; },
    markExpected(reason) {
      if (stopped) return;
      if (!["close", "reload"].includes(reason)) { problem("DIAGNOSTIC_EXPECTED_INVALID"); return; }
      expectedShutdown = reason;
    },
    aborted(reason) {
      if (stopped || firstAbort) return;
      try {
        firstAbort = { ...timestamp(), stage, expected: !!expectedShutdown, expectedShutdown: expectedShutdown ?? null,
          causeCodes: causeCodes(reason), ...sample() };
        for (const name of ["timeoutMs", "elapsedMs", "ownerTimerOvershootMs"]) {
          try {
            const value = reason && typeof reason === "object" ? Object.getOwnPropertyDescriptor(reason, name)?.value : undefined;
            if (typeof value === "number" && Number.isFinite(value) && value >= 0) firstAbort[name] = value;
          } catch (error) { problem("DIAGNOSTIC_ABORT_FIELD_FAILED", error); }
        }
        record({ event: "session-abort", ...firstAbort });
      } catch (error) { problem("DIAGNOSTIC_ABORT_RECORD_FAILED", error); }
      if (!expectedShutdown) finish();
    },
    observe(value, fn, counters) {
      if (typeof fn !== "function") throw new TypeError("A synchronous original provider function is required.");
      const active = !stopped, valid = allowedStages.has(value);
      if (active && !valid) problem("DIAGNOSTIC_STAGE_INVALID");
      let start, threw = false, originalError;
      try { if (active) { stage = valid ? value : stage; start = performance.now(); } }
      catch (error) { problem("DIAGNOSTIC_CLOCK_FAILED", error); }
      try { return fn(); }
      catch (error) { threw = true; originalError = error; throw error; }
      finally {
        if (active) try {
          const end = performance.now(), durationMs = typeof start === "number" ? Math.max(0, end - start) : 0;
          const label = valid ? value : "unclassified";
          const event = { event: "provider-observe", stage: label, epochTimeMs: Date.now(), monotonicMs: end,
            pid: process.pid, startMonotonicMs: start, durationMs,
            counters: counterSnapshot(counters), threw, causeCodes: threw ? causeCodes(originalError) : [] };
          if (!stageDurationPeaks[label] || durationMs > stageDurations[label]) {
            stageDurations[label] = durationMs;
            stageDurationPeaks[label] = { value: durationMs, stage: label, epochTimeMs: event.epochTimeMs,
              monotonicMs: end, pid: process.pid, startMonotonicMs: start, counters: { ...event.counters } };
          }
          if (valid && value === "registry-change") {
            registryEventCount++;
            if (firstRegistryEvents.length < 8) firstRegistryEvents.push(event);
          }
          record(event);
        } catch (error) { problem("DIAGNOSTIC_RECORD_FAILED", error); }
      }
    },
  };
}

export function startOwnerObservation({ session, root }) {
  if (!session || !(session.signal instanceof AbortSignal)) throw diagnosticError("DIAGNOSTIC_SESSION_REQUIRED");
  const state = observation(root, "owner"), abort = () => state.aborted(session.signal.reason);
  state.setOnStop(() => session.signal.removeEventListener("abort", abort));
  session.signal.addEventListener("abort", abort, { once: true });
  if (session.signal.aborted) abort();
  return Object.freeze({ setStage: state.setStage, markExpected: state.markExpected, snapshot: state.snapshot,
    finish: state.finish, stop: state.stop });
}

export function createProviderObservation({ root, pid }) {
  if (pid !== process.pid) throw diagnosticError("DIAGNOSTIC_OWN_PID_REQUIRED");
  const state = observation(root, "provider");
  return Object.freeze({ observe: state.observe, snapshot: state.snapshot, finish: state.finish });
}

const originLimit = 64 * 1024;
const originPrefixes = {
  "[pkm.native-chat.first-cancel] ": "chat",
  "[pkm.native-attachment.first-stop] ": "attachment",
};
const chatOrigins = new Set(["invocation", "producer-lifetime", "registry-change", "deadline", "text-sink", "usage-sink", "explicit-cancel"]);
const attachmentOrigins = new Set(["protocol", "socket-close", "socket-error", "requested-close", "signer-abort", "authentication-deadline"]);
const chatStages = new Set(["catalogue", "selection", "token-count", "model-stream", "execution", "execution-token-count",
  "execution-before-inference", "execution-model-send", "execution-model-stream", "execution-tool", "execution-usage"]);
const attachmentPhases = new Set(["challenge", "signing", "attaching", "attached", "closed"]);
const logDirectoryName = /^(?:\d{8}T\d{6}|window\d{1,4}|exthost\d{0,4}|output_logging_\d{8}T\d{6})$/;
const logFileName = /^(?:renderer\.log|exthost\.log|\d{1,6}-pkm-v5 Experimental\.log)$/;

function originRow(line) {
  const match = Object.entries(originPrefixes).map(([prefix, kind]) => ({ prefix, kind, index: line.indexOf(prefix) }))
    .filter(value => value.index >= 0).sort((a, b) => a.index - b.index)[0];
  if (!match) return undefined;
  const text = line.slice(match.index + match.prefix.length).trimStart();
  if (!text.startsWith("{")) throw diagnosticError("DIAGNOSTIC_ORIGIN_ROW_INVALID");
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (++depth > 32) throw diagnosticError("DIAGNOSTIC_ORIGIN_ROW_INVALID");
    } else if (char === "}" || char === "]") {
      if (--depth === 0) { end = index + 1; break; }
    }
  }
  if (end < 0) throw diagnosticError("DIAGNOSTIC_ORIGIN_ROW_INVALID");
  const value = JSON.parse(text.slice(0, end));
  const origins = match.kind === "chat" ? chatOrigins : attachmentOrigins;
  if (!origins.has(value.origin) || typeof value.expectedShutdown !== "boolean"
    || !(match.kind === "chat" ? chatStages.has(value.stage) : attachmentPhases.has(value.phase)))
    throw diagnosticError("DIAGNOSTIC_ORIGIN_ROW_INVALID");
  const result = { kind: match.kind, origin: value.origin, expectedShutdown: value.expectedShutdown };
  result[match.kind === "chat" ? "stage" : "phase"] = value[match.kind === "chat" ? "stage" : "phase"];
  for (const name of ["pid", "epochTimeMs", "monotonicMs", "elapsedMs", "rssBytes", "heapUsedBytes", "heapTotalBytes",
    "stageElapsedMs", "deadlineMs", "registryRevision"]) {
    if (value[name] === undefined && ["stageElapsedMs", "deadlineMs", "registryRevision"].includes(name)) continue;
    if (typeof value[name] !== "number" || !Number.isFinite(value[name]) || value[name] < 0
      || (name === "pid" && (!Number.isSafeInteger(value[name]) || value[name] < 1)))
      throw diagnosticError("DIAGNOSTIC_ORIGIN_ROW_INVALID");
    result[name] = value[name];
  }
  if (!Array.isArray(value.causeCodes) || value.causeCodes.length > 3)
    throw diagnosticError("DIAGNOSTIC_ORIGIN_ROW_INVALID");
  result.causeCodes = value.causeCodes.map(code =>
    typeof code === "string" && (codes.has(code) || ["UNCLASSIFIED", "UNAVAILABLE"].includes(code)) ? code : "UNCLASSIFIED");
  const time = line.slice(0, match.index).match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z?/);
  if (time) result.sourceLogTime = time[0];
  return result;
}

export async function collectFirstOriginLogs({ root }) {
  const rootPin = privateProfile(root);
  const path = join(root, `native-model-first-origin-${process.pid}-${randomUUID()}.json`);
  const rows = [], problems = [], problemCodes = new Set(), seen = new Set(), scannedFiles = [];
  const coverage = { logTreePresent: false, directories: 0, entries: 0, candidateFiles: 0, bytesRead: 0,
    overlongLines: 0, filesAppendedAfterSnapshot: 0, duplicates: 0, truncated: false,
    prefixes: { chat: false, attachment: false } };
  const bounds = { maxDepth: 4, maxDirectories: 128, maxEntries: 2048, maxFiles: 48,
    maxReadBytes: 4 * 1024 * 1024, maxFileReadBytes: 512 * 1024, maxLineBytes: 16 * 1024,
    maxRows: 256, maxOutputBytes: originLimit };
  let rootHandle, rowsBytes = 0, stopped = false;
  function problem(code, error) {
    if (problemCodes.has(code) || problems.length >= 32) return;
    problemCodes.add(code); problems.push({ code, causeCodes: causeCodes(error) });
  }
  function budget(code) { coverage.truncated = true; stopped = true; problem(code); }
  async function directoryAt(parent, name) {
    const handle = await open(`/proc/self/fd/${parent.fd}/${name}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat({ bigint: true });
      if (stat.uid !== rootPin.uid || (stat.mode & 0o002n)) throw diagnosticError("DIAGNOSTIC_LOG_UNSAFE_ENTRY");
      return handle;
    } catch (error) {
      try { await handle.close(); } catch (cleanup) { problem("DIAGNOSTIC_LOG_CLOSE_FAILED", cleanup); }
      throw error;
    }
  }
  function lineRead(line, sourceFile, sourceLine) {
    try {
      const row = originRow(line);
      if (!row) return;
      coverage.prefixes[row.kind] = true;
      const { sourceLogTime, ...event } = row;
      const key = JSON.stringify(event);
      if (seen.has(key)) { coverage.duplicates++; return; }
      const saved = { ...row, sourceFile, sourceLine }, bytes = Buffer.byteLength(JSON.stringify(saved));
      if (rows.length >= bounds.maxRows || rowsBytes + bytes > originLimit - 16 * 1024) {
        budget("DIAGNOSTIC_ORIGIN_OUTPUT_LIMIT"); return;
      }
      seen.add(key); rows.push(saved); rowsBytes += bytes;
    } catch (error) { problem("DIAGNOSTIC_ORIGIN_ROW_INVALID", error); }
  }
  async function fileAt(directory, name, relative) {
    if (++coverage.candidateFiles > bounds.maxFiles) { budget("DIAGNOSTIC_LOG_FILE_LIMIT"); return; }
    let handle;
    try {
      handle = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== Number(rootPin.uid) || stat.nlink !== 1 || (stat.mode & 0o002))
        throw diagnosticError("DIAGNOSTIC_LOG_UNSAFE_ENTRY");
      const count = Math.min(stat.size, bounds.maxFileReadBytes, bounds.maxReadBytes - coverage.bytesRead);
      if (count < stat.size) budget("DIAGNOSTIC_LOG_READ_LIMIT");
      scannedFiles.push(relative);
      let offset = 0, pending = "", pendingBytes = 0, lineNumber = 1, discarded = false;
      const buffer = Buffer.alloc(16 * 1024), decoder = new TextDecoder();
      while (offset < count && (!stopped || coverage.bytesRead < bounds.maxReadBytes)) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, count - offset), offset);
        if (!bytesRead) break;
        offset += bytesRead; coverage.bytesRead += bytesRead;
        const text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        for (const char of text) {
          if (char === "\n") {
            if (!discarded) lineRead(pending, relative, lineNumber);
            pending = ""; pendingBytes = 0; discarded = false; lineNumber++;
          } else if (!discarded) {
            pending += char; pendingBytes += Buffer.byteLength(char);
            if (pendingBytes > bounds.maxLineBytes) {
              coverage.overlongLines++; coverage.truncated = true;
              if (Object.keys(originPrefixes).some(prefix => pending.includes(prefix)))
                problem("DIAGNOSTIC_ORIGIN_LINE_LIMIT");
              pending = ""; discarded = true;
            }
          }
        }
        if (stopped) break;
      }
      if (pending && !discarded && offset === stat.size) lineRead(pending + decoder.decode(), relative, lineNumber);
      const after = await handle.stat();
      if (after.size > stat.size) coverage.filesAppendedAfterSnapshot++;
    } catch (error) { problem("DIAGNOSTIC_LOG_READ_FAILED", error); }
    finally {
      if (handle) try { await handle.close(); }
      catch (error) { problem("DIAGNOSTIC_LOG_CLOSE_FAILED", error); }
    }
  }
  async function walk(directory, relative, depth) {
    if (++coverage.directories > bounds.maxDirectories) { budget("DIAGNOSTIC_LOG_DIRECTORY_LIMIT"); return; }
    const entries = await opendir(`/proc/self/fd/${directory.fd}`, { bufferSize: 16 });
    for await (const entry of entries) {
      if (stopped) break;
      if (++coverage.entries > bounds.maxEntries) { budget("DIAGNOSTIC_LOG_ENTRY_LIMIT"); break; }
      if (logFileName.test(entry.name)) {
        if (!entry.isFile()) { problem("DIAGNOSTIC_LOG_UNSAFE_ENTRY"); continue; }
        await fileAt(directory, entry.name, `${relative}/${entry.name}`);
      } else if (logDirectoryName.test(entry.name)) {
        if (entry.isSymbolicLink()) { problem("DIAGNOSTIC_LOG_UNSAFE_ENTRY"); continue; }
        if (!entry.isDirectory()) continue;
        if (depth >= bounds.maxDepth) { budget("DIAGNOSTIC_LOG_DEPTH_LIMIT"); break; }
        let child;
        try { child = await directoryAt(directory, entry.name); await walk(child, `${relative}/${entry.name}`, depth + 1); }
        catch (error) { problem("DIAGNOSTIC_LOG_SCAN_FAILED", error); }
        finally {
          if (child) try { await child.close(); }
          catch (error) { problem("DIAGNOSTIC_LOG_CLOSE_FAILED", error); }
        }
      }
    }
  }
  try {
    rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const pin = await rootHandle.stat({ bigint: true });
    if (pin.dev !== rootPin.dev || pin.ino !== rootPin.ino || pin.uid !== rootPin.uid)
      throw diagnosticError("DIAGNOSTIC_ROOT_CHANGED");
    let user, logs;
    try {
      user = await directoryAt(rootHandle, "u"); logs = await directoryAt(user, "logs");
      coverage.logTreePresent = true; await walk(logs, "u/logs", 0);
    } catch (error) { problem(error.code === "ENOENT" ? "DIAGNOSTIC_LOG_TREE_MISSING" : "DIAGNOSTIC_LOG_SCAN_FAILED", error); }
    finally {
      for (const handle of [logs, user]) if (handle) try { await handle.close(); }
      catch (error) { problem("DIAGNOSTIC_LOG_CLOSE_FAILED", error); }
    }
    const current = privateProfile(root);
    if (current.dev !== rootPin.dev || current.ino !== rootPin.ino) throw diagnosticError("DIAGNOSTIC_ROOT_CHANGED");
  } catch (error) { problem("DIAGNOSTIC_LOG_ROOT_FAILED", error); }
  const limitations = ["Only allowlisted owned-profile log paths and bounded byte snapshots were scanned.",
    "Sanitized log observations are not independently signed transport evidence; no zero-cancellation proof is inferred."];
  if (!rows.length) limitations.push("No first-origin rows were captured; this is a coverage gap, not zero unexpected cancellations.");
  if (!coverage.prefixes.chat) limitations.push("Chat first-cancel prefix was not captured.");
  if (!coverage.prefixes.attachment) limitations.push("Attachment first-stop prefix was not captured.");
  if (coverage.truncated) limitations.push("A scan or row bound was reached; coverage is incomplete.");
  if (coverage.filesAppendedAfterSnapshot) limitations.push("Some files grew after their bounded snapshots; later rows are outside coverage.");
  const report = { schema: "pkm.installed-native-first-origin-logs/v1", pid: process.pid, epochTimeMs: Date.now(),
    bounds, coverage, scannedFiles, rows, unexpectedRows: rows.filter(row => !row.expectedShutdown).length,
    zeroUnexpectedCancellationProven: false, limitations, diagnosticProblems: problems };
  let output, bytes;
  try {
    const current = privateProfile(root);
    if (!rootHandle || current.dev !== rootPin.dev || current.ino !== rootPin.ino)
      throw diagnosticError("DIAGNOSTIC_ROOT_CHANGED");
    bytes = Buffer.from(JSON.stringify(report) + "\n");
    if (bytes.length > originLimit) throw diagnosticError("DIAGNOSTIC_FILE_LIMIT");
    output = await open(`/proc/self/fd/${rootHandle.fd}/${basename(path)}`,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await output.writeFile(bytes); await output.sync(); await rootHandle.sync();
    const after = privateProfile(root);
    if (after.dev !== rootPin.dev || after.ino !== rootPin.ino) throw diagnosticError("DIAGNOSTIC_ROOT_CHANGED");
  } catch (error) { problem("DIAGNOSTIC_ORIGIN_FLUSH_FAILED", error); }
  finally {
    for (const handle of [output, rootHandle]) if (handle) try { await handle.close(); }
    catch (error) { problem("DIAGNOSTIC_LOG_CLOSE_FAILED", error); }
  }
  if (problems.length) throw Object.assign(new AggregateError(problems.map(value => diagnosticError(value.code)),
    "First-origin log collection failed; retain the original workload outcome."),
  { code: "DIAGNOSTIC_FIRST_ORIGIN_FAILED", path, report });
  return { path, bytes: bytes.length, report };
}
