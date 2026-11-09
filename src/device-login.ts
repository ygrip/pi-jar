import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getNativeClipboard, Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { formatLoginLink } from "./login-browser.ts";
import { popup } from "./popup.ts";
import { cleanText } from "./status.ts";

/** Keep device authorization available until the provider completes or the user cancels. */
export function showDeviceCodeDialog(
  ctx: ExtensionContext,
  verificationUri: string,
  userCode: string,
  openBrowser: (url: string) => void,
  cancelLogin: () => void,
  signal: AbortSignal,
  actions: { openBrowser?: boolean; copyCode?: boolean } = {},
): () => void {
  let finish: (() => void) | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    finish?.();
  };
  const cancel = () => {
    cancelLogin();
    close();
  };
  if (signal.aborted) return close;
  signal.addEventListener("abort", close, { once: true });

  void popup<void>(ctx, (tui, theme, _keys, done) => {
    finish = () => done();
    if (closed) finish();
    let openRow = -1;
    let copyRow = -1;
    let cancelRow = -1;
    let copyStatus = "";
    const copyCode = () => {
      const unavailable = () => {
        copyStatus = "Clipboard unavailable; select the code above to copy it manually.";
        tui.requestRender();
      };
      try {
        const clipboard = getNativeClipboard();
        if (!clipboard?.setText || !userCode || userCode.length > 256 || /[\u0000-\u001f\u007f]/.test(userCode)) {
          unavailable();
          return;
        }
        void clipboard.setText(userCode).then(() => {
          copyStatus = "Code copied.";
          tui.requestRender();
        }).catch(unavailable);
      } catch {
        unavailable();
      }
    };
    return {
      invalidate() {},
      handleInput(data: string) {
        if ((data === "o" || data === "O") && actions.openBrowser !== false) openBrowser(verificationUri);
        else if ((data === "c" || data === "C") && actions.copyCode !== false) copyCode();
        else if (data === "q" || data === "Q" || matchesKey(data, Key.escape)) cancel();
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type !== "click" || event.button !== "left") return;
        if (event.y === openRow && actions.openBrowser !== false) openBrowser(verificationUri);
        else if (event.y === copyRow && actions.copyCode !== false) copyCode();
        else if (event.y === cancelRow) cancel();
        else return;
        tui.requestRender();
        return { handled: true };
      },
      render(width: number) {
        const fit = (line: string) => truncateToWidth(line, width);
        const link = formatLoginLink(verificationUri, "Open verification page");
        const lines = [
          fit(theme.fg("accent", "╭─ Sign in with device code ─")),
          fit(theme.fg("muted", "Visit this page and enter the code:")),
          ...wrapTextWithAnsi(link, Math.max(1, width)),
          fit(theme.fg("warning", `Code: ${cleanText(userCode, 256)}`)),
          fit(theme.fg("dim", "Waiting for approval.")),
        ];
        openRow = -1;
        if (actions.openBrowser !== false) {
          openRow = lines.length;
          lines.push(fit(theme.fg("accent", "[o] Open page")));
        }
        copyRow = -1;
        if (actions.copyCode !== false) {
          copyRow = lines.length;
          lines.push(fit(theme.fg("accent", "[c] Copy code")));
        }
        if (copyStatus) lines.push(fit(theme.fg("dim", copyStatus)));
        cancelRow = lines.length;
        lines.push(fit(theme.fg("dim", "[Esc/q] Cancel login")));
        return lines;
      },
    };
  }, { filter: false }).catch(error => {
    ctx.ui.notify(`Device login dialog failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    cancel();
  });
  return close;
}
