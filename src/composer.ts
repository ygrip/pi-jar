import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { WorkingPhase } from "./working.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
const ICONS: Record<WorkingPhase, readonly string[]> = {
  idle: ["◇"], generating: ["◇", "◈", "◆", "◈"], tool: ["◐", "◓", "◑", "◒"], waiting: ["○"]
};
export function composerIcon(phase: WorkingPhase, frame = 0): string {
  const icons = ICONS[phase];
  return icons[frame % icons.length] ?? "◇";
}

/** Frame a real editor without changing its keyboard, history or autocomplete implementation. */
export function roundedInput(lines: string[], width: number, focused: boolean, theme: EditorTheme, focusPaint?: (text: string) => string, icon = "◇"): string[] {
  if (width < 8 || lines.length < 2) return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
  const border = focused && focusPaint ? focusPaint : theme.borderColor;
  const title = truncateToWidth(` ${icon} `, width - 3);
  const top = border("╭─" + title + "─".repeat(Math.max(0, width - 3 - visibleWidth(title))) + "╮");
  const bottom = border("╰" + "─".repeat(width - 2) + "╯");
  return [top, ...lines.slice(1, -1).map((line) => border("│") + line + " ".repeat(Math.max(0, width - 2 - visibleWidth(line))) + border("│")), bottom];
}

class RoundedEditor extends CustomEditor {
  private readonly colors: EditorTheme;
  private readonly paint: (text: string) => string;
  private readonly icon: () => string;
  constructor(tui: TUI, colors: EditorTheme, keys: ConstructorParameters<typeof CustomEditor>[2], paint: (text: string) => string, icon: () => string) {
    super(tui, colors, keys);
    this.colors = colors;
    this.paint = paint;
    this.icon = icon;
  }
  override render(width: number): string[] {
    return roundedInput(super.render(width < 8 ? width : width - 2), width, this.focused, this.colors, this.paint, this.icon());
  }
  override handleMouse(event: Parameters<NonNullable<EditorComponent["handleMouse"]>>[0]) {
    return super.handleMouse({ ...event, x: event.x - 1, width: Math.max(1, event.width - 2) });
  }
}

class ThemedEditor implements EditorComponent {
  private readonly base: EditorComponent;
  private readonly theme: EditorTheme;
  private readonly paint: (text: string) => string;
  private readonly icon: () => string;
  constructor(base: EditorComponent, theme: EditorTheme, paint: (text: string) => string, icon: () => string) {
    this.base = base;
    this.theme = theme;
    this.paint = paint;
    this.icon = icon;
  }
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
  render(width: number): string[] { return roundedInput(this.base.render(width < 8 ? width : width - 2), width, this.focused, this.theme, this.paint, this.icon()); }
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
  private tui?: TUI;
  private timer?: ReturnType<typeof setInterval>;
  private phase: WorkingPhase = "idle";
  private frame = 0;
  private animations = true;
  private icon = () => composerIcon(this.phase, this.frame);
  setActivity(phase: WorkingPhase, animations: boolean): void {
    const changed = this.phase !== phase || this.animations !== animations;
    if (!changed && (this.timer || !this.enabled || !animations || (phase !== "generating" && phase !== "tool"))) return;
    this.phase = phase;
    this.animations = animations;
    if (changed) this.frame = 0;
    this.stopTimer();
    if (this.enabled && animations && (phase === "generating" || phase === "tool")) {
      this.timer = setInterval(() => { this.frame++; this.tui?.requestRender(); }, 240);
      this.timer.unref?.();
    }
    if (changed && this.enabled) this.tui?.requestRender();
  }
  private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  enable(ctx: ExtensionContext): boolean {
    if (!ctx.hasUI || ctx.mode !== "tui") return false;
    if (this.enabled) return true;
    try {
      const previous = ctx.ui.getEditorComponent();
      const draft = ctx.ui.getEditorText();
      const factory: EditorFactory = (tui, theme, keys) => {
        this.tui = tui;
        const paint = (text: string) => ctx.ui.theme?.fg("accent", text) ?? theme.borderColor(text);
        return previous ? new ThemedEditor(previous(tui, theme, keys), theme, paint, this.icon) : new RoundedEditor(tui, theme, keys, paint, this.icon);
      };
      this.previous = previous;
      this.owner = factory;
      ctx.ui.setEditorComponent(factory);
      ctx.ui.setEditorText(draft);
      this.enabled = true;
      this.setActivity(this.phase, this.animations);
      return true;
    } catch {
      this.disable(ctx);
      return false;
    }
  }
  disable(ctx: ExtensionContext): void {
    this.stopTimer();
    this.tui = undefined;
    this.phase = "idle";
    this.frame = 0;
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
