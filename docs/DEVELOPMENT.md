# Development

## Requirements

- Node.js supported by your Pi installation
- npm
- a current Pi installation

## Local setup

```bash
git clone https://github.com/ygrip/pi-jar.git
cd pi-jar
npm install
npm run check
```

## Load locally in Pi

Install the working copy as a local Pi package:

```bash
pi install "$(pwd)"
```

Or run against a temporary checkout without publishing it.

Use `pi list` to verify the package is loaded.

## Theme testing

Select:

```text
/settings
```

and choose `pi-jar-dark`.

Pi hot-reloads custom theme files when they are loaded as normal custom themes. Package development may require `/reload` depending on how the package is loaded.

Check:

- user messages;
- tool pending/success/error states;
- diffs;
- Markdown;
- syntax highlighting;
- all thinking levels;
- bash mode;
- narrow and wide terminal widths.

## Extension testing

Useful commands:

```text
/jar
/jar demo
/jar reset
/jar animations off
/jar animations on
```

`/jar demo` exists so the visual role system can be tuned before Team Mode integration is complete.

## Development rules

- keep idle CPU/repaint overhead negligible;
- avoid coupling to undocumented internals from other extensions;
- keep role rendering generic;
- do not add decorative animation that carries no state;
- preserve useful behavior with animations disabled.
