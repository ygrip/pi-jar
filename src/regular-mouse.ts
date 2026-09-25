import type { TUI } from "@earendil-works/pi-tui";

// Pi intentionally leaves main-screen mouse reporting disabled. Share ownership
// between the welcome button and composer so one cannot disable the other.
const owners = new Map<TUI, number>();
process.once("exit", () => {
  for (const tui of owners.keys()) {
    if (tui.mode !== "regular") continue;
    try { tui.terminal.write("\x1b[?1000l\x1b[?1006l"); } catch { /* terminal may have closed */ }
  }
});
export function acquireRegularMouse(tui: TUI): () => void {
  if (tui.mode !== "regular") return () => {};
  const count = owners.get(tui) ?? 0;
  owners.set(tui, count + 1);
  if (!count) tui.terminal.write("\x1b[?1000h\x1b[?1006h");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (owners.get(tui) ?? 1) - 1;
    if (remaining) owners.set(tui, remaining);
    else {
      owners.delete(tui);
      if (tui.mode === "regular") {
        try { tui.terminal.write("\x1b[?1000l\x1b[?1006l"); } catch { /* terminal may already be closed */ }
      }
    }
  };
}
