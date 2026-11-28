import { streamApiChat, type ApiChatRequest } from "./api-chat-client";

type ModelRequest = Omit<ApiChatRequest, "provider">;
type TextDelta = (text: string) => void;
export type NativeChatModelDispatch =
  | { provider: ApiChatRequest["provider"] }
  | { provider: "vscode"; stream(request: ModelRequest, onText: TextDelta): Promise<void> };

/**
 * Dispatches an already prepared, authorized native turn. The owner still selects the
 * model, supplies credentials, builds context/tools and owns persistence and Stop.
 * A missing host adapter never falls back to HTTP.
 */
export async function dispatchNativeChatModel(target: NativeChatModelDispatch, request: ModelRequest, onText: TextDelta): Promise<void> {
  const { signal } = request;
  if (signal.aborted) throw new Error("Request cancelled.");
  let cancel!: () => void;
  await new Promise<void>((resolve, reject) => {
    cancel = () => reject(new Error("Request cancelled."));
    signal.addEventListener("abort", cancel, { once: true });
    const activeText: TextDelta = chunk => { if (!signal.aborted) onText(chunk); };
    void Promise.resolve().then(() => {
      if (signal.aborted) throw new Error("Request cancelled.");
      switch (target.provider) {
        case "vscode":
          if (typeof target.stream !== "function") throw new Error("The selected VS Code model requires its owning host.");
          return target.stream(request, activeText);
        case "openai-compatible":
        case "azure-openai":
          return streamApiChat({ ...request, provider: target.provider }, activeText);
        default: throw new Error("Unsupported Native Chat model provider.");
      }
    }).then(resolve, reject);
  }).finally(() => signal.removeEventListener("abort", cancel));
}
