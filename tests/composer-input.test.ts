import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS, isKittyProtocolActive,
  setKittyProtocolActive, stripTerminalSequences, type EditorComponent, type KeybindingsConfig } from "@earendil-works/pi-tui";
import { ComposerStyle } from "../src/composer.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
function fixture(t: TestContext, wrapped: boolean, kitty = true, bindings?: KeybindingsConfig) {
  const originalKeys = getKeybindings();
  const originalKitty = isKittyProtocolActive();
  const keys = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.message.followUp": { defaultKeys: "alt+enter" } }, bindings);
  setKeybindings(keys); setKittyProtocolActive(kitty);
  const submitted: string[] = []; const followUps: string[] = [];
  const registerFollowUp = (editor: CustomEditor) => editor.onAction("app.message.followUp", () => followUps.push(editor.getText()));
  let factory: EditorFactory | undefined;
  if (wrapped) factory = (tui, theme, injected) => {
    const base = new CustomEditor(tui, theme, injected);
    registerFollowUp(base);
    return base;
  };
  const theme = { borderColor: (text: string) => text };
  const ctx = { hasUI: true, mode: "tui", ui: {
    getEditorComponent: () => factory,
    setEditorComponent: (next: EditorFactory | undefined) => { factory = next; },
    getEditorText: () => "", setEditorText() {}
  } };
  const style = new ComposerStyle(); style.setMascot(false);
  t.after(() => { style.disable(ctx as never); setKeybindings(originalKeys); setKittyProtocolActive(originalKitty); });
  assert.equal(style.enable(ctx as never), true);
  const editor: EditorComponent = factory!({ requestRender() {}, terminal: { rows: 24 } } as never, theme as never, keys as never);
  if (editor instanceof CustomEditor) registerFollowUp(editor);
  editor.onSubmit = text => submitted.push(text);
  return { editor, keys, submitted, followUps };
}

const NEWLINE_KEYS = [
  { label: "Kitty Shift+Return", data: "\x1b[13;2u", kitty: true },
  { label: "Kitty Shift+keypad Enter", data: "\x1b[57414;2u", kitty: true },
  { label: "xterm modifyOtherKeys Shift+Return", data: "\x1b[27;2;13~", kitty: false },
  { label: "legacy modified Return", data: "\x1b[13;2~", kitty: false },
  { label: "legacy mapping with Kitty active", data: "\x1b\r", kitty: true },
  { label: "Ctrl+J without extended keys", data: "\n", kitty: false }
];
for (const wrapped of [false, true]) {
  let kind = "rounded";
  if (wrapped) kind = "wrapped";
  for (const key of NEWLINE_KEYS) {
    test(`${kind} composer: ${key.label} inserts a newline without submission`, t => {
      const { editor, submitted, followUps } = fixture(t, wrapped, key.kitty);
      editor.setText("first"); editor.handleInput(key.data); editor.handleInput("second");
      assert.equal(editor.getText(), "first\nsecond");
      assert.deepEqual(submitted, []); assert.deepEqual(followUps, []);
      editor.handleInput("\r");
      assert.deepEqual(submitted, ["first\nsecond"]);
    });
  }
  test(`${kind} composer: Alt+Enter still queues a follow-up`, t => {
    const { editor, submitted, followUps } = fixture(t, wrapped);
    editor.setText("draft"); editor.handleInput("\x1b[13;3u");
    assert.deepEqual(followUps, ["draft"]); assert.deepEqual(submitted, []);
  });
  test(`${kind} composer: legacy Alt+Return is not forcibly reinterpreted as Shift+Return`, t => {
    const { editor, submitted, followUps } = fixture(t, wrapped, false);
    editor.setText("draft"); editor.handleInput("\x1b\r");
    assert.deepEqual(followUps, ["draft"]); assert.deepEqual(submitted, []);
  });
  test(`${kind} composer: bracketed multiline paste never submits`, t => {
    const { editor, submitted, followUps } = fixture(t, wrapped);
    editor.handleInput("\x1b[200~first\nsecond\x1b[201~");
    assert.equal(editor.getText(), "first\nsecond");
    assert.deepEqual(submitted, []); assert.deepEqual(followUps, []);
  });
  test(`${kind} composer: hint exposes the Ctrl+J fallback`, t => {
    const { editor } = fixture(t, wrapped);
    const screen = editor.render(120).map(stripTerminalSequences).join("\n");
    assert.match(screen, /Ctrl\+J/);
  });
  test(`${kind} composer: hint follows remapped newline keys`, t => {
    const { editor, submitted } = fixture(t, wrapped, true, { "tui.input.newLine": "ctrl+enter" });
    const screen = editor.render(120).map(stripTerminalSequences).join("\n");
    assert.match(screen, /ctrl\+enter/);
    assert.doesNotMatch(screen, /Ctrl\+J|⇧⏎/);
    editor.setText("first"); editor.handleInput("\x1b[13;5u");
    assert.equal(editor.getText(), "first\n"); assert.deepEqual(submitted, []);
  });
  test(`${kind} composer: hint updates after keybinding reload and respects disabled newline`, t => {
    const { editor, keys } = fixture(t, wrapped);
    assert.match(editor.render(120).map(stripTerminalSequences).join("\n"), /Ctrl\+J/);
    keys.setUserBindings({ "tui.input.newLine": [] });
    const screen = editor.render(120).map(stripTerminalSequences).join("\n");
    assert.match(screen, /newline unbound/);
    assert.doesNotMatch(screen, /Ctrl\+J|⇧⏎/);
  });
}
