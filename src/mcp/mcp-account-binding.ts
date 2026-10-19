import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import { withCrossProcessLock } from "../runtime/cross-process-lock";

export interface AccountMcpBinding {
  schema: "pkm.account-mcp/v1";
  serverId: "pkm";
  targetId: string;
  accountId: string;
  knowledgeRoot: string;
  registrationOwner: "native-provider" | "manual-user";
}

export function accountMcpDirectory(): string { return path.join(os.homedir(), ".pkm"); }

export function accountMcpIdentity(): Pick<AccountMcpBinding, "targetId" | "accountId"> {
  const user = os.userInfo();
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const targetId = digest(`${process.platform}\0${os.hostname()}`);
  return { targetId, accountId: digest(`${targetId}\0${user.uid}\0${user.username}\0${path.resolve(user.homedir)}`) };
}

function assertPrivateEntry(filename: string, directory: boolean): void {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`PKM account binding has an unsafe path: ${filename}`);
  if (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) {
    throw new Error(`PKM account binding requires owner-only permissions: ${filename}. Review its ownership and permissions; no permissions were changed.`);
  }
}

export function readAccountMcpBinding(directory = accountMcpDirectory()): AccountMcpBinding | undefined {
  const filename = path.join(directory, "mcp-binding.json");
  if (!fs.existsSync(filename)) return undefined;
  assertPrivateEntry(directory, true);
  assertPrivateEntry(filename, false);
  if (fs.statSync(filename).size > 16_384) throw new Error("PKM account binding is too large.");
  const value = JSON.parse(fs.readFileSync(filename, "utf8"));
  const identity = accountMcpIdentity();
  if (value?.schema !== "pkm.account-mcp/v1" || value.serverId !== "pkm"
    || value.targetId !== identity.targetId || value.accountId !== identity.accountId
    || typeof value.knowledgeRoot !== "string" || !path.isAbsolute(value.knowledgeRoot)
    || !["native-provider", "manual-user"].includes(value.registrationOwner)) {
    throw new Error("PKM account binding does not match this target/account or has an unsupported schema. Use explicit PKM setup; do not adopt another account's binding.");
  }
  return value;
}

export async function writeAccountMcpBinding(
  knowledgeRoot: string,
  registrationOwner: AccountMcpBinding["registrationOwner"],
  allowReconfigure = false,
  directory = accountMcpDirectory(),
): Promise<AccountMcpBinding> {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateEntry(directory, true);
  const binding: AccountMcpBinding = {
    schema: "pkm.account-mcp/v1", serverId: "pkm", ...accountMcpIdentity(),
    knowledgeRoot: fs.realpathSync(knowledgeRoot), registrationOwner,
  };
  return withCrossProcessLock(path.join(directory, "mcp-binding.lock"), "PKM account setup", 5_000, async () => {
    const current = readAccountMcpBinding(directory);
    if (current && (current.knowledgeRoot !== binding.knowledgeRoot || current.registrationOwner !== registrationOwner) && !allowReconfigure) {
      throw new Error("PKM is already bound to another root or registration owner on this account. Use explicit PKM reconfiguration; a workspace cannot redirect it.");
    }
    if (current && JSON.stringify(current) === JSON.stringify(binding)) return current;
    const temporary = path.join(directory, `mcp-binding.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(binding, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      if (current && allowReconfigure) {
        fs.writeFileSync(path.join(directory, `mcp-binding.json.pkm-backup-${randomUUID()}`),
          fs.readFileSync(path.join(directory, "mcp-binding.json")), { mode: 0o600, flag: "wx" });
      }
      fs.renameSync(temporary, path.join(directory, "mcp-binding.json"));
    } finally { fs.rmSync(temporary, { force: true }); }
    return binding;
  });
}

export function accountKnowledgeSecurity(knowledgeRoot: string): { private: boolean; detail: string } {
  if (process.platform === "win32") return { private: false, detail: "Windows account isolation requires a DACL audit; POSIX mode bits are not proof of isolation." };
  try {
    let directory = fs.realpathSync(knowledgeRoot);
    if (fs.statSync(directory).uid !== process.getuid?.()) return { private: false, detail: "Knowledge Root is not owned by this OS account." };
    while (true) {
      const stat = fs.statSync(directory);
      if (stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0) return { private: true, detail: "Knowledge Root has an owner-only directory boundary." };
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return { private: false, detail: "Knowledge Root is accessible through group/other directory permissions. Review access before claiming account isolation; no permissions were changed." };
  } catch (error) { return { private: false, detail: error instanceof Error ? error.message : String(error) }; }
}