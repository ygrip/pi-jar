# Contributing

pi-jar is intentionally small. Contributions should improve clarity, role visibility, responsiveness, compatibility, or useful integration.

## Before opening a change

Run:

```bash
npm install
npm run check
```

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
