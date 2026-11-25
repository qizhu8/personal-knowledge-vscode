import * as vscode from "vscode";
import { modelApiKeySecretId } from "../../src/model-config.js";
import { originalMcpNativeSigner } from "./original-mcp-native-identity.js";

const slot = (profileSha256: string) => `pkm.originalMcp.modelApiKey.v1.${profileSha256}`;
const valid = (value: string) => value.length > 0 && value.length <= 4096 && !/[\r\n]/.test(value);

export async function originalMcpNativeCredentialAvailable(context: vscode.ExtensionContext,
  binding: { profileSha256: string; secretId: typeof modelApiKeySecretId }): Promise<boolean> {
  if (binding.secretId !== modelApiKeySecretId)
    throw new Error("NATIVE_CREDENTIAL_BINDING_REQUIRED: Arbitrary native secret lookup is forbidden.");
  const signer = await originalMcpNativeSigner(context);
  signer.assertCurrent();
  if (binding.profileSha256 !== signer.identity.profileSha256)
    throw new Error("NATIVE_CREDENTIAL_BINDING_REQUIRED: Only this enrolled native profile's model credential may be inspected.");
  const value = await context.secrets.get(slot(binding.profileSha256));
  signer.assertCurrent();
  if (value !== undefined && !valid(value))
    throw new Error("NATIVE_CREDENTIAL_INVALID: Re-enroll the native model credential; no automatic replacement occurred.");
  return value !== undefined;
}

export function registerOriginalMcpNativeCredentials(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
  return vscode.commands.registerCommand("pkm.nextHost.reenrollModelCredential", async () => {
    try {
      const signer = await originalMcpNativeSigner(context);
      signer.assertCurrent();
      const value = await vscode.window.showInputBox({
        password: true, ignoreFocusOut: true,
        prompt: "Store or replace the model API key for this v5 profile only. Old extension credentials are not read or copied.",
        validateInput: input => valid(input) ? undefined : "Enter a nonempty API key without line breaks (maximum 4096 characters).",
      });
      if (value === undefined) {
        output.appendLine("Native model credential enrollment cancelled; no model credential was changed.");
        return { cancelled: true, stored: false };
      }
      if (!valid(value)) throw new Error("NATIVE_CREDENTIAL_INVALID: The native API-key input is invalid.");
      signer.assertCurrent();
      await context.secrets.store(slot(signer.identity.profileSha256), value);
      signer.assertCurrent();
      if (await context.secrets.get(slot(signer.identity.profileSha256)) !== value)
        throw new Error("NATIVE_CREDENTIAL_UNCONFIRMED: SecretStorage did not confirm the stored model credential.");
      signer.assertCurrent();
      output.appendLine("The separate v5 model credential was confirmed in native SecretStorage. No key bytes were returned or written to profile files.");
      return { stored: true, profileSha256: signer.identity.profileSha256, businessActivation: false };
    } catch (error) {
      output.appendLine("Native model credential enrollment could not be confirmed. Inspect native SecretStorage before retrying; no automatic replay occurred.");
      void vscode.window.showErrorMessage("PKM v5 could not confirm the native model credential. Old extension credentials were not accessed.");
      throw error;
    }
  });
}
