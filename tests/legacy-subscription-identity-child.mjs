import { Storage } from "../dist/storage.js";
import { createNativeRuntime } from "../dist/native-runtime.js";
import { actor, nativePolicy } from "./legacy-subscription-identity-fixture.mjs";

const [root, vault] = process.argv.slice(2);
const storage = await Storage.open(root);
let native;
try {
  native = await createNativeRuntime({ storage, subscriptionIdentity: nativePolicy(vault) });
  const identity = await native.core.dispatch("capability_read",
    { operation: "subscription.identity.get", version: 1, arguments: {} }, actor);
  const list = await native.core.dispatch("capability_read",
    { operation: "subscription.list", version: 1, arguments: {} }, actor);
  process.stdout.write(JSON.stringify({ identity, list }));
} catch (error) {
  process.stdout.write(JSON.stringify({ startupError: /^[A-Z_]+$/.test(error.code) ? error.code : "INTERNAL" }));
} finally { await native?.close(); await storage.close(); }
