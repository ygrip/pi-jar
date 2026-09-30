import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Directory a parent hands to a subagent so the child can report each file's content before its
 * first edit/write. The parent then adopts those baselines into its own `/diff` review.
 */
export const CHILD_BASELINE_ENV = "PI_JAR_BASELINE_DIR";

type BaselineRecord = { path: string; content: string | null };

/** Writer and reader must agree on the name: one JSON file per absolute path. */
const fileFor = (dir: string, absPath: string) => join(dir, createHash("sha1").update(absPath).digest("hex") + ".json");

/**
 * Store the pre-change content (`null` = file did not exist) once per absolute path. The first
 * write wins: the temp file is hard-linked into place, which fails instead of replacing an
 * existing baseline, so readers never see a partial or newer record. Throws on I/O failure.
 */
export function writeChildBaseline(dir: string, absPath: string, content: string | null): void {
  const target = fileFor(dir, absPath);
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  if (existsSync(target)) return;
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(temp, JSON.stringify({ path: absPath, content } satisfies BaselineRecord));
    linkSync(temp, target);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { rmSync(temp, { force: true }); }
}

/** The recorded baseline, or `undefined` when absent, unreadable or malformed. */
export function readChildBaseline(dir: string, absPath: string): string | null | undefined {
  let record: unknown;
  try { record = JSON.parse(readFileSync(fileFor(dir, absPath), "utf8")); }
  catch { return undefined; } // absent or corrupt: the parent simply does not adopt this file
  if (!record || typeof record !== "object") return undefined;
  const { path, content } = record as Partial<BaselineRecord>;
  if (path !== absPath || (content !== null && typeof content !== "string")) return undefined;
  return content;
}
