import type { RoleState } from "./roles.ts";

const FRAMES: Record<RoleState, readonly string[]> = {
  idle: ["◇"],
  thinking: ["◈", "◆"],
  working: ["◐", "◓", "◑", "◒"],
  waiting: ["◇"],
  reviewing: ["◔", "◑", "◕", "●"],
  done: ["✓"],
  failed: ["×"]
};

export function roleFrame(state: RoleState, frame: number, animations = true): string {
  const frames = FRAMES[state];
  if (!animations || frames.length === 1) {
    return frames[0] ?? "◇";
  }
  return frames[frame % frames.length] ?? frames[0] ?? "◇";
}

export const WORKING_FRAMES = ["◇", "◆", "◇", "◈"] as const;
/** Pixel-fire tick for the welcome flame; frozen when motion is disabled. */
export const WELCOME_INTERVAL_MS = 90;
