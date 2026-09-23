# pi-jar

A role-aware, animated theme and TUI extension for [Pi](https://github.com/earendil-works/pi), inspired by the visual language of Setara and the multi-agent character of Punakawan.

> **Status:** early foundation. The theme and extension scaffold are usable; role integrations are the next milestone.

## What pi-jar is

pi-jar is not just a color theme. It is a Pi package that combines:

- a restrained dark theme designed for long coding sessions;
- animated working states that communicate activity without turning the terminal into a slot machine;
- first-class visibility for agent roles such as Gareng, Petruk, and Bagong;
- a responsive footer for model, thinking, branch, context, role, and integration status;
- adapters planned for Team Mode, Advisor Flow, and SoL-Pi.

The design rule is simple: **role visibility first, useful telemetry second, decoration last.**

## Install

Install directly from GitHub:

```bash
pi install git:github.com/ygrip/pi-jar
```

Then select the theme from Pi settings:

```text
/settings
```

Choose `pi-jar-dark`.

The extension is loaded by the package automatically. Use:

```text
/jar
/jar demo
/jar reset
```

`/jar demo` previews the role-aware footer while real Team Mode integration is being built.

## Current preview

```text
 pi-jar                                      feature/auth
 Claude Sonnet · medium                     ctx 58%

 GAR ◈ analyze     PET ◐ implement     BAG ◇ waiting
```

The final UI will adapt to terminal width instead of preserving a giant dashboard at all costs.

## Design direction

**Setara influence**

- clean technical surfaces;
- cyan/blue precision accents;
- readable hierarchy;
- low-noise information density.

**Punakawan influence**

- warm amber/green secondary palette;
- visible named roles;
- orchestration state as part of the UI;
- distinct role motion rather than generic spinners.

The result should feel like one coherent terminal interface, not two products taped together.

## Repository structure

```text
pi-jar/
├── extensions/          Pi extension entry point
├── src/                 UI state and animation primitives
├── themes/              Native Pi themes
└── docs/
    ├── PLAN.md
    ├── DESIGN.md
    ├── INTEGRATIONS.md
    └── DEVELOPMENT.md
```

## Roadmap

The implementation plan lives in [docs/PLAN.md](docs/PLAN.md). The major milestones are:

1. foundation and theme;
2. responsive role-aware footer;
3. real Team Mode role activity;
4. Advisor Flow and SoL-Pi integration;
5. configurable presets and packaging polish.

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
