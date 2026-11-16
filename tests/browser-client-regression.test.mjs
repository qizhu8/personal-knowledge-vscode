// Supplementary unit regressions; visual qualification lives in batch06-browser.test.mjs.
import { registerHooks } from "node:module";

const retainedTests = new URL("../legacy/tests/", import.meta.url).href;
const browserModules = new Map(["protocol.mjs", "workspace.mjs"].map(name => [
  `../next-server/browser/${name}`, new URL(`../browser/${name}`, import.meta.url).href,
]));
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = context.parentURL?.startsWith(retainedTests) && browserModules.get(specifier);
    return nextResolve(target || specifier, context);
  },
});
try {
  await import("../legacy/tests/browser-client-protocol.test.mjs");
  await import("../legacy/tests/browser-client-dom.test.mjs");
} finally {
  hooks.deregister();
}
