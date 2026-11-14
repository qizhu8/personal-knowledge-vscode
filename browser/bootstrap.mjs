// @ts-check
import { mount } from "./workspace.mjs";
import { hostConfig } from "./host-config.mjs";

export function init(root = document.getElementById("workspace")) {
  if (!root) throw new Error("Workspace mount root is required.");
  const workspace = mount(root, hostConfig);
  const dispose = () => {
    workspace.dispose();
    window.removeEventListener("pagehide", dispose);
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return workspace;
}
if (typeof document !== "undefined") init();
