"use strict";

const { registerHooks } = require("node:module");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== "./managed-client-host.js" || !context.parentURL?.endsWith("/managed-client-child.js"))
      return nextResolve(specifier, context);
    const original = nextResolve(specifier, context).url;
    const source = `
      import { bindImportedReadOnlyHost, startManagedClientHost as start } from ${JSON.stringify(original)};
      export { bindImportedReadOnlyHost };
      export async function startManagedClientHost(options) {
        const host = await start(options);
        let attempts = 0;
        const owner = host.selectedOwnerContext({
          workspaceId: host.workspaceId, actorId: "local:owner", assertCurrent() {},
        });
        owner.registerChildClose(async () => {
          if (++attempts === 1 && process.env.PKM_TEST_FAIL_FIRST_HOST_CLOSE)
            throw new Error("Injected child drain failure");
        });
        return host;
      }
    `;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});
