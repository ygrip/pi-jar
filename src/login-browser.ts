import { spawn } from "node:child_process";

/**
 * Mirror Pi's native browser login without invoking a shell. OAuth authorization
 * URLs can contain &, ?, and other shell metacharacters, so they must always be
 * passed as a single argument to the platform opener.
 */
export function loginBrowserCommand(url: string, platform = process.platform): [string, string[]] | undefined {
  if (/[\u0000-\u001f\u007f]/.test(url) || url !== url.trim()) return undefined;
  let target: URL;
  try { target = new URL(url); } catch { return undefined; }
  if (target.protocol !== "https:" && target.protocol !== "http:") return undefined;
  if (!target.hostname) return undefined;
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  return ["xdg-open", [url]];
}

/** Best effort only: the full authorization URL is always shown in the TUI. */
export function openLoginBrowser(url: string): void {
  const command = loginBrowserCommand(url);
  if (!command) return;
  try {
    spawn(command[0], command[1], { stdio: "ignore", detached: true, cwd: "/" })
      .on("error", () => { /* SSH, containers, or missing desktop openers are harmless */ })
      .unref();
  } catch { /* keep the manual URL and device-code fallback available */ }
}
