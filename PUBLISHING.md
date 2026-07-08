# Publishing Guide

## One-time setup

```bash
# Install vsce globally (if not already)
npm install -g @vscode/vsce

# Login with your Marketplace PAT
# Get a PAT at: https://dev.azure.com → User Settings → Personal access tokens
# Scope required: Marketplace → Manage
npx vsce login Uone
```

## Build & package

```bash
npm run build       # compile TypeScript + copy assets
npm run package     # produces personal-knowledge-<version>.vsix
```

## Publish a new version

```bash
# 1. Bump version (choose patch / minor / major)
npm version patch   # 1.0.0 → 1.0.1

# 2. Build, package, and publish in one step
npx vsce publish

# 3. Push the version bump commit + tag to GitHub
git push && git push --tags
```

## Manual upload (alternative to CLI)

1. Run `npm run build && npm run package`
2. Go to https://marketplace.visualstudio.com/manage/publishers/Uone
3. Click the **⋯** menu on the extension → **Update**
4. Upload the new `.vsix` file

## Marketplace listing

https://marketplace.visualstudio.com/items?itemName=Uone.personal-knowledge
