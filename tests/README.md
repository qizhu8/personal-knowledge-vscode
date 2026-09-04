# Tests

- Automated JavaScript and Python regression tests live directly in this directory.
- Manual test matrices and behavioral cases live in `cases/`.
- Run the real Extension Host startup smoke test with `npm run test:startup`. It uses VS Code 1.90.0, verifies activation, command registration, Panel creation, and the Webview ready handshake. The first run downloads the test instance; Linux hosts require `DISPLAY` or Xvfb.
- Run the full release gate with `npm run test:release`.

Planning documents are kept separately under `docs/planning/`.