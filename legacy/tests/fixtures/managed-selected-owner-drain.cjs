"use strict";
const { registerHooks } = require("node:module");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "./managed-selected-owner-ipc.js" || !context.parentURL?.endsWith("/managed-client-child.js"))
      return nextResolve(specifier, context);
    const original = nextResolve(specifier, context).url;
    const source = `
      import { managedSelectedOwnerIpc as create } from ${JSON.stringify(original)};
      export function managedSelectedOwnerIpc(options) {
        const ipc = create(options);
        let attempts = 0;
        return { ...ipc, handle(message) {
          const handled = ipc.handle(message);
          if (message.type === "selected-owner-open" && message.workspaceId === options.host()?.workspaceId) {
            try {
              ipc.capability(message.session).registerChildClose(async () => {
                if (++attempts === 1) throw new Error("Injected drain failure");
              });
            } catch {}
          }
          return handled;
        } };
      }
    `;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});
