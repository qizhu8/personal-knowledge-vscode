import { inspectCompatibilityGatewayRecovery, recoverCompatibilityGateway } from "./compatibility-gateway-recovery.js";

const [action, root, confirmation, digest] = process.argv.slice(2);
try {
  if (!root || action !== "inspect" && action !== "recover"
    || action === "inspect" && process.argv.length !== 4
    || action === "recover" && (process.argv.length !== 6 || confirmation !== "--confirm" || !digest))
    throw new Error("Usage: compatibility-gateway-recovery-cli.js inspect ROOT | recover ROOT --confirm REVIEW_SHA256");
  const result = action === "inspect" ? await inspectCompatibilityGatewayRecovery(root)
    : await recoverCompatibilityGateway(root, digest!);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
