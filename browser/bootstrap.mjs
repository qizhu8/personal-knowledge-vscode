// @ts-check
import { mount } from "./workspace.mjs";
import { hostConfig } from "./host-config.mjs";
import { mountSharedManagement } from "./shared-management.mjs";

export function init(root = document.getElementById("workspace")) {
  if (!root) throw new Error("Workspace mount root is required.");
  const workspace = mount(root, hostConfig);
  const managementRoot = document.createElement("section");
  root.append(managementRoot);
  const management = mountSharedManagement(managementRoot);
  const dispose = () => {
    management.dispose();
    workspace.dispose();
    window.removeEventListener("pagehide", dispose);
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return { ...workspace, dispose };
}
if (typeof document !== "undefined") init();
