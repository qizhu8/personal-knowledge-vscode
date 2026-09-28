import { compareVersionOrder } from "./version-order";

export interface McpComponentVersions {
  unified: string;
  knowledge: string;
  chat: string;
  recipe: string;
  agentSession: string;
}

export function newerMcpRuntimeComponents(
  installed: McpComponentVersions,
  bundled: McpComponentVersions,
): Array<keyof McpComponentVersions> {
  return (Object.keys(bundled) as Array<keyof McpComponentVersions>)
    .filter(component => compareVersionOrder(installed[component], bundled[component]) === 1);
}

export function hasNewerMcpRuntime(installed: McpComponentVersions, bundled: McpComponentVersions): boolean {
  return newerMcpRuntimeComponents(installed, bundled).length > 0;
}
