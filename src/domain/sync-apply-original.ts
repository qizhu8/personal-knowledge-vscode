type GitHubSyncContentType = string;

export function githubSyncManagedContent(type: GitHubSyncContentType, content: Buffer): Buffer {
  if (type !== "recipes") return content;
  if (content.includes(0) || !Buffer.from(content.toString("utf8"), "utf8").equals(content)) {
    throw new Error("Recipe content is not valid UTF-8 text.");
  }

  const recipe = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
  delete recipe.editorLayout;
  return Buffer.from(`${JSON.stringify(recipe, null, 2)}\n`, "utf8");
}

export function githubSyncLocalSnapshotMatches(
  original: Buffer | undefined, planned: Buffer | undefined, current: Buffer | undefined,
): boolean {
  return current === undefined ? original === undefined || planned === undefined
    : !!(planned?.equals(current) || original?.equals(current));
}
