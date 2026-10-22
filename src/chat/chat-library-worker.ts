import { Worker, isMainThread, parentPort, workerData } from "worker_threads";

export type ChatLibraryWork = "trash" | "restore" | "delete" | "namespace" | "trash-list";
interface WorkRequest { kind: "pkm-chat-library"; directory: string; namespace: string; operation: ChatLibraryWork; id: string }
interface WorkResult { namespace?: string; chats?: Array<{ id: string; title: string }> }
type WorkReply = { ok: true; result: WorkResult } | { ok: false; error: string };

export function runChatLibraryWork(directory: string, namespace: string, operation: ChatLibraryWork, id: string): Promise<WorkResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { kind: "pkm-chat-library", directory, namespace, operation, id } satisfies WorkRequest });
    let replied = false;
    worker.once("message", (reply: WorkReply) => {
      replied = true;
      if (reply.ok) resolve(reply.result);
      else reject(new Error(reply.error));
    });
    worker.once("error", reject);
    worker.once("exit", code => {
      if (!replied) reject(new Error(`Chat library worker exited (${code}) without a result; inspect the Chat before retrying.`));
    });
  });
}

if (!isMainThread && workerData?.kind === "pkm-chat-library") {
  const request = workerData as WorkRequest;
  void (async () => {
    const { ApiChatStore } = await import("./api-chat-store");
    const store = new ApiChatStore(request.directory, request.namespace);
    let result: WorkResult = {};
    switch (request.operation) {
      case "trash": store.trashChat(request.id); break;
      case "restore": store.restoreChat(request.id); break;
      case "delete": store.deleteChat(request.id); break;
      case "namespace": result = { namespace: store.load(request.id, false).workspaceNamespace || store.namespace }; break;
      case "trash-list": result = { chats: store.list(true).filter(chat => chat.trashedAt).map(({ id, title }) => ({ id, title })) }; break;
      default: throw new Error("Unknown Chat library worker operation.");
    }
    parentPort!.postMessage({ ok: true, result } satisfies WorkReply);
  })().catch(error => parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies WorkReply));
}
