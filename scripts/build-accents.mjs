import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ACCENTS } from "../src/accent.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const base = JSON.parse(readFileSync(join(root, "themes/pi-jar-dark.json"), "utf8"));
for (const [name, colors] of Object.entries(ACCENTS)) {
  const variant = {
    ...base,
    name: `pi-jar-dark-${name}`,
    vars: { ...base.vars, accent: colors.accent, selected: colors.selected }
  };
  writeFileSync(join(root, `themes/pi-jar-dark-${name}.json`), JSON.stringify(variant, null, 2) + "\n");
}
