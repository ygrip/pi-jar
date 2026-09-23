import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "pi-jar.composer";
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** Delegates editing to the editor that was active before pi-jar was enabled. */
class ThemedEditor implements EditorComponent {
  private readonly base: EditorComponent;
  private readonly theme: EditorTheme;
  constructor(base: EditorComponent, theme: EditorTheme) { this.base = base; this.theme = theme; }
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
  render(width: number): string[] {
    return [
      ...this.base.render(width),
      truncateToWidth(this.theme.borderColor("   pi-jar  ·  Enter send  ·  Esc cancel  ·  /jar composer off"), Math.max(0, width))
    ];
  }
  addToHistory(text: string) { this.base.addToHistory?.(text); }
  insertTextAtCursor(text: string) { this.base.insertTextAtCursor?.(text); }
  getExpandedText() { return this.base.getExpandedText?.() ?? this.base.getText(); }
  setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]) { this.base.setAutocompleteProvider?.(provider); }
  setPaddingX(value: number) { this.base.setPaddingX?.(value); }
  setAutocompleteMaxVisible(value: number) { this.base.setAutocompleteMaxVisible?.(value); }
  handleMouse(event: Parameters<NonNullable<EditorComponent["handleMouse"]>>[0]) { return this.base.handleMouse?.(event); }
}

export class ComposerStyle {
  enabled = false;
  private owner?: EditorFactory;
  private previous?: EditorFactory;
  private widget = false;
  enable(ctx: ExtensionContext): boolean {
    if (!ctx.hasUI || ctx.mode !== "tui") return false;
    if (this.enabled) return true;
    try {
      const previous = ctx.ui.getEditorComponent();
      if (previous) {
        const draft = ctx.ui.getEditorText();
        const factory: EditorFactory = (tui: TUI, theme: EditorTheme, keys) => new ThemedEditor(previous(tui, theme, keys), theme);
        this.previous = previous;
        this.owner = factory;
        ctx.ui.setEditorComponent(factory);
        ctx.ui.setEditorText(draft);
      } else {
        // The native default editor has no public factory: leave its bindings/settings untouched.
        ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
          invalidate() {},
          render(width: number) {
            return [truncateToWidth((ctx.ui.theme ?? theme).fg("accent", "╭─ pi-jar · compose  ·  /jar composer off ─"), Math.max(0, width))];
          }
        }));
        this.widget = true;
      }
      this.enabled = true;
      return true;
    } catch {
      this.disable(ctx);
      return false;
    }
  }
  disable(ctx: ExtensionContext): void {
    try {
      if (ctx.hasUI && ctx.mode === "tui") {
        if (this.owner && ctx.ui.getEditorComponent() === this.owner) {
          const draft = ctx.ui.getEditorText();
          ctx.ui.setEditorComponent(this.previous);
          ctx.ui.setEditorText(draft);
        }
        if (this.widget) ctx.ui.setWidget(WIDGET_KEY, undefined);
      }
    } catch { /* Never let an optional editor decoration block Pi. */ }
    this.owner = undefined;
    this.previous = undefined;
    this.widget = false;
    this.enabled = false;
  }
}
