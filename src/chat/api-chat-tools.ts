import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn, execFile } from "child_process";
import { StringDecoder } from "string_decoder";
import { createHash, randomUUID } from "crypto";
import { diffLines } from "diff";
import { ApiChatTool } from "./api-chat-client";
import { QuestionSchema, questionSchema, validateQuestionAnswer } from "./chat-questions";
import { cancelChatProcess, chatProcessEnvironment, getChatProcess, launchChatProcess, readChatProcessOutput } from "./chat-process-runtime";
import { diagnosticLogs } from "./chat-diagnostic-logs";

export interface ApiChatEditChange {
  path: string;
  workspace: number;
  appliedAt: string;
  beforeHash: string;
  afterHash: string;
  added?: number;
  removed?: number;
  saved: false;
  attribution: "exact" | "unknown";
}

export const builtinToolCatalog = [
  { name: "read_file", label: "Read files", permission: "Workspace text files" },
  { name: "find_files", label: "Find files", permission: "Workspace file names" },
  { name: "list_directory", label: "List directory", permission: "Read directory names; outside-workspace access follows this Chat's permissions" },
  { name: "search_text", label: "Search text", permission: "Workspace literal text search" },
  { name: "session_info", label: "Session information", permission: "Current Session identity, model and advertised tools only" },
  { name: "diagnostic_logs", label: "Read VS Code diagnostic logs", permission: "Approved host-local VS Code log roots and allowlisted log files only; bounded redacted excerpts, never credentials" },
  { name: "record_harness", label: "Record task / planning / validation", permission: "Explicit current-task observations only; does not execute or complete the managed Task" },
  { name: "list_chats", label: "List Chats", permission: "Read-only workspace Chat IDs, titles and status; no conversation bodies" },
  { name: "ask_chat", label: "Ask another Chat", permission: "Approval required; one idle target per turn; no recursive delegation or automatic Tasks" },
  { name: "spawn_workers", label: "Spawn parallel workers", permission: "Shared task-tree budget; automatic small batches, explicit approval above threshold; child tools retain permissions" },
  { name: "pkm_search", label: "Search PKM knowledge", permission: "Read-only local knowledge and cached subscription titles" },
  { name: "pkm_read", label: "Read PKM knowledge", permission: "Read-only bounded local knowledge and cached subscription content" },
  { name: "memory_read", label: "Read Chat memory", permission: "Read-only memory topics and earlier messages of this Chat only" },
  { name: "replace_text", label: "Edit text", permission: "Shared non-destructive Chat permission; edits remain unsaved" },
  { name: "save_file", label: "Save file", permission: "Shared non-destructive Chat permission; expected content hash required" },
  { name: "run_process", label: "Run programs", permission: "Remembered program-tool permission or Allow All; non-interactive process" },
  { name: "process_get", label: "Read background process status", permission: "Read-only original process receipt in this Chat; never relaunches" },
  { name: "process_output", label: "Read background process output", permission: "Read-only bounded byte ranges of this Chat's process logs" },
  { name: "process_cancel", label: "Cancel background process", permission: "Explicit cancellation of the original process handle; does not cancel other Chats" },
  { name: "ask_user", label: "Ask a question", permission: "Inline Chat form / single / multiple choices; never request secrets" },
  { name: "cross_machine_collaboration", label: "PKM Portal", permission: "Open local pairing/task controls on the existing Chat transport; remote instructions require target approval" },
  { name: "find_actions", label: "Find Actions and templates", permission: "Local Action contracts, templates and readiness only" },
  { name: "run_action", label: "Run or resume an Action", permission: "Approved pinned durable invocation; original Run returns its result to this Chat" },
  { name: "ask_session", label: "Ask a native Session", permission: "Approval required; one idle target per turn; no recursive waking" },
];

export function relativeToolPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\0:]/.test(value)) throw new Error("Use a workspace-relative path.");
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").some(part => !part || part.startsWith(".") || part === "node_modules")) throw new Error("Hidden, excluded or outside-workspace paths are not allowed.");
  if (/\.(pem|key)$/i.test(normalized) || /(^|\/)(credentials|id_rsa|id_ed25519)(\.|$)/i.test(normalized)) throw new Error("Attach sensitive files explicitly instead of using tools.");
  return normalized;
}

function filesystemToolPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\0")) throw new Error("Provide a bounded filesystem path.");
  const normalized = value.replace(/\\/g, "/");
  if (normalized.includes(":") && !(process.platform === "win32" && /^[a-z]:\//i.test(normalized))) throw new Error("Choose a filesystem path, not a URI.");
  if (normalized.split("/").some(part => part.startsWith(".") && part !== "." && part !== ".." || part === "node_modules")) throw new Error("Hidden or excluded paths are not allowed.");
  if (/\.(pem|key)$/i.test(normalized) || /(^|\/)(credentials|id_rsa|id_ed25519)(\.|$)/i.test(normalized)) throw new Error("Attach sensitive files explicitly instead of using tools.");
  return normalized;
}

export function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener("abort", cancel); reject(new Error("Request cancelled.")); };
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener("abort", cancel); resolve(value); }, error => { signal.removeEventListener("abort", cancel); reject(error); });
    if (signal.aborted) cancel();
  });
}

export function createBuiltinTools(enabled: string[], host: typeof vscode = vscode, onApproval?: (name: string, waiting: boolean) => void, onEdit?: (change: ApiChatEditChange) => void, requestApproval?: (name: string, prompt: string, detail: string, signal: AbortSignal, boundary?: "workspace" | "outside-workspace", resource?: string) => Promise<boolean>, executionRoots?: readonly vscode.Uri[], processEvidenceDirectory?: string, requestQuestion?: (prompt: string, schema: QuestionSchema, signal: AbortSignal, verify?: (answer: Record<string, unknown>) => Promise<void>) => Promise<Record<string, unknown> | undefined>, portalContextId?: string): ApiChatTool[] {
  const roots = executionRoots ? [...executionRoots] : (host.workspace.workspaceFolders || []).map(folder => folder.uri);
  const active = (signal: AbortSignal) => { if (signal.aborted) throw new Error("Request cancelled."); if (host.workspace.isTrusted === false) throw new Error("Tools require a trusted workspace."); };
  const approve = async (name: string, prompt: string, detail: string, action: string, signal: AbortSignal, boundary: "workspace" | "outside-workspace" = "outside-workspace", resource?: string) => {
    onApproval?.(name, true);
    try { return requestApproval ? await requestApproval(name, prompt, detail, signal, boundary, resource) ? action : undefined : await abortable(host.window.showWarningMessage(prompt, { modal: true, detail }, action), signal); }
    finally { onApproval?.(name, false); }
  };
  const rootFor = (args: Record<string, unknown>) => {
    const index = args.workspace ?? 0;
    if (!Number.isSafeInteger(index) || Number(index) < 0 || !roots[Number(index)]) throw new Error("Choose an existing workspace index.");
    if (!["file", "vscode-remote"].includes(roots[Number(index)].scheme)) throw new Error("Tools require a filesystem-backed workspace.");
    return roots[Number(index)];
  };
  const physicalPath = async (args: Record<string, unknown>, value: unknown, signal: AbortSignal) => {
    active(signal);
    const root = rootFor(args);
    const requested = filesystemToolPath(value);
    const uri = host.Uri.file(path.resolve(root.fsPath, requested));
    const [base, target] = await abortable(Promise.all([fs.promises.realpath(root.fsPath), fs.promises.realpath(uri.fsPath)]), signal);
    const physicalRelative = path.relative(base, target);
    const outside = physicalRelative.startsWith(".." + path.sep) || physicalRelative === ".." || path.isAbsolute(physicalRelative);
    filesystemToolPath(outside ? target : physicalRelative || ".");
    return { uri, target, outside };
  };
  const resolve = async (args: Record<string, unknown>, signal: AbortSignal, name: string) => {
    const location = await physicalPath(args, args.path, signal);
    if (location.outside && await approve(name, `Allow outside-workspace access to ${location.target}?`, `Resolved file: ${location.target}\nContent is sent to the model.`, "Allow access", signal, "outside-workspace", location.target) !== "Allow access") throw new Error("Outside-workspace access declined by the user.");
    active(signal);
    if (await abortable(fs.promises.realpath(location.uri.fsPath), signal) !== location.target) throw new Error("File path changed after approval.");
    const uri = host.Uri.file(location.target);
    if ((await abortable(host.workspace.fs.stat(uri), signal)).size > 160_000) throw new Error("Tool file exceeds 160 KB.");
    return uri;
  };
  const documentFor = async (args: Record<string, unknown>, signal: AbortSignal, name: string) => {
    const uri = await resolve(args, signal, name);
    const document = await abortable(host.workspace.openTextDocument(uri), signal);
    const text = document.getText();
    if (text.includes("\0") || Buffer.byteLength(text, "utf8") > 160_000) throw new Error("Choose a text file smaller than 160 KB.");
    return document;
  };
  const files = async (args: Record<string, unknown>, signal: AbortSignal) => {
    const root = rootFor(args);
    const glob = args.glob ?? "**/*";
    if (typeof glob !== "string" || glob.length > 256 || glob.startsWith("/") || glob.includes("..") || glob.includes(":")) throw new Error("Use a bounded workspace-relative glob.");
    const token = new host.CancellationTokenSource();
    const cancel = () => token.cancel(); signal.addEventListener("abort", cancel, { once: true });
    try {
      active(signal);
      const uris = await abortable(host.workspace.findFiles(new host.RelativePattern(root, glob), "**/{.*,node_modules}/**", 200, token.token), signal);
      return { root, uris };
    } finally { signal.removeEventListener("abort", cancel); token.dispose(); }
  };
  const shared = { workspace: { type: "integer", minimum: 0, description: `Workspace folder index; default 0. ${roots.map((root, index) => `${index}: ${path.basename(root.fsPath)}`).join(", ").slice(0, 1000)}` } };
  const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[], execute: ApiChatTool["execute"]): ApiChatTool => ({
    name, description, parameters: { type: "object", properties: { ...shared, ...properties }, required, additionalProperties: false }, execute,
  });
  const tools = [
    definition("diagnostic_logs", "Discover/read host-local VS Code and Copilot diagnostic logs without opening arbitrary hidden files. Use discover first, then read with its exact root/file. Only allowlisted logs; redacted bounded diagnostic lines. beforeByte pages older bytes; omittedLines means excerpts within this window were omitted. No credentials, settings, complete prompts or client logs from other machines. This is a separate explicit diagnostic permission, not permission to bypass denied filesystem reads.",
      { operation: { type:"string", enum:["discover", "read"] }, root:{ type:"string" }, file:{ type:"string", maxLength:1024 },
        beforeByte:{ type:"integer", minimum:1 }, query:{ type:"string", maxLength:120, description:"Optional literal case-insensitive filter within diagnostic lines in this byte window." } }, ["operation"], async (args, signal) => {
        active(signal);
        if (await approve("diagnostic_logs", "Read host-local VS Code diagnostic logs?",
          "Only approved VS Code log roots and allowlisted diagnostic filenames. Bounded redacted excerpts are sent to the selected model; no credential files or arbitrary hidden paths.", "Read diagnostic logs", signal) !== "Read diagnostic logs") throw new Error("Diagnostic log access declined by the user.");
        return JSON.stringify(diagnosticLogs(args, signal));
      }),
    definition("cross_machine_collaboration", "Open PKM Portal (peer-to-peer connection) controls when the user wants to pair two agents or send a remote task. The human can start a Portal (creates a private Room; the initiator controls), accept a Portal link (this machine becomes controlled) or manage an existing pairing over the Chat WebSocket, not SSH. The human selects pairing/target/instruction; opening controls is not evidence of pairing, task acceptance or execution. Never request or pass pairing secrets through the model.", {}, [], async (_args, signal) => {
      active(signal);
      if (!portalContextId) throw new Error("Portal controls require an owning Chat.");
      await host.commands.executeCommand("personalKnowledge.peerCollaboration", { id: portalContextId, label: portalContextId });
      active(signal);
      return JSON.stringify({ controlsClosed: true, executionStatus: "not-confirmed", instruction: "Use the original peer task receipt to determine execution status." });
    }),
    definition("portal", "Use this Chat's approved Portal to test or work on the remote machine. send returns an original requestId, not completion; use get for its remote answer. Never execute a remote instruction locally or claim success without a completed receipt. open prompts the human for pairing; never pass links or secrets through this tool. switch requires explicit consent at both ends.", {
      operation: { type: "string", enum: ["open", "status", "send", "get", "cancel", "disconnect", "switch", "permissions", "files", "reattach"] },
      paths: { type: "array", items: { type: "string" }, maxItems: 64, description: "files only: absolute local file paths in one immutable batch; controlled user must permit every batch. Never install automatically." },
      prompt: { type: "string", maxLength: 16000 },
      requestId: { type: "string", description: "Stable UUID per task. Reuse only for that exact instruction; get/cancel use the original ID." },
    }, ["operation"], async (args, signal) => {
      active(signal);
      if (!portalContextId) throw new Error("Portal execution requires an owning Chat.");
      if (args.operation === "open") {
        await host.commands.executeCommand("personalKnowledge.peerCollaboration", { id: portalContextId, label: portalContextId });
        return JSON.stringify({ contextId: portalContextId, instruction: "Use status to verify pairing; opening controls is not proof of connection." });
      }
      return JSON.stringify(await abortable(host.commands.executeCommand("personalKnowledge.portalControl", { ...args, contextId: portalContextId }), signal));
    }),
    definition("ask_user", "Ask non-sensitive questions in the Chat message area. Supply answer_schema for a multi-field form, or options for single/multiple choice. Cancellation is not consent. Never ask for secrets.", { question: { type: "string", maxLength: 300 }, answer_schema: { type: "object" }, options: { type: "array", maxItems: 12, items: { type: "string", maxLength: 120 } }, multiSelect: { type: "boolean" }, allowFreeText: { type: "boolean" } }, ["question"], async (args, signal) => {
      active(signal);
      if (typeof args.question !== "string" || !args.question.trim() || args.question.length > 300) throw new Error("Provide a bounded nonempty question.");
      if (requestQuestion) {
        const options = args.options ?? [];
        if (!Array.isArray(options) || options.length > 12 || options.some(option => typeof option !== "string" || !option.trim() || option.length > 120) || new Set(options).size !== options.length
          || args.multiSelect !== undefined && typeof args.multiSelect !== "boolean" || args.allowFreeText !== undefined && typeof args.allowFreeText !== "boolean") throw new Error("Provide distinct bounded options and boolean choice settings.");
        const schema = args.answer_schema ? questionSchema(args.answer_schema) : questionSchema({
          type: "object", properties: {
            ...(options.length ? { selected: args.multiSelect === true ? { type: "array", items: { type: "string", enum: options } }
              : { type: "string", enum: options } } : {}),
            ...(args.allowFreeText !== false ? { freeText: { type: "string", title: "Other answer", maxLength: 4000 } } : {}),
          }, required: args.allowFreeText === false ? ["selected"] : [],
        });
        onApproval?.("ask_user", true);
        try {
          const verify = async (answer: Record<string, unknown>) => {
            validateQuestionAnswer(schema, answer);
            if (!args.answer_schema && (!answer.selected && !String(answer.freeText || "").trim() || Array.isArray(answer.selected) && !answer.selected.length && !String(answer.freeText || "").trim())) throw new Error("Choose an option or enter an answer.");
          };
          const answer = await requestQuestion(args.question, schema, signal, verify);
          active(signal);
          if (!answer) return JSON.stringify({ selected: [], freeText: null, cancelled: true });
          validateQuestionAnswer(schema, answer);
          if (args.answer_schema) return JSON.stringify({ answer, cancelled: false });
          await verify(answer);
          return JSON.stringify({ selected: Array.isArray(answer.selected) ? answer.selected : answer.selected ? [answer.selected] : [], freeText: String(answer.freeText || "").trim() || null, cancelled: false });
        } finally { onApproval?.("ask_user", false); }
      }
      if (typeof args.question !== "string" || !args.question.trim() || args.question.length > 300 || !Array.isArray(args.options) || args.options.length > 12 || args.options.some(option => typeof option !== "string" || !option.trim() || option.length > 120) || new Set(args.options).size !== args.options.length || args.multiSelect !== undefined && typeof args.multiSelect !== "boolean" || args.allowFreeText !== undefined && typeof args.allowFreeText !== "boolean" || !args.options.length && args.allowFreeText === false) throw new Error("Provide a bounded question and up to 12 distinct options, or allow free text.");
      const token = new host.CancellationTokenSource();
      const cancel = () => token.cancel(); signal.addEventListener("abort", cancel, { once: true });
      onApproval?.("ask_user", true);
      try {
        const items = (args.options as string[]).map((label, id) => ({ label, id }));
        if (args.allowFreeText !== false) items.push({ label: "Other answer...", id: -1 });
        const choice = args.options.length ? await abortable(host.window.showQuickPick(items, { title: "PKM question · response sent to model", placeHolder: args.question, canPickMany: args.multiSelect === true, ignoreFocusOut: false }, token.token), signal) : items;
        active(signal);
        if (!choice || Array.isArray(choice) && !choice.length) return JSON.stringify({ selected: [], freeText: null, cancelled: true });
        const selected = Array.isArray(choice) ? choice : [choice];
        if (selected.some(item => !items.includes(item))) throw new Error("Invalid question selection.");
        let freeText: string | undefined;
        if (selected.some(item => item.id === -1)) {
          freeText = await abortable(host.window.showInputBox({ title: "PKM answer · sent to model", prompt: `${args.question} Do not enter secrets.`, ignoreFocusOut: false, validateInput: value => value.trim() && value.length <= 4000 ? undefined : "Enter a non-sensitive answer up to 4,000 characters." }, token.token), signal);
          active(signal);
          if (freeText === undefined) return JSON.stringify({ selected: [], freeText: null, cancelled: true });
          if (!freeText.trim() || freeText.length > 4000) throw new Error("Invalid answer.");
        }
        return JSON.stringify({ selected: selected.filter(item => item.id >= 0).map(item => item.label), freeText: freeText?.trim() || null, cancelled: false });
      } finally { signal.removeEventListener("abort", cancel); token.dispose(); onApproval?.("ask_user", false); }
    }),
    definition("run_process", "Run a non-interactive native program with separate arguments, no automatic shell. Foreground timeout defaults to 30 seconds, maximum 120. background=true requires an explicit timeoutSeconds (1-86400) and idempotency_key: explicitly approved execution survives window reload until its deadline, process_cancel or the user pressing Chat Stop (Stop cancels every background process of this Chat). Reuse the exact key/inputs to recover the original handle, never to retry a side effect. Read status/output using process_get/process_output. No automatic restart.", { program: { type: "string" }, arguments: { type: "array", items: { type: "string" }, maxItems: 32 }, cwd: { type: "string" }, timeoutSeconds: { type: "integer", minimum: 1, maximum: 86400 }, background: { type: "boolean" }, idempotency_key: { type: "string", minLength: 1, maxLength: 200 } }, ["program", "arguments"], async (args, signal) => {
      active(signal);
      if (typeof args.program !== "string" || !args.program || args.program.length > 1024 || args.program.includes("\0") || !Array.isArray(args.arguments) || args.arguments.length > 32 || args.arguments.some(argument => typeof argument !== "string" || argument.includes("\0")) || JSON.stringify(args.arguments).length > 8000) throw new Error("Provide a program and up to 32 bounded string arguments.");
      if (process.platform === "win32" && /\.(cmd|bat)$/i.test(args.program)) throw new Error("Use a native executable, such as node.exe, instead of a Windows batch wrapper.");
      const seconds = Number(args.timeoutSeconds ?? 30);
      if (args.background !== undefined && typeof args.background !== "boolean") throw new Error("background must be a boolean.");
      const background = args.background === true;
      if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > (background ? 86400 : 120)) throw new Error(background ? "Choose a background deadline of 1-86400 seconds." : "Choose a process timeout of 1-120 seconds.");
      if (background && (args.timeoutSeconds === undefined || !processEvidenceDirectory || typeof args.idempotency_key !== "string"
        || !args.idempotency_key.trim() || args.idempotency_key.length > 200)) throw new Error("Background launch requires persistent Chat evidence, an explicit timeoutSeconds and idempotency_key.");
      if (!background && args.idempotency_key !== undefined) throw new Error("idempotency_key is supported only for background execution.");
      const location = await physicalPath(args, args.cwd || ".", signal);
      const cwdUri = location.uri; const cwd = location.target;
      const approval = await approve(background ? "run_process_background" : "run_process", `Run program ${args.program}?`, `Working directory: ${cwd}\nArguments: ${JSON.stringify(args.arguments)}\nTimeout: ${seconds}s\n${background ? "\nDURABLE BACKGROUND: continues after window reload. Chat Stop or process_cancel with the original handle cancels it. Reusing this key/inputs only recovers that execution; unknown outcomes are not retried.\n" : ""}\nThis program can modify files outside this workspace and access the network. Output is sent to the model. Stdin is closed.`, "Run program", signal);
      active(signal);
      if (approval !== "Run program") throw new Error("Program launch declined by the user.");
      if (await abortable(fs.promises.realpath(cwdUri.fsPath), signal) !== cwd) throw new Error("Working directory changed after approval.");
      if (background) return JSON.stringify(await launchChatProcess(processEvidenceDirectory!, args.idempotency_key as string,
        { program: args.program, arguments: args.arguments as string[], cwd, timeoutSeconds: seconds }));
      const environment = chatProcessEnvironment();
      let stdoutLog: string | undefined; let stderrLog: string | undefined; let outputHandle: string | undefined;
      let stdoutDescriptor: number | undefined; let stderrDescriptor: number | undefined;
      if (processEvidenceDirectory) {
        fs.mkdirSync(processEvidenceDirectory, { recursive: true, mode: 0o700 });
        const identity = `${Date.now()}-${randomUUID()}`;
        outputHandle = `foreground_${identity}`;
        stdoutLog = path.join(processEvidenceDirectory, `${identity}.stdout.log`);
        stderrLog = path.join(processEvidenceDirectory, `${identity}.stderr.log`);
        stdoutDescriptor = fs.openSync(stdoutLog, "wx", 0o600);
        try { stderrDescriptor = fs.openSync(stderrLog, "wx", 0o600); }
        catch (error) { fs.closeSync(stdoutDescriptor); throw error; }
      }
      return new Promise<string>((resolve, reject) => {
        const child = spawn(args.program as string, args.arguments as string[], { cwd, env: environment, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
        let stdoutHead = ""; let stdoutTail = ""; let stderrHead = ""; let stderrTail = "";
        let stdoutCharacters = 0; let stderrCharacters = 0; let outputBytes = 0; let truncated = false; let settled = false;
        const outputDecoder = new StringDecoder("utf8"); const errorDecoder = new StringDecoder("utf8");
        let escalation: ReturnType<typeof setTimeout> | undefined;
        const preview = (head: string, tail: string, text: string) => {
          const headRoom = Math.max(0, 1500 - head.length);
          head += text.slice(0, headRoom);
          const remainder = text.slice(headRoom);
          tail = (tail + remainder).slice(-1500);
          return { head, tail };
        };
        const closeLogs = () => {
          if (stdoutDescriptor !== undefined) { fs.closeSync(stdoutDescriptor); stdoutDescriptor = undefined; }
          if (stderrDescriptor !== undefined) { fs.closeSync(stderrDescriptor); stderrDescriptor = undefined; }
        };
        const terminate = () => {
          if (!child.pid) return;
          if (process.platform === "win32") {
            execFile(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }, () => { try { child.kill(); } catch {} });
          } else {
            const kill = (kind: NodeJS.Signals) => { try { process.kill(-child.pid!, kind); } catch { try { child.kill(kind); } catch {} } };
            kill("SIGTERM"); escalation = setTimeout(() => kill("SIGKILL"), 1000); escalation.unref();
          }
        };
        const finish = (error?: string, code?: number | null, exitSignal?: NodeJS.Signals | null) => {
          if (settled) return; settled = true; clearTimeout(deadline); signal.removeEventListener("abort", cancel);
          closeLogs();
          const stdout = stdoutCharacters <= 3000 ? stdoutHead + stdoutTail : `${stdoutHead}\n...[${stdoutCharacters - stdoutHead.length - stdoutTail.length} characters omitted; full output saved locally]...\n${stdoutTail}`;
          const stderr = stderrCharacters <= 3000 ? stderrHead + stderrTail : `${stderrHead}\n...[${stderrCharacters - stderrHead.length - stderrTail.length} characters omitted; full output saved locally]...\n${stderrTail}`;
          if (error) reject(new Error(`${error}${stdoutLog ? ` outputHandle: ${outputHandle}; stdout: ${stdoutLog}; stderr: ${stderrLog}` : ""}`));
          else resolve(JSON.stringify({ exitCode: code, signal: exitSignal, stdout, stderr, truncated, outputBytes, ...(stdoutLog ? { outputHandle, stdoutLog, stderrLog } : {}), platform: process.platform }));
        };
        const cancel = () => { terminate(); finish("Process cancelled; process-tree termination requested."); };
        const deadline = setTimeout(() => { terminate(); finish("Process timed out; process-tree termination requested."); }, seconds * 1000);
        signal.addEventListener("abort", cancel, { once: true });
        const append = (chunk: Buffer, error: boolean) => {
          outputBytes += chunk.length;
          const available = Math.max(0, 64 * 1024 * 1024 - (outputBytes - chunk.length));
          if (available && (error ? stderrDescriptor : stdoutDescriptor) !== undefined) fs.writeSync((error ? stderrDescriptor : stdoutDescriptor)!, chunk.subarray(0, available));
          const text = (error ? errorDecoder : outputDecoder).write(chunk);
          if (error) {
            stderrCharacters += text.length;
            const next = preview(stderrHead, stderrTail, text); stderrHead = next.head; stderrTail = next.tail;
          } else {
            stdoutCharacters += text.length;
            const next = preview(stdoutHead, stdoutTail, text); stdoutHead = next.head; stdoutTail = next.tail;
          }
          if (stdoutCharacters + stderrCharacters > 6000) truncated = true;
          if (outputBytes > 64 * 1024 * 1024) { terminate(); finish("Process output storage limit (64 MiB) reached; process-tree termination requested."); }
        };
        child.stdout?.on("data", chunk => append(chunk, false));
        child.stderr?.on("data", chunk => append(chunk, true));
        child.on("error", () => finish("Cannot launch the program. Check its executable path and permissions."));
        child.on("close", (code, exitSignal) => {
          if (escalation) clearTimeout(escalation);
          const stdoutEnd = outputDecoder.end(); const stderrEnd = errorDecoder.end();
          if (stdoutEnd) { stdoutCharacters += stdoutEnd.length; const next = preview(stdoutHead, stdoutTail, stdoutEnd); stdoutHead = next.head; stdoutTail = next.tail; }
          if (stderrEnd) { stderrCharacters += stderrEnd.length; const next = preview(stderrHead, stderrTail, stderrEnd); stderrHead = next.head; stderrTail = next.tail; }
          finish(undefined, code, exitSignal);
        });
        if (signal.aborted) cancel();
      });
    }),
    definition("process_get", "Read the original durable process status in this Chat. Unknown/stale means execution may have effects; it never authorizes a replacement launch. Chat Stop does not cancel an explicitly approved durable process.", { handle: { type: "string" } }, ["handle"], async (args, signal) => {
      active(signal);
      if (!processEvidenceDirectory) throw new Error("This Chat has no persistent process evidence directory.");
      return JSON.stringify(getChatProcess(processEvidenceDirectory, String(args.handle)));
    }),
    definition("process_output", "Read a bounded stdout/stderr byte range from this Chat's durable process handle or foreground outputHandle, never the entire file automatically. Use end as the next start. Foreground log availability does not certify completion; use its original execution receipt.", {
      handle: { type: "string" }, stream: { type: "string", enum: ["stdout", "stderr"] }, start: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 12000 },
    }, ["handle", "stream", "start", "length"], async (args, signal) => {
      active(signal);
      if (!processEvidenceDirectory) throw new Error("This Chat has no persistent process evidence directory.");
      return JSON.stringify(readChatProcessOutput(processEvidenceDirectory, String(args.handle), args.stream as "stdout" | "stderr", Number(args.start), Number(args.length)));
    }),
    definition("process_cancel", "Request cancellation of the original durable process in this Chat. Query the same handle until termination is confirmed. Unknown outcomes cannot be cancelled by signalling historical PIDs.", { handle: { type: "string" } }, ["handle"], async (args, signal) => {
      active(signal);
      if (!processEvidenceDirectory) throw new Error("This Chat has no persistent process evidence directory.");
      const record = getChatProcess(processEvidenceDirectory, String(args.handle));
      if (await approve("process_cancel", "Cancel this durable background process?", JSON.stringify(record), "Cancel process", signal) !== "Cancel process") throw new Error("Process cancellation declined by the user.");
      active(signal);
      return JSON.stringify(cancelChatProcess(processEvidenceDirectory, record.handle));
    }),
    definition("read_file", "Read text, up to 200 lines and 12,000 characters. Workspace-relative or absolute paths; outside-workspace access requires permission. Hidden/sensitive paths excluded.", { path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } }, ["path"], async (args, signal) => {
      const document = await documentFor(args, signal, "read_file");
      const start = Number(args.startLine ?? 1); const end = Number(args.endLine ?? start + 199);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= 200) throw new Error("Choose 1-200 lines with valid line numbers.");
      const lines = document.getText().split(/\r?\n/);
      const selected = lines.slice(start - 1, end).join("\n");
      const result = { path: args.path, startLine: start, endLine: Math.min(end, lines.length), content: selected.slice(0, 12_000), truncated: end < lines.length || selected.length > 12_000 };
      while (JSON.stringify(result).length > 16_000) { result.content = result.content.slice(0, Math.floor(result.content.length * 0.8)); result.truncated = true; }
      return JSON.stringify(result);
    }),
    definition("find_files", "List up to 200 workspace-relative file names matching a glob.", { glob: { type: "string" } }, [], async (args, signal) => {
      const { root, uris } = await files(args, signal);
      const names = uris.map(uri => path.relative(root.fsPath, uri.fsPath).replace(/\\/g, "/")).filter(name => { try { relativeToolPath(name); return true; } catch { return false; } });
      const chosen: string[] = [];
      for (const name of names.slice(0, 100)) { if (JSON.stringify([...chosen, name]).length > 12_000) break; chosen.push(name); }
      return JSON.stringify({ files: chosen, truncated: uris.length >= 200 || names.length > chosen.length });
    }),
    definition("list_directory", "List up to 200 entries in one directory without reading files or following symlinks. Accepts workspace-relative or absolute paths. Hidden dot-directories (including .vscode-server and .copilot), node_modules and sensitive paths are excluded even in Allow All; do not retry through another file/process tool to bypass that boundary. Outside-workspace access uses this Chat's permissions.", { path: { type: "string" } }, [], async (args, signal) => {
      const location = await physicalPath(args, args.path ?? ".", signal);
      if (location.outside && await approve("list_directory", `Read directory ${location.target}?`,
        `Directory: ${location.target}\nOnly entry names and types are sent to the model; files are not read.`, "Allow access", signal, "outside-workspace", location.target) !== "Allow access") throw new Error("Directory access declined by the user.");
      active(signal);
      if (await fs.promises.realpath(location.uri.fsPath) !== location.target) throw new Error("Directory path changed after approval.");
      const directory = await fs.promises.opendir(location.target);
      const entries: { name: string; type: string }[] = [];
      let truncated = true;
      try {
        for (let examined = 0; examined < 1000; examined++) {
          active(signal);
          const entry = await directory.read();
          if (!entry) { truncated = false; break; }
          try { relativeToolPath(entry.name); } catch { continue; }
          const item = { name: entry.name, type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" };
          if (entries.length >= 200 || JSON.stringify([...entries, item]).length > 12_000) break;
          entries.push(item);
        }
        active(signal);
        return JSON.stringify({ path: location.target, entries, truncated });
      } finally { await directory.close(); }
    }),
    definition("search_text", "Literal text search in up to 40 workspace files, returning at most 50 matches; no regex or shell.", { query: { type: "string" }, glob: { type: "string" } }, ["query"], async (args, signal) => {
      if (typeof args.query !== "string" || !args.query || args.query.length > 256) throw new Error("Enter a literal query up to 256 characters.");
      const { root, uris } = await files(args, signal);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      let skipped = 0;
      let budgetReached = false;
      for (const uri of uris.slice(0, 40)) {
        active(signal);
        const relative = path.relative(root.fsPath, uri.fsPath).replace(/\\/g, "/");
        let document: vscode.TextDocument;
        try { document = await documentFor({ ...args, path: relative }, signal, "search_text"); } catch (error) { active(signal); skipped++; continue; }
        const lines = document.getText().split(/\r?\n/);
        for (let index = 0; index < lines.length && matches.length < 50; index++) if (lines[index].includes(args.query)) {
          const match = { path: relative, line: index + 1, text: lines[index].slice(0, 160) };
          if (JSON.stringify([...matches, match]).length > 12_000) { budgetReached = true; break; }
          matches.push(match);
        }
        if (matches.length === 50 || budgetReached) break;
      }
      return JSON.stringify({ matches, skipped, truncated: budgetReached || uris.length > 40 || matches.length === 50 });
    }),
    definition("replace_text", "Replace a unique exact text match in an existing workspace file. Each edit requires user approval; leaves an unsaved editor change.", { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, ["path", "oldText", "newText"], async (args, signal) => {
      if (typeof args.oldText !== "string" || !args.oldText || typeof args.newText !== "string" || args.oldText.length + args.newText.length > 16_000) throw new Error("Provide a non-empty unique match and a bounded replacement.");
      const document = await documentFor(args, signal, "replace_text"); const text = document.getText(); const version = document.version;
      const offset = text.indexOf(args.oldText);
      if (offset < 0 || text.indexOf(args.oldText, offset + 1) >= 0) throw new Error("The old text must match exactly once.");
      const expected = text.slice(0, offset) + args.newText + text.slice(offset + args.oldText.length);
      if (Buffer.byteLength(expected, "utf8") > 160_000) throw new Error("Edited file would exceed 160 KB.");
      const location = await physicalPath(args, args.path, signal);
      const approval = await approve("replace_text", `Apply Agent edit to ${String(args.path)}?`, `Replace:\n${args.oldText.slice(0, 2000)}\n\nWith:\n${args.newText.slice(0, 2000)}`, "Apply edit", signal, location.outside ? "outside-workspace" : "workspace", location.target);
      active(signal);
      if (approval !== "Apply edit") throw new Error("Edit declined by the user.");
      if ((await resolve(args, signal, "replace_text")).fsPath !== document.uri.fsPath) throw new Error("File path changed after approval.");
      if (document.version !== version || document.getText() !== text) throw new Error("File changed after the edit was proposed. Request a new edit.");
      active(signal);
      const edit = new host.WorkspaceEdit(); edit.replace(document.uri, new host.Range(document.positionAt(offset), document.positionAt(offset + args.oldText.length)), args.newText);
      if (!await host.workspace.applyEdit(edit)) throw new Error("VS Code could not apply the edit.");
      const observed = document.getText();
      const difference = observed === expected ? diffLines(text, observed, { maxEditLength: 2048, timeout: 50 }) : undefined;
      const change: ApiChatEditChange = { path: filesystemToolPath(args.path), workspace: Number(args.workspace ?? 0), appliedAt: new Date().toISOString(),
        beforeHash: createHash("sha256").update(text).digest("hex"), afterHash: createHash("sha256").update(observed).digest("hex"), saved: false,
        attribution: difference ? "exact" : "unknown",
        ...(difference ? { added: difference.reduce((total, part) => total + (part.added ? part.count || 0 : 0), 0), removed: difference.reduce((total, part) => total + (part.removed ? part.count || 0 : 0), 0) } : {}) };
      onEdit?.(change);
      return JSON.stringify({ ...change, applied: true });
    }),
    definition("save_file", "Save one existing workspace text document after separate approval. expectedHash must be the SHA-256 afterHash returned by replace_text. Rejects changed content; saving may run editor save actions.", { path: { type: "string" }, expectedHash: { type: "string", pattern: "^[a-f0-9]{64}$" } }, ["path", "expectedHash"], async (args, signal) => {
      if (typeof args.expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(args.expectedHash)) throw new Error("Provide the exact SHA-256 of the edited document.");
      const document = await documentFor(args, signal, "save_file");
      const text = document.getText(); const version = document.version;
      if (createHash("sha256").update(text).digest("hex") !== args.expectedHash) throw new Error("Document content changed; inspect it before requesting a new save.");
      const location = await physicalPath(args, args.path, signal);
      const approval = await approve("save_file", `Save Agent edit to ${String(args.path)}?`, `Expected SHA-256: ${args.expectedHash}\n\nWrites the current document to disk and may run configured save actions.`, "Save file", signal, location.outside ? "outside-workspace" : "workspace", location.target);
      active(signal);
      if (approval !== "Save file") throw new Error("Save declined by the user.");
      if ((await resolve(args, signal, "save_file")).fsPath !== document.uri.fsPath) throw new Error("File path changed after approval.");
      if (document.version !== version || document.getText() !== text) throw new Error("Document changed after the save was proposed. Request a new save.");
      if (!await document.save()) throw new Error("VS Code could not save the document.");
      active(signal);
      const disk = await abortable(fs.promises.readFile(document.uri.fsPath), signal);
      const hash = createHash("sha256").update(disk).digest("hex");
      if (hash !== createHash("sha256").update(document.getText()).digest("hex")) throw new Error("Disk content differs from the document after saving. Inspect before continuing.");
      return JSON.stringify({ path: filesystemToolPath(args.path), saved: true, afterHash: hash, saveActionsChangedContent: hash !== args.expectedHash });
    }),
  ];
  return tools.filter(tool => enabled.includes(tool.name) || tool.name === "portal" && enabled.includes("cross_machine_collaboration"));
}