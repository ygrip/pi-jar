import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FOOTER_SETTINGS, loadFooterSettings, saveFooterSettings } from "../src/footer-settings.ts";

test("footer settings merge validated preferences and save atomically outside the home directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jar-footer-"));
  try {
    assert.deepEqual(loadFooterSettings(dir), DEFAULT_FOOTER_SETTINGS);
    const file = join(dir, "pi-jar-footer.json");
    writeFileSync(file, '{"model":false,"cwd":"off","unknown":false}');
    assert.deepEqual(loadFooterSettings(dir), { ...DEFAULT_FOOTER_SETTINGS, model: false });
    writeFileSync(file, "invalid JSON");
    assert.deepEqual(loadFooterSettings(dir), DEFAULT_FOOTER_SETTINGS);
    assert.equal(readFileSync(file, "utf8"), "invalid JSON"); // reads never overwrite corrupt data
    saveFooterSettings(dir, { ...DEFAULT_FOOTER_SETTINGS, cwd: false, sessionName: false });
    assert.deepEqual(loadFooterSettings(dir), { ...DEFAULT_FOOTER_SETTINGS, cwd: false, sessionName: false });
    assert.match(readFileSync(file, "utf8"), /"cwd": false/);
    assert.deepEqual(readdirSync(dir), ["pi-jar-footer.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
