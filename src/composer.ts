import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, type EditorComponent, type EditorTheme, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Mascot, MASCOT_FACE_WIDTH, mascotFace, paintFace, paintTip, type MascotMood } from "./mascot.ts";
import type { SuggestionState } from "./suggest.ts";
import type { WorkingPhase } from "./working.ts";
import { imageChip, imageInfo, imagePaths } from "./attachments.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type MouseEvent = Parameters<NonNullable<EditorComponent["handleMouse"]>>[0];

const PHASE_MOODS: Record<WorkingPhase, readonly MascotMood[]> = {
  idle: ["idle"], generating: ["happy", "thinking"], tool: ["tool"], waiting: ["waiting"]
};
/** Plain one-line face for a phase; every phase has the same width. */
export function composerIcon(phase: WorkingPhase, frame = 0): string {
  const moods = PHASE_MOODS[phase];
  return mascotFace(moods[frame % moods.length] ?? "idle");
}
export function shortSessionId(id?: string): string {
  const clean = id?.trim();
  if (!clean) return "";
  const tail = clean.includes("-") ? clean.split("-").at(-1)! : clean;
  return tail.slice(0, 8);
}

const SESSION_FIRST = ["ember", "quiet", "steady", "silver", "warm", "clear", "gentle", "lunar"] as const;
const SESSION_LAST = ["trail", "lantern", "forge", "orbit", "harbor", "path", "spark", "grove"] as const;

function sessionHash(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Prefer Pi's human session title; otherwise derive a stable readable alias from the thread id. */
export function sessionDisplayName(name?: string, id?: string): string {
  const explicit = name?.trim().replace(/\s+/g, " ");
  if (explicit) return explicit;
  const hash = sessionHash(id?.trim() || "pi-jar");
  const first = SESSION_FIRST[hash % SESSION_FIRST.length]!;
  const last = SESSION_LAST[Math.floor(hash / SESSION_FIRST.length) % SESSION_LAST.length]!;
  return `${first}-${last}`;
}

const CURSOR = "\x1b[7m \x1b[0m";
const BORDER = /^─+(?:\s*[↑↓]\s*\d+\s*more\s*─*)?$/;
/** Index of the editor's bottom border: known row count when available, else the first plain border row. */
function bottomBorderIndex(lines: readonly string[], visibleRows?: number): number {
  if (visibleRows != null && visibleRows >= 0 && BORDER.test(stripTerminalSequences(lines[visibleRows + 1] ?? "").trim())) return visibleRows + 1;
  for (let index = 1; index < lines.length; index++) if (BORDER.test(stripTerminalSequences(lines[index]!).trim())) return index;
  return lines.length - 1;
}
const overflowLabel = (line: string | undefined) => /[↑↓]\s*\d+\s*more/.exec(stripTerminalSequences(line ?? ""))?.[0];

export interface RoundedInputOptions {
  /** Dim inline suggestion shown after the cursor when the draft is empty. */
  ghost?: string;
  /** Dim key hints in the bottom border. */
  hint?: string;
  /** Pre-painted icon (overrides `icon` for rendering, `icon` still sets width). */
  paintedIcon?: string;
  /** Known number of editor content rows (lets the frame skip heuristics). */
  visibleRows?: number;
  /** A painted row directly below the frame (image attachment chips). */
  below?: string;
  dim?: (text: string) => string;
}

/** Frame a real editor without changing its keyboard, history or autocomplete implementation. */
export function roundedInput(lines: string[], width: number, focused: boolean, theme: EditorTheme, focusPaint?: (text: string) => string,
  icon = composerIcon("idle"), session = "", options: RoundedInputOptions = {}): string[] {
  if (width < 8 || lines.length < 2) return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
  const border = focused && focusPaint ? focusPaint : theme.borderColor;
  const dim = options.dim ?? ((text: string) => text);
  const bottom = bottomBorderIndex(lines, options.visibleRows);
  const inner = width - 2;
  const meta = session ? `${icon} · session ${session}` : icon;
  const title = truncateToWidth(` ${meta} `, width - 3);
  const paintedTitle = options.paintedIcon && title.includes(icon) ? title.replace(icon, options.paintedIcon) : title;
  const above = overflowLabel(lines[0]);
  const topRoom = width - 3 - visibleWidth(title);
  const topRight = above && topRoom > visibleWidth(above) + 3 ? " " + above + " ─" : "";
  const top = border("╭─") + paintedTitle + border("─".repeat(Math.max(0, topRoom - visibleWidth(topRight))) + topRight + "╮");
  const below = overflowLabel(lines[bottom]);
  const hint = options.hint && width >= 60 ? ` ${options.hint} ` : "";
  const left = below ? `─ ${below} ` : "";
  const fill = Math.max(0, width - 2 - visibleWidth(left) - visibleWidth(hint) - 1);
  const bottomLine = border("╰" + left + "─".repeat(fill)) + (hint ? dim(hint) : "") + border((hint ? "─" : "─") + "╯");
  const content = lines.slice(1, bottom).map((line, index) => {
    let row = line;
    if (index === 0 && options.ghost && row.includes(CURSOR)) {
      const base = row.replace(/ +$/, "");
      const room = inner - visibleWidth(base);
      if (room > 2) row = base + dim(truncateToWidth(options.ghost + "   ⇥ tab", room, "…"));
    }
    const fitted = truncateToWidth(row, inner);
    return border("│") + fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted))) + border("│");
  });
  // Autocomplete rows stay below the frame, indented to line up with the text.
  const trailing = lines.slice(bottom + 1).map((line) => truncateToWidth(" " + line, width));
  return [truncateToWidth(top, width), ...content, truncateToWidth(bottomLine, width),
    ...(options.below ? [truncateToWidth(" " + options.below, width)] : []), ...trailing];
}

export interface ComposerDecor {
  /** Title icon width source (plain text). */
  icon(): string;
  /** Painted icon, or undefined to use theme border colors. */
  paintedIcon(): string | undefined;
  /** Flame-tip row above the frame, or undefined when there is no room. */
  tip(width: number): string | undefined;
  session(): string;
  ghost(): string | undefined;
  hint(): string | undefined;
  accept(): string | undefined;
  typed(): void;
  poke(): void;
  dim(text: string): string;
  /** Chips for images referenced in the draft, or undefined. */
  attachments(text: string): string | undefined;
}

/** The face starts after `╭─ ` in the top border. */
const faceColumns = (x: number) => x >= 3 && x < 3 + MASCOT_FACE_WIDTH;

class RoundedEditor extends CustomEditor {
  private readonly colors: EditorTheme;
  private readonly paint: (text: string) => string;
  private readonly decor: ComposerDecor;
  private tipRows = 0;
  private ghostShown = false;
  constructor(tui: TUI, colors: EditorTheme, keys: ConstructorParameters<typeof CustomEditor>[2], paint: (text: string) => string, decor: ComposerDecor) {
    super(tui, colors, keys);
    this.colors = colors;
    this.paint = paint;
    this.decor = decor;
  }

  /** Let drafts grow to ~60% of the terminal (Pi's editor caps at 30%) before scrolling. */
  private renderTall(width: number): string[] {
    const self = this as unknown as { tui?: { terminal?: { rows?: number } } };
    const tui = self.tui;
    const rows = tui?.terminal?.rows;
    if (!tui || !rows || !Number.isFinite(rows)) return super.render(width);
    const tall = new Proxy(tui, { get: (target, key, receiver) => key === "terminal"
      ? new Proxy(target.terminal!, { get: (term, name) => name === "rows" ? rows * 2 : Reflect.get(term, name, term) })
      : Reflect.get(target, key, receiver) });
    try {
      self.tui = tall;
      return super.render(width);
    } finally {
      self.tui = tui;
    }
  }

  override render(width: number): string[] {
    const inner = this.renderTall(width < 8 ? width : width - 2);
    const empty = this.getText() === "";
    const ghost = empty && !this.isShowingAutocomplete() ? this.decor.ghost() : undefined;
    this.ghostShown = !!ghost;
    const visibleRows = (this as unknown as { renderedVisibleLineCount?: number }).renderedVisibleLineCount;
    const framed = roundedInput(inner, width, this.focused, this.colors, this.paint, this.decor.icon(), this.decor.session(), {
      ...(ghost ? { ghost } : {}), ...(this.decor.hint() ? { hint: this.decor.hint()! } : {}),
      ...(this.decor.paintedIcon() ? { paintedIcon: this.decor.paintedIcon()! } : {}),
      ...(visibleRows != null ? { visibleRows } : {}), dim: this.decor.dim,
      ...(this.decor.attachments(this.getText()) ? { below: this.decor.attachments(this.getText())! } : {})
    });
    const tip = width >= 8 ? this.decor.tip(width) : undefined;
    this.tipRows = tip ? 1 : 0;
    return tip ? [truncateToWidth(tip, width), ...framed] : framed;
  }

  override handleInput(data: string): void {
    if (this.getText() === "" && !this.isShowingAutocomplete() && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
      const accepted = this.decor.accept();
      if (accepted) { this.setText(accepted); return; }
    }
    super.handleInput(data);
    if (this.getText() !== "") this.decor.typed();
  }

  override handleMouse(event: MouseEvent) {
    const y = event.y - this.tipRows;
    if ((y === 0 || y < 0) && faceColumns(event.x)) {
      if (event.type === "click" && event.button === "left") { this.decor.poke(); return { handled: true, focus: true }; }
      return undefined;
    }
    if (y === 1 && this.ghostShown && event.type === "click" && event.button === "left" && event.x > 2) {
      const accepted = this.decor.accept();
      if (accepted) { this.setText(accepted); return { handled: true, focus: true }; }
    }
    if (y < 0) return undefined;
    return super.handleMouse({ ...event, y, x: event.x - 1, width: Math.max(1, event.width - 2), height: Math.max(1, event.height - this.tipRows) });
  }
}

class ThemedEditor implements EditorComponent {
  private readonly base: EditorComponent;
  private readonly theme: EditorTheme;
  private readonly paint: (text: string) => string;
  private readonly decor: ComposerDecor;
  private tipRows = 0;
  constructor(base: EditorComponent, theme: EditorTheme, paint: (text: string) => string, decor: ComposerDecor) {
    this.base = base;
    this.theme = theme;
    this.paint = paint;
    this.decor = decor;
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
  handleInput(data: string) {
    if (this.base.getText() === "" && matchesKey(data, Key.tab)) {
      const accepted = this.decor.accept();
      if (accepted) { this.base.setText(accepted); return; }
    }
    this.base.handleInput(data);
    if (this.base.getText() !== "") this.decor.typed();
  }
  invalidate() { this.base.invalidate(); }
  render(width: number): string[] {
    const ghost = this.base.getText() === "" ? this.decor.ghost() : undefined;
    const framed = roundedInput(this.base.render(width < 8 ? width : width - 2), width, this.focused, this.theme, this.paint, this.decor.icon(), this.decor.session(), {
      ...(ghost ? { ghost } : {}), ...(this.decor.paintedIcon() ? { paintedIcon: this.decor.paintedIcon()! } : {}), dim: this.decor.dim,
      ...(this.decor.attachments(this.base.getText()) ? { below: this.decor.attachments(this.base.getText())! } : {})
    });
    const tip = width >= 8 ? this.decor.tip(width) : undefined;
    this.tipRows = tip ? 1 : 0;
    return tip ? [truncateToWidth(tip, width), ...framed] : framed;
  }
  addToHistory(text: string) { this.base.addToHistory?.(text); }
  insertTextAtCursor(text: string) { this.base.insertTextAtCursor?.(text); }
  getExpandedText() { return this.base.getExpandedText?.() ?? this.base.getText(); }
  setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]) { this.base.setAutocompleteProvider?.(provider); }
  setPaddingX(value: number) { this.base.setPaddingX?.(value); }
  setAutocompleteMaxVisible(value: number) { this.base.setAutocompleteMaxVisible?.(value); }
  handleMouse(event: MouseEvent) {
    const y = event.y - this.tipRows;
    if (y < 0) return undefined;
    return this.base.handleMouse?.({ ...event, y, x: event.x - 1, width: Math.max(1, event.width - 2) });
  }
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
  private mascotOn = true;
  private session = "";
  private cwd = process.cwd();
  private lastKey = "";
  private readonly mascot = new Mascot();
  private suggestions?: SuggestionState;
  private unsubscribe?: () => void;
  private colors?: { fg(color: string, text: string): string };

  private readonly decor: ComposerDecor = {
    icon: () => this.mascotOn ? mascotFace(this.animations ? this.mascot.mood() : "idle") : "pi",
    paintedIcon: () => {
      if (!this.mascotOn) return undefined;
      const mood = this.animations ? this.mascot.mood() : "idle";
      return paintFace(mascotFace(mood), mood, this.colors ? (color, text) => this.colors!.fg(color, text) : undefined);
    },
    tip: (width) => {
      if (!this.mascotOn || width < 40) return undefined;
      const mood = this.animations ? this.mascot.mood() : "idle";
      const tip = this.animations ? this.mascot.tip(Date.now(), this.frame) : this.mascot.tip(0, 0);
      return " ".repeat(3) + paintTip(tip, mood, this.colors ? (color, text) => this.colors!.fg(color, text) : undefined);
    },
    session: () => this.session,
    ghost: () => this.suggestions?.text,
    hint: () => this.suggestions?.text ? "⇥ accept · ⏎ send · ⇧⏎ newline" : "⏎ send · ⇧⏎ newline · /plan · /goal",
    accept: () => {
      const text = this.suggestions?.text;
      if (text) this.suggestions!.clear();
      return text;
    },
    typed: () => this.suggestions?.clear(),
    poke: () => { this.mascot.flash("poke", 1500); this.tui?.requestRender(); },
    dim: (text) => this.colors?.fg("dim", text) ?? `\x1b[2m${text}\x1b[22m`,
    attachments: (text) => {
      if (!/\.(png|jpe?g|gif|webp)\b/i.test(text)) return undefined;
      const chips = imagePaths(text, this.cwd).map(imageInfo).filter((info) => !!info).map((info) => imageChip(info!));
      if (!chips.length) return undefined;
      return chips.map((chip) => this.colors?.fg("accent", chip) ?? chip).join(this.colors?.fg("dim", "   ") ?? "   ");
    }
  };

  /** Share the suggestion state rendered as ghost text. */
  attachSuggestions(state: SuggestionState): void {
    this.unsubscribe?.();
    this.suggestions = state;
    this.unsubscribe = state.onChange(() => { if (this.enabled) this.tui?.requestRender(); });
  }

  setMascot(on: boolean): void {
    if (this.mascotOn === on) return;
    this.mascotOn = on;
    this.restartTimer();
    if (this.enabled) this.tui?.requestRender();
  }

  /** Short-lived expression, e.g. on errors or a completed goal. */
  flash(mood: "error" | "complete" | "poke", ms = 3000): void {
    this.mascot.flash(mood, ms);
    if (this.enabled) this.tui?.requestRender();
  }

  setActivity(phase: WorkingPhase, animations: boolean): void {
    const changed = this.phase !== phase || this.animations !== animations;
    this.mascot.setPhase(phase);
    if (!changed && (this.timer || !this.enabled || !animations)) return;
    this.phase = phase;
    this.animations = animations;
    if (changed) this.frame = 0;
    this.restartTimer();
    if (changed && this.enabled) this.tui?.requestRender();
  }

  /** One unref'd timer drives flicker, blinks and sleepiness; it renders only when the sprite changes. */
  private restartTimer(): void {
    this.stopTimer();
    if (!this.enabled || !this.animations) return;
    const active = this.phase === "generating" || this.phase === "tool";
    if (!active && !this.mascotOn) return;
    this.timer = setInterval(() => {
      this.frame++;
      const key = this.mascotOn ? this.mascot.key(Date.now(), this.frame) : String(this.frame);
      if (key === this.lastKey) return;
      this.lastKey = key;
      this.tui?.requestRender();
    }, 240);
    this.timer.unref?.();
  }
  private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  refreshSession(ctx: ExtensionContext): void {
    const manager = ctx.sessionManager as { getSessionId?: () => string; getSessionName?: () => string | undefined } | undefined;
    const next = sessionDisplayName(manager?.getSessionName?.(), manager?.getSessionId?.());
    if (next === this.session) return;
    this.session = next;
    if (this.enabled) this.tui?.requestRender();
  }
  enable(ctx: ExtensionContext): boolean {
    if (!ctx.hasUI || ctx.mode !== "tui") return false;
    if (this.enabled) return true;
    try {
      const previous = ctx.ui.getEditorComponent();
      const draft = ctx.ui.getEditorText();
      if (ctx.cwd) this.cwd = ctx.cwd;
      const manager = ctx.sessionManager as { getSessionId?: () => string; getSessionName?: () => string | undefined } | undefined;
      this.session = sessionDisplayName(manager?.getSessionName?.(), manager?.getSessionId?.());
      const factory: EditorFactory = (tui, theme, keys) => {
        this.tui = tui;
        this.colors = ctx.ui.theme;
        const paint = (text: string) => ctx.ui.theme?.fg("accent", text) ?? theme.borderColor(text);
        return previous
          ? new ThemedEditor(previous(tui, theme, keys), theme, paint, this.decor)
          : new RoundedEditor(tui, theme, keys, paint, this.decor);
      };
      this.previous = previous;
      this.owner = factory;
      ctx.ui.setEditorComponent(factory);
      ctx.ui.setEditorText(draft);
      this.enabled = true;
      this.restartTimer();
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
    this.session = "";
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
