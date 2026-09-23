import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** Frame a real editor without changing its keyboard, history or autocomplete implementation. */
export function roundedInput(lines: string[], width: number, focused: boolean, frame: number, theme: EditorTheme, focusPaint?: (phase: number, text: string) => string): string[] {
  if (width < 8 || lines.length < 2) return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
  const border = focused && focusPaint ? (text: string) => focusPaint(frame % 4 < 2 ? 0 : 1, text) : theme.borderColor;
  const title = truncateToWidth(focused ? " pi-jar · compose " : " pi-jar ", width - 3);
  const top = border("╭─" + title + "─".repeat(Math.max(0, width - 3 - visibleWidth(title))) + "╮");
  const bottom = border("╰" + "─".repeat(width - 2) + "╯");
  return [top, ...lines.slice(1, -1).map((line) => border("│") + line + " ".repeat(Math.max(0, width - 2 - visibleWidth(line))) + border("│")), bottom];
}

class RoundedEditor extends CustomEditor {
  private frame = 0;
  private motion = true;
  private readonly colors: EditorTheme;
  private readonly paint: (phase: number, text: string) => string;
  constructor(tui: TUI, colors: EditorTheme, keys: ConstructorParameters<typeof CustomEditor>[2], paint: (phase: number, text: string) => string) {
    super(tui, colors, keys);
    this.colors = colors;
    this.paint = paint;
  }
  setMotion(enabled: boolean) { this.motion = enabled; if (!enabled) this.frame = 0; this.tui.requestRender?.(); }
  advance() { if (this.focused && this.motion) { this.frame++; this.tui.requestRender?.(); } }
  override render(width: number): string[] {
    return roundedInput(super.render(width < 8 ? width : width - 2), width, this.focused, this.frame, this.colors, this.paint);
  }
  override handleMouse(event: Parameters<NonNullable<EditorComponent["handleMouse"]>>[0]) {
    return super.handleMouse({ ...event, x: event.x - 1, width: Math.max(1, event.width - 2) });
  }
}

class ThemedEditor implements EditorComponent {
  private frame = 0;
  private motion = true;
  private readonly base: EditorComponent;
  private readonly theme: EditorTheme;
  private readonly tui: TUI;
  private readonly paint: (phase: number, text: string) => string;
  constructor(base: EditorComponent, theme: EditorTheme, tui: TUI, paint: (phase: number, text: string) => string) {
    this.base = base;
    this.theme = theme;
    this.tui = tui;
    this.paint = paint;
  }
  advance() { if (this.focused && this.motion) { this.frame++; this.tui.requestRender?.(); } }
  setMotion(enabled: boolean) { this.motion = enabled; if (!enabled) this.frame = 0; this.tui.requestRender?.(); }
  get focused(): boolean { return "focused" in this.base ? !!this.base.focused : false; }
  set focused(value: boolean) { if ("focused" in this.base) this.base.focused = value; }
  get onSubmit() { return this.base.onSubmit; }
  set onSubmit(handler: ((text: string) => void) | undefined) { this.base.onSubmit = handler; }
  get onChange() { return this.base.onChange; }
  set onChange(handler: ((text: string) => void) | undefined) { this.base.onChange = handler; }
  get borderColor() { return this.base.borderColor; }
  set borderColor(color: ((str: string) => string) | undefined) { this.base.borderColor = color; }
  getText() { return this.base.getText(); }
  setText(text: string) { this.base.setText(text); }
  handleInput(data: string) { this.base.handleInput(data); }
  invalidate() { this.base.invalidate(); }
  render(width: number): string[] { return roundedInput(this.base.render(width < 8 ? width : width - 2), width, this.focused, this.frame, this.theme, this.paint); }
  addToHistory(text: string) { this.base.addToHistory?.(text); }
  insertTextAtCursor(text: string) { this.base.insertTextAtCursor?.(text); }
  getExpandedText() { return this.base.getExpandedText?.() ?? this.base.getText(); }
  setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]) { this.base.setAutocompleteProvider?.(provider); }
  setPaddingX(value: number) { this.base.setPaddingX?.(value); }
  setAutocompleteMaxVisible(value: number) { this.base.setAutocompleteMaxVisible?.(value); }
  handleMouse(event: Parameters<NonNullable<EditorComponent["handleMouse"]>>[0]) { return this.base.handleMouse?.({ ...event, x: event.x - 1, width: Math.max(1, event.width - 2) }); }
}

export class ComposerStyle {
  enabled = false;
  private owner?: EditorFactory;
  private previous?: EditorFactory;
  private editor?: RoundedEditor | ThemedEditor;
  private timer?: ReturnType<typeof setInterval>;
  private motion = true;
  setMotion(enabled: boolean) { this.motion = enabled; this.editor?.setMotion(enabled); }
  enable(ctx: ExtensionContext): boolean {
    if (!ctx.hasUI || ctx.mode !== "tui") return false;
    if (this.enabled) return true;
    try {
      const previous = ctx.ui.getEditorComponent();
      const draft = ctx.ui.getEditorText();
      const factory: EditorFactory = (tui, theme, keys) => {
        const paint = (phase: number, text: string) => ctx.ui.theme?.fg(phase ? "warning" : "accent", text) ?? theme.borderColor(text);
        const editor = previous ? new ThemedEditor(previous(tui, theme, keys), theme, tui, paint) : new RoundedEditor(tui, theme, keys, paint);
        editor.setMotion(this.motion);
        this.editor = editor;
        return editor;
      };
      this.previous = previous;
      this.owner = factory;
      ctx.ui.setEditorComponent(factory);
      ctx.ui.setEditorText(draft);
      this.timer = setInterval(() => this.editor?.advance(), 240);
      this.timer.unref?.();
      this.enabled = true;
      return true;
    } catch {
      this.disable(ctx);
      return false;
    }
  }
  disable(ctx: ExtensionContext): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.editor = undefined;
    try {
      if (ctx.hasUI && ctx.mode === "tui" && this.owner && ctx.ui.getEditorComponent() === this.owner) {
        const draft = ctx.ui.getEditorText();
        ctx.ui.setEditorComponent(this.previous);
        ctx.ui.setEditorText(draft);
      }
    } catch { /* Never let optional editor styling block Pi. */ }
    this.owner = undefined;
    this.previous = undefined;
    this.enabled = false;
  }
}
