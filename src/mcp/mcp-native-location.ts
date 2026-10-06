export interface McpUriLike<T extends McpUriLike<T>> {
  readonly scheme: string;
  readonly authority: string;
  with(change: { scheme?: string; authority?: string }): T;
}

export function nativeMcpCwdUri<T extends McpUriLike<T>>(
  extensionUri: T,
  cwd: string,
  fileUri: (path: string) => T,
): T {
  const localUri = fileUri(cwd);
  if (extensionUri.scheme === "file") return localUri;
  return localUri.with({
    scheme: extensionUri.scheme,
    authority: extensionUri.authority,
  });
}
