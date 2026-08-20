# Publishing Guide

The canonical release path is `.github/workflows/publish-marketplace.yml`.

It uses GitHub Actions OIDC, a federated personal Microsoft Entra application, and `vsce --azure-credential`. It does not use a Marketplace PAT, client secret, Azure subscription, local Azure login, or Device Code Flow.

## One-time setup

1. Create a personal Entra app registration/service principal without a client secret.
2. Add this federated credential:

   ```text
   Issuer:   https://token.actions.githubusercontent.com
   Audience: api://AzureADTokenExchange
   Subject:  repo:qizhu8/personal-knowledge-vscode:environment:marketplace
   ```

3. Create GitHub environment `marketplace` with variables:

   ```text
   AZURE_CLIENT_ID=<application client ID>
   AZURE_TENANT_ID=<personal tenant ID>
   ```

4. Run the workflow in `identity` mode.
5. Add the returned Marketplace profile ID to publisher `Uone` as Contributor/Owner with access to `personal-knowledge`.
6. Run `identity` mode again. It must pass both **Show Marketplace publishing identity** and **Verify Uone publisher permissions**.

The workflow has no push, tag, release, or scheduled trigger. Publishing occurs only when a repository administrator manually runs the workflow, selects `publish`, and enters the exact version.

## Publish

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` to the same version.
2. Regenerate privacy-safe release media with `npm run screenshots:gif`; inspect PNG/GIF output and confirm it contains synthetic fixtures only. See `SCREENSHOTS.md`.
3. Run `npm run test:release`, `git diff --check`, and package the exact target version locally.
4. Commit and push the exact release source.
5. Run **Actions -> Publish VS Code Marketplace -> Run workflow**.
6. Select `publish` and enter the exact manifest version.

The workflow builds its own VSIX from the selected commit and refuses a version mismatch.

## Verify

- <https://marketplace.visualstudio.com/items?itemName=Uone.personal-knowledge>
- <https://marketplace.visualstudio.com/manage/publishers/Uone>

Marketplace validation can delay public visibility. Versions are immutable once accepted or reserved.

## Emergency fallback

Upload the exact tested VSIX through the Marketplace management website. Do not introduce PAT, client-secret, or DCF credentials.

## Detailed documentation

See:

```text
skills/User/VSCode Marketplace/publish-vscode-extension.md
```
