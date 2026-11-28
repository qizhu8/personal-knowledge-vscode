import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import type { registerApiChatShell } from "../chat/api-chat-shell";
import type { BrowserChatGrant } from "../chat/browser-chat-transcript";
import { ApiChatStore } from "../chat/api-chat-store";
import { chatPkmUrl } from "../knowledge/knowledge-locator";
import { pkmServiceIdentity, type PkmServiceBootOptions } from "./pkm-service";
import { PKM_SERVICE_TRANSCRIPT_PROVISION, type PkmServiceTranscriptProvision } from "./pkm-service-browser-transcript";
import { provisionBrowserHttps, revokeBrowserHttps } from "./pkm-browser-https-provision";
import { browserSshTunnelCommand, type BrowserSshTunnel } from "./pkm-browser-ssh-tunnel";

type BoundReader = { read(input: { operation: string; version: number; arguments: Record<string, unknown> }): Promise<unknown>;
  assertCurrent(): void; close(): Promise<void> };

export function registerBrowserHttpsActivation(context: vscode.ExtensionContext, options: {
  root(): string; chat: ReturnType<typeof registerApiChatShell>; bindBrowserReads(): Promise<BoundReader | undefined>;
}) {
  let busy = false;
  const boot = (): PkmServiceBootOptions => ({
    knowledgeRoot: options.root(), globalStoragePath: context.globalStorageUri.fsPath,
    extensionVersion: String(context.extension.packageJSON.version),
    serviceEntryPath: path.join(context.extensionPath, "dist/runtime/pkm-service-entry.js"),
  });
  const readExisting = () => {
    const identity = pkmServiceIdentity(boot());
    const file = path.join(identity.serviceDirectory, PKM_SERVICE_TRANSCRIPT_PROVISION);
    if (!fs.existsSync(file)) return undefined;
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024 || stat.uid !== process.getuid?.() ||
          (stat.mode & 0o077) !== 0) throw new Error("The PKM HTTPS provision is not a private regular file.");
      const value = JSON.parse(fs.readFileSync(descriptor, "utf8")) as PkmServiceTranscriptProvision;
      if (value.serviceIdentity !== identity.identity || value.root !== identity.knowledgeRoot)
        throw new Error("The stored PKM HTTPS binding does not match this account and root.");
      return value;
    } finally { fs.closeSync(descriptor); }
  };
  const readPem = async (label: string, privateKey: boolean) => {
    const file = await vscode.window.showInputBox({ title: label, ignoreFocusOut: true,
      prompt: "Absolute PEM file path on the Linux PKM server. Only this explicitly selected file will be read.",
      validateInput: value => path.isAbsolute(value) ? undefined : "Enter an absolute server-side file path." });
    if (!file) return undefined;
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024 ||
          privateKey && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
        throw new Error("TLS files must be bounded regular files; the private key must be owner-only.");
      return fs.readFileSync(descriptor, "utf8");
    } finally { fs.closeSync(descriptor); }
  };
  const badge = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -51);
  badge.text = "$(lock) PKM HTTPS";
  badge.tooltip = "Configure or revoke independent HTTPS access to PKM Chat";
  badge.command = "personalKnowledge.configureBrowserHttps";
  badge.show();
  context.subscriptions.push(badge, vscode.commands.registerCommand("personalKnowledge.configureBrowserHttps", async () => {
    if (busy) throw new Error("PKM HTTPS setup is already in progress.");
    busy = true;
    let bound: BoundReader | undefined;
    try {
      if (!vscode.workspace.isTrusted || !options.root()) throw new Error("A trusted PKM workspace is required.");
      const current = readExisting();
      const action = await vscode.window.showQuickPick(current
        ? ["Copy HTTPS sign-in token and open", ...(current.sshTunnel ? ["Copy SSH tunnel command"] : []), "Revoke HTTPS access"]
        : ["Configure independent HTTPS Chat", "Configure SSH-key tunnel access"], { title: "PKM HTTPS" });
      if (!action) return;
      if (action === "Revoke HTTPS access") {
        await revokeBrowserHttps(boot());
        badge.text = "$(lock) PKM HTTPS: off";
        void vscode.window.showInformationMessage("PKM HTTPS access revoked. Existing browser sessions can no longer read or send.");
        return;
      }
      if (current) {
        if (action === "Copy SSH tunnel command") {
          await vscode.env.clipboard.writeText(browserSshTunnelCommand(current.sshTunnel!, current.address, current.httpsOrigin));
          void vscode.window.showInformationMessage("SSH command copied. Run it on the browser's machine, then copy the HTTPS sign-in token separately. SSH keys and trusted host keys must already be configured.");
          return;
        }
        await vscode.env.clipboard.writeText(current.token);
        await vscode.env.openExternal(vscode.Uri.parse(`${current.httpsOrigin}/webview/chat`));
        return current.httpsOrigin;
      }
      const tunneled = action === "Configure SSH-key tunnel access";
      const httpsOrigin = await vscode.window.showInputBox({ title: "PKM HTTPS address",
        prompt: tunneled
          ? "Browser-side HTTPS origin, for example https://127.0.0.1:8443. The server certificate must identify this loopback hostname."
          : "Exact HTTPS origin reachable from your other devices, for example https://pkm.example.com:8443",
        ignoreFocusOut: true, validateInput(value) {
          try {
            const uri = new URL(value);
            if (uri.protocol === "https:" && uri.origin === value
              && (!tunneled || ["localhost", "127.0.0.1"].includes(uri.hostname))) return undefined;
          } catch {}
          return tunneled ? "Enter an exact HTTPS localhost or 127.0.0.1 origin."
            : "Enter an exact HTTPS origin without a path, credentials or trailing slash.";
        } });
      if (!httpsOrigin) return;
      const address = tunneled ? "127.0.0.1" : await vscode.window.showInputBox({ title: "PKM HTTPS server interface",
        prompt: "IP address on this Linux server to bind. No firewall or DNS changes will be made.",
        ignoreFocusOut: true, validateInput: value => isIP(value) && !["0.0.0.0", "::"].includes(value)
          ? undefined : "Enter a specific local interface IP address, not a wildcard." });
      if (!address) return;
      let sshTunnel: BrowserSshTunnel | undefined;
      if (tunneled) {
        const host = await vscode.window.showInputBox({ title: "PKM SSH server",
          prompt: "Deployment server SSH hostname/alias, optionally user@host, as configured on the browser machine. No SSH key will be read.",
          ignoreFocusOut: true, validateInput(value) {
            try { browserSshTunnelCommand({ host: value }, address, httpsOrigin); return undefined; }
            catch (error) { return error instanceof Error ? error.message : "Invalid SSH server."; }
          } });
        if (!host) return;
        sshTunnel = { host };
        const command = browserSshTunnelCommand(sshTunnel, address, httpsOrigin);
        const choice = await vscode.window.showInformationMessage("Configure loopback-only PKM access through your own SSH tunnel?", {
          modal: true, detail: `${command}\n\nRun this on the browser machine. OpenSSH enforces public-key authentication and strict host-key checking; prepare trusted host keys and SSH keys yourself. PKM does not read SSH keys, start ssh/sshd, open firewall ports or weaken TLS verification. HTTPS and the browser sign-in token are still required.`,
        }, "Continue with SSH tunnel");
        if (choice !== "Continue with SSH tunnel") return;
      }
      const cert = await readPem("Select the HTTPS certificate on the PKM server", false);
      if (!cert) return;
      const key = await readPem("Select the owner-only HTTPS private key on the PKM server", true);
      if (!key) return;
      await vscode.commands.executeCommand("personalKnowledge.openApiChat");
      bound = await options.bindBrowserReads();
      if (!bound) throw new Error("Start the existing native PKM connection before configuring HTTPS.");
      const root = fs.realpathSync(options.root()), rootStat = fs.lstatSync(root);
      const folders = () => vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()).join("|") ?? "";
      const captured = folders();
      if (!captured) throw new Error("The original Chat workspace is unavailable.");
      const assertCurrent = () => {
        const stat = fs.lstatSync(root);
        if (!vscode.workspace.isTrusted || folders() !== captured || options.root() !== root ||
            stat.dev !== rootStat.dev || stat.ino !== rootStat.ino) throw new Error("The PKM workspace changed during HTTPS setup.");
        bound!.assertCurrent();
      };
      assertCurrent();
      const info = z.object({ ok: z.literal(true), truncated: z.literal(false), hosts: z.array(z.object({
        host_id: z.string().uuid(), workspace_paths: z.array(z.string()), operations: z.array(z.string()),
      })).max(100) }).parse(await bound.read({ operation: "mcp.tool.api_chat_capabilities", version: 1, arguments: {} }));
      const hosts = info.hosts.filter(host => host.workspace_paths.includes(root) && host.operations.includes("get"));
      if (hosts.length !== 1) throw new Error("One unambiguous Original Chat host is required.");
      const namespace = createHash("sha256").update(captured).digest("hex").slice(0, 16);
      const store = new ApiChatStore(path.join(root, ".pkm", "state"), namespace);
      const selected = await vscode.window.showQuickPick(store.list().map(chat => ({
        label: chat.title, description: chat.id, chatId: chat.id,
      })), { title: "Choose an existing Chat for independent HTTPS access" });
      if (!selected) return;
      await vscode.commands.executeCommand("personalKnowledge.openApiChat", chatPkmUrl(namespace, selected.chatId));
      const grant: BrowserChatGrant = Object.freeze({ actorId: `https-browser:${randomUUID()}`, workspaceRoot: root,
        generation: randomUUID(), chatHostId: hosts[0].host_id });
      const turn = await options.chat.approveDetachedConversation(grant, selected.chatId, assertCurrent);
      if (!turn) return;
      assertCurrent();
      const consent = options.chat.bindDetachedTranscriptConsent(grant, assertCurrent);
      if (!await consent.allow(selected.chatId)) return;
      const notesChoice = await vscode.window.showWarningMessage("Share ordinary Notes with this HTTPS browser sign-in?", {
        modal: true, detail: "This grants access to ordinary Notes across this Knowledge Root for up to 24 hours. " +
          "Read and edit also permits creating Notes and editing existing bodies with stale-draft protection. " +
          "System Notes and Work Items cannot be edited; metadata changes are not allowed. Revoke access with PKM HTTPS.",
      }, "Read and edit Notes", "Read Notes only", "Chat only");
      if (!notesChoice) return;
      const service = boot(), identity = pkmServiceIdentity(service);
      const provision: PkmServiceTranscriptProvision = {
        schema: "pkm.service-browser-transcript/v1", serviceIdentity: identity.identity,
        root, rootDevice: rootStat.dev, rootInode: rootStat.ino, actorId: grant.actorId, generation: grant.generation,
        chatHostId: grant.chatHostId!, namespace, chatId: selected.chatId,
        address, port: Number(new URL(httpsOrigin).port || 443), httpsOrigin, cert, key,
        ...(sshTunnel ? { sshTunnel } : {}),
        token: randomBytes(32).toString("base64url"), turn,
        ...(process.env.PKM_MANAGED_WRITER_SESSION ? { managedWriterSession: process.env.PKM_MANAGED_WRITER_SESSION } : {}),
        ...(notesChoice === "Chat only" ? {} : {
          notes: { expiresAt: Math.min(turn.approval.expiresAt, Date.now() + 24 * 60 * 60_000),
            allowWrite: notesChoice === "Read and edit Notes" },
        }),
      };
      await provisionBrowserHttps(service, provision, assertCurrent);
      badge.text = "$(lock) PKM HTTPS: configured";
      await vscode.env.clipboard.writeText(provision.token);
      if (sshTunnel) void vscode.window.showInformationMessage("SSH tunnel access configured on server loopback only. Use PKM HTTPS → Copy SSH tunnel command on the browser machine; this clipboard currently contains the separate browser sign-in token.");
      if (!sshTunnel) await vscode.env.openExternal(vscode.Uri.parse(`${httpsOrigin}/webview/chat`));
      return httpsOrigin;
    } catch (error) {
      void vscode.window.showErrorMessage(`PKM HTTPS setup failed: ${error instanceof Error ? error.message : "Unknown failure."}`);
      throw error;
    } finally { try { await bound?.close(); } finally { busy = false; } }
  }));
}
