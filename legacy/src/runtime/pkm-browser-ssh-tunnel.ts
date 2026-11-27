export interface BrowserSshTunnel {
  host: string;
}

export function browserSshTunnelCommand(tunnel: BrowserSshTunnel, address: string, origin: string): string {
  if (!tunnel || typeof tunnel.host !== "string"
    || !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(tunnel.host)
    || tunnel.host.length > 255) {
    throw new Error("Enter a server SSH hostname or configured alias, optionally user@host; SSH options and shell syntax are not allowed.");
  }
  const uri = new URL(origin);
  if (address !== "127.0.0.1" || uri.protocol !== "https:" || uri.origin !== origin
    || !["localhost", "127.0.0.1"].includes(uri.hostname)) {
    throw new Error("SSH tunnel access requires server interface 127.0.0.1 and an exact HTTPS localhost or 127.0.0.1 origin.");
  }
  const port = Number(uri.port || 443);
  return ["ssh", "-N", "-S", "none", "-o", "ControlMaster=no", "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes",
    "-o", "PreferredAuthentications=publickey", "-o", "PubkeyAuthentication=yes",
    "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
    "-o", "StrictHostKeyChecking=yes", "-L", `127.0.0.1:${port}:127.0.0.1:${port}`, tunnel.host].join(" ");
}
