import * as fs from "node:fs";
import * as path from "node:path";
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BrowserChatGrant } from "../chat/browser-chat-transcript";
import type { DetachedOriginalTextApproval } from "../chat/detached-original-text-turn";
import { verifyNextPayload } from "./next-payload-verifier";

/** Provisioned outside the service by its trusted owner; never created by HTTP, IPC or boot arguments. */
export const PKM_SERVICE_TRANSCRIPT_PROVISION = "browser-transcript-v1.json";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** A private provision is immutable for one service lifetime. Remove it to revoke; restart to replace it. */
export interface PkmServiceTranscriptProvision {
  schema: "pkm.service-browser-transcript/v1";
  serviceIdentity: string;
  root: string;
  rootDevice: number;
  rootInode: number;
  managedWriterSession?: string;
  actorId: string;
  generation: string;
  chatHostId: string;
  namespace: string;
  chatId: string;
  address: string;
  port: number;
  httpsOrigin: string;
  cert: string;
  key: string;
  token: string;
  turn?: { approval: DetachedOriginalTextApproval; providerKey: string };
}

export async function startServiceBrowserTranscript(options: {
  knowledgeRoot: string;
  serviceDirectory: string;
  extensionPath: string;
  managedWriterSession?: string;
  assertServiceCurrent(): void;
  withWriter<T>(work: () => Promise<T>): Promise<T>;
}): Promise<{ close(): Promise<void>; assertProvisionCurrent(): void } | undefined> {
  const file = path.join(options.serviceDirectory, PKM_SERVICE_TRANSCRIPT_PROVISION);
  const checkFile = (stat: fs.Stats) => {
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024 || fs.realpathSync(file) !== file ||
        (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())))
      throw new Error("Invalid private PKM transcript provision.");
  };
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let pinned: fs.Stats, provision: PkmServiceTranscriptProvision;
  try {
    pinned = fs.fstatSync(fd);
    checkFile(pinned);
    provision = JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
  const { schema, serviceIdentity, root, rootDevice, rootInode, actorId, generation, chatHostId,
    namespace, chatId, token, address, port, httpsOrigin, cert, key, managedWriterSession, turn } = provision;
  const uri = typeof httpsOrigin === "string" ? URL.parse(httpsOrigin) : null;
  if (schema !== "pkm.service-browser-transcript/v1" || serviceIdentity !== path.basename(options.serviceDirectory) ||
      root !== options.knowledgeRoot || managedWriterSession !== options.managedWriterSession ||
      typeof actorId !== "string" || !actorId.trim() || actorId.length > 256 ||
      typeof generation !== "string" || !generation.trim() || generation.length > 256 ||
      typeof chatHostId !== "string" || !uuid.test(chatHostId) || typeof chatId !== "string" || !uuid.test(chatId) ||
      typeof namespace !== "string" || !/^[a-f0-9]{16}$/.test(namespace) ||
      typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      typeof address !== "string" || !isIP(address) || address === "0.0.0.0" || address === "::" ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      !uri || uri.protocol !== "https:" || uri.origin !== httpsOrigin || Number(uri.port || 443) !== port ||
      typeof cert !== "string" || typeof key !== "string")
    throw new Error("Invalid PKM transcript provision.");
  let revoked = false;
  const assertProvisionCurrent = () => {
    try {
      if (revoked) throw Error();
      const current = fs.lstatSync(file);
      checkFile(current);
      const stat = fs.lstatSync(root);
      if (current.dev !== pinned.dev || current.ino !== pinned.ino || current.ctimeMs !== pinned.ctimeMs ||
          !stat.isDirectory() || stat.dev !== rootDevice || stat.ino !== rootInode || fs.realpathSync(root) !== root)
        throw Error();
    } catch { revoked = true; throw new Error("PKM transcript provision revoked."); }
  };
  const grant: BrowserChatGrant = Object.freeze({ actorId, generation, chatHostId, workspaceRoot: root });
  const assertCurrent = (supplied: BrowserChatGrant) => {
    options.assertServiceCurrent();
    assertProvisionCurrent();
    if (supplied.actorId !== grant.actorId || supplied.generation !== grant.generation ||
        supplied.chatHostId !== grant.chatHostId || supplied.workspaceRoot !== grant.workspaceRoot)
      throw new Error("PKM transcript grant mismatch.");
  };
  assertProvisionCurrent();
  const payload = verifyNextPayload(options.extensionPath);
  type Route = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  const { createOriginalBrowserRoute } = require(path.join(payload.root, "server/dist/browser-original-owner.js")) as {
    createOriginalBrowserRoute(input: object, policy: { httpsOrigin: string }): Promise<Route>;
  };
  const { startBrowserHttpsListener } = require(path.join(payload.root, "server/dist/browser-https-listener.js")) as {
    startBrowserHttpsListener(input: { route: Route; address: string; port: number; tls: { cert: string; key: string } }):
      Promise<{ close(): Promise<void> }>;
  };
  const { bindDetachedBrowserChatTranscript } = require("../chat/detached-browser-chat-transcript") as
    typeof import("../chat/detached-browser-chat-transcript");
  let turns: ReturnType<typeof import("../chat/detached-original-text-turn").bindDetachedOriginalTextTurn> | undefined;
  if (turn !== undefined) {
    const approval = turn?.approval;
    if (!approval || approval.chatId !== chatId || approval.namespace !== namespace || approval.rootDevice !== rootDevice ||
        approval.rootInode !== rootInode || approval.grant?.workspaceRoot !== root || approval.grant.actorId !== actorId ||
        approval.grant.generation !== generation || approval.grant.chatHostId !== chatHostId ||
        typeof turn.providerKey !== "string" || !turn.providerKey.trim() || turn.providerKey.length > 8192 ||
        /[\x00-\x20\x7f]/.test(turn.providerKey)) throw new Error("Invalid private PKM turn provision.");
    const { bindDetachedOriginalTextTurn } = require("../chat/detached-original-text-turn") as
      typeof import("../chat/detached-original-text-turn");
    const providerKey = turn.providerKey;
    const pinnedModel = JSON.stringify(approval.model);
    turns = bindDetachedOriginalTextTurn(approval, {
      assertCurrent, withWriter: options.withWriter,
      async readProviderKey(model, signal) {
        assertCurrent(grant);
        signal.throwIfAborted();
        if (JSON.stringify(model) !== pinnedModel) throw new Error("PKM provider binding changed.");
        return providerKey;
      },
    });
  }
  const transcript = bindDetachedBrowserChatTranscript({ grant, namespace, assertCurrent });
  const route = await createOriginalBrowserRoute({ token, grant, assertCurrent, transcriptOnly: true, detachedChatId: chatId,
    ...(turns ? { chatTurns: turns } : {}),
    async readChatTranscript(supplied: BrowserChatGrant, input: { chatId: string; cursor?: string; limit?: number }) {
      try { return await transcript(supplied, input); }
      catch (error) {
        assertCurrent(supplied);
        if (!turns || input.cursor !== undefined) throw error;
        return turns.readSettledReply(input.chatId);
      }
    },
  }, { httpsOrigin });
  assertProvisionCurrent();
  const listener = await startBrowserHttpsListener({ route, address, port, tls: { cert, key } });
  return { close: listener.close, assertProvisionCurrent };
}
