import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ComposerStyle, roundedInput } from "../src/composer.ts";
import { welcomeLines } from "../src/welcome.ts";

const theme = { borderColor: (text: string) => text, fg: (_color: string, text: string) => text };
const plain = (lines: string[]) => lines.map(stripTerminalSequences);

test("composer title places the active profile between mascot and session and invalidates cached frames", () => {
  const draft = ["────", "unchanged draft", "────"];
  const render = (profile: string, width = 80, icon = "(•ᴗ•)") => roundedInput(draft, width, false,
    theme as never, undefined, icon, "My session", { profile, hint: "enter send" });
  assert.match(plain(render("Default"))[0]!, /\(•ᴗ•\) · \(Default\) My session/);
  assert.match(plain(render("Writing"))[0]!, /\(•ᴗ•\) · \(Writing\) My session/);
  assert.match(plain(render("Default"))[0]!, /\(Default\) My session/);
  assert.match(plain(render("Writing", 80, "pi"))[0]!, /pi · \(Writing\) My session/);
  assert.match(render("Writing")[1]!, /unchanged draft/);
  for (const width of [8, 12, 24, 40, 80]) {
    assert.ok(render("写作 profile with a very long name", width).every((line) => visibleWidth(line) <= width));
  }
  const sanitized = plain(render("\x1b[31mWriting\x1b[0m\nprofile"))[0]!;
  assert.match(sanitized, /\(Writing profile\) My session/);
  assert.doesNotMatch(sanitized, /session My session/);
});

test("setting a composer profile repaints without replacing the editor or changing its draft", () => {
  let draft = "keep my draft";
  let renders = 0;
  let current: Function | undefined = () => ({
    render: () => ["────", draft, "────"], invalidate() {}, handleInput() {},
    getText: () => draft, setText: (text: string) => { draft = text; }
  });
  const ctx = { hasUI: true, mode: "tui", sessionManager: { getSessionName: () => "My session" }, ui: {
    theme, getEditorComponent: () => current, setEditorComponent: (factory: Function | undefined) => { current = factory; },
    getEditorText: () => draft, setEditorText: (text: string) => { draft = text; }
  } };
  const style = new ComposerStyle();
  style.setActivity("idle", false);
  try {
    assert.equal(style.enable(ctx as never), true);
    const installed = current;
    const editor = current?.({ requestRender() { renders++; } }, theme, {}) as { render(width: number): string[] };
    style.setProfile("Writing");
    assert.equal(current, installed);
    assert.equal(draft, "keep my draft");
    assert.ok(renders > 0);
    assert.match(plain(editor.render(80)).find((line) => line.startsWith("╭"))!, /\(Writing\) My session/);
    style.setMascot(false);
    assert.match(plain(editor.render(80)).find((line) => line.startsWith("╭"))!, /pi · \(Writing\) My session/);
    style.setProfile("\x1b[31mReview\x1b[0m\nprofile");
    assert.match(plain(editor.render(80)).find((line) => line.startsWith("╭"))!, /\(Review profile\) My session/);
  } finally { style.disable(ctx as never); }
  assert.equal(draft, "keep my draft");
});

test("welcome shows Default or the selected profile at wide and narrow widths and refreshes its cache", () => {
  for (const width of [16, 24, 32, 48, 80, 120]) {
    const before = welcomeLines(width, 0, theme.fg, { profile: "Default" });
    const after = welcomeLines(width, 0, theme.fg, { profile: "Writing" });
    assert.ok(after.every((line) => visibleWidth(line) <= width));
    assert.match(plain(before).join("\n"), /Default/);
    assert.match(plain(after).join("\n"), /Writing/);
    assert.doesNotMatch(plain(after).join("\n"), /Default/);
  }
  assert.match(plain(welcomeLines(80, 0, theme.fg)).join("\n"), /PROFILE\s+Default/);
  for (const width of [72, 73, 74, 75, 76]) {
    const lines = welcomeLines(width, 0, theme.fg, { profile: "p".repeat(31) + "Z" });
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.match(plain(lines).join("\n"), /Z/, "the distinguishing suffix must remain visible at the wide-layout breakpoint");
  }
  const sanitized = plain(welcomeLines(120, 0, theme.fg, { profile: "\x1b[31mReview\x1b[0m\nprofile" })).join("\n");
  assert.match(sanitized, /PROFILE\s+Review profile/);
});
