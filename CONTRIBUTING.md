# Contributing

pi-jar is intentionally small. Contributions should improve clarity, role visibility, responsiveness, compatibility, or useful integration.

## Before opening a change

Run:

```bash
npm ci
npm audit
npm run check
npm test
```

Install-script approvals in `package.json` are pinned to reviewed dependency versions.
When updating dependencies, review `npm install-scripts ls` and approve only scripts
that are needed and understood (for example, esbuild's binary setup).

The `node-domexception` deprecation comes from Pi's Google SDK authentication
chain, not pi-jar code. It remains an upstream warning; do not suppress all npm
warnings or replace that dependency with an incompatible shim.

If npm reports an unknown `always-auth` user setting locally, remove the obsolete
`always-auth` line from the user npmrc reported by `npm config get userconfig`,
leaving registry-scoped authentication intact. Release CI uses `setup-node@v6`,
which no longer generates that setting.

Then test the theme and extension inside Pi.

## Design constraints

- animations must communicate state;
- idle mode should not repaint continuously;
- role information must remain understandable without color;
- narrow terminals must degrade gracefully;
- integration code should prefer public APIs over private implementation details;
- pi-jar must not become an orchestrator.

## Pull requests

Keep changes focused and include:

- what changed;
- why it improves the UI or integration;
- how it was tested;
- screenshots or a short recording for visible UI changes when practical.
