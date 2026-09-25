import { readFile, stat } from "node:fs/promises";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { sessionDisplayName } from "./composer.ts";
import { GOAL_ENTRY, GoalStore } from "./goals.ts";
import { cleanText } from "./status.ts";

export const RECENT_SESSIONS = 3;
/** Larger session files are listed without goal/plan details. */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

export interface RecentSession { path: string; title: string; modified: Date; messages: number; goal?: string; plan?: string }

export function ago(date: Date, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - date.getTime()) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 60 / 24)}d`;
}

/** Latest goal and plan title recorded by pi-jar in a session file's JSONL. */
export function sessionWorkflow(jsonl: string): { goal?: string; plan?: string } {
  const entries: unknown[] = [];
  let plan: string | undefined;
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"pi-jar.')) continue;
    let entry: { type?: string; customType?: string; data?: { title?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "custom") continue;
    if (entry.customType === GOAL_ENTRY) entries.push(entry);
    else if (entry.customType === "pi-jar.plan" && typeof entry.data?.title === "string" && entry.data.title.trim()) plan = cleanText(entry.data.title, 60);
  }
  const goals = new GoalStore(() => {});
  goals.restore(entries);
  const goal = goals.current();
  return { ...(goal && goal.status !== "dropped" ? { goal: cleanText(goal.text, 60) + (goal.status === "complete" ? " ✔" : goal.status === "paused" ? " (paused)" : "") } : {}),
    ...(plan ? { plan } : {}) };
}

/** Most recent sessions for the project other than the current one, with their goal and plan. */
export async function recentSessions(sessions: readonly SessionInfo[], current: string | undefined, limit = RECENT_SESSIONS,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"), size: (path: string) => Promise<number> = async (path) => (await stat(path)).size): Promise<RecentSession[]> {
  const picked = [...sessions].filter((session) => session.path !== current && session.messageCount > 0)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime()).slice(0, limit);
  return Promise.all(picked.map(async (session) => {
    const title = session.name ? cleanText(session.name, 60) : cleanText(session.firstMessage || sessionDisplayName(undefined, session.id), 60);
    let workflow: { goal?: string; plan?: string } = {};
    try { if (await size(session.path) <= MAX_SCAN_BYTES) workflow = sessionWorkflow(await read(session.path)); }
    catch { /* unreadable session: show it without details */ }
    return { path: session.path, title, modified: session.modified, messages: session.messageCount, ...workflow };
  }));
}
