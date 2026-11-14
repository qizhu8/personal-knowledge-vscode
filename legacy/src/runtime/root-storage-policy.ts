export const DEFAULT_KNOWLEDGE_GITIGNORE_RULES = [
  "knowledge.db",
  "knowledge.db-shm",
  "knowledge.db-wal",
  "mcp-server/",
  "envs/",
  "chatrooms/**/*.db",
  "chatrooms/**/*.journal",
  "chatrooms/**/*.db-shm",
  "chatrooms/**/*.db-wal",
  "scripts/**/.ai-cache/",
  "packages/**/node_modules/",
  "packages/**/dist/",
  "packages/**/artifacts/",
  "packages/**/.vscode-test/",
  "packages/**/__pycache__/",
  "packages/**/.pytest_cache/",
  "servers/**/.venv/",
  "servers/**/venv/",
  "servers/**/__pycache__/",
  "servers/**/.pytest_cache/",
  "servers/**/data/",
  "servers/**/models/",
] as const;

export function defaultKnowledgeGitignore(): string {
  return `${DEFAULT_KNOWLEDGE_GITIGNORE_RULES.join("\n")}\n`;
}