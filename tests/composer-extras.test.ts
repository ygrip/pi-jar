import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { formatBytes, imageChip, imageInfo, imagePaths, imageSize } from "../src/attachments.ts";
import { roundedInput } from "../src/composer.ts";
import { collectPrompts, openPromptSearch } from "../src/prompt-search.ts";

const png = (width: number, height: number) => {
  const buffer = Buffer.alloc(33);
  buffer.writeUInt32BE(0x89504e47, 0); buffer.writeUInt32BE(0x0d0a1a0a, 4);
  buffer.writeUInt32BE(13, 8); buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20);
  return buffer;
};

test("image headers give dimensions for PNG, GIF, JPEG and WebP", () => {
  assert.deepEqual(imageSize(png(1280, 720)), { width: 1280, height: 720, format: "PNG" });
  const gif = Buffer.from("GIF89a\x40\x01\xf0\x00", "latin1");
  assert.deepEqual(imageSize(gif), { width: 320, height: 240, format: "GIF" });
  // SOI, an APP0 segment, then SOF0 with height 480 and width 640.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpeg), { width: 640, height: 480, format: "JPEG" });
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii"); webp.write("WEBP", 8, "ascii"); webp.write("VP8X", 12, "ascii");
  webp.writeUIntLE(799, 24, 3); webp.writeUIntLE(599, 27, 3);
  assert.deepEqual(imageSize(webp), { width: 800, height: 600, format: "WebP" });
  assert.equal(imageSize(Buffer.from("not an image")), undefined);
  assert.equal(formatBytes(2048), "2 KB");
});

test("pasted image paths in the draft become chips below the composer", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-jar-img-"));
  try {
    const pasted = join(root, "pi-clipboard-1234.png");
    const named = join(root, "my shot.png");
    writeFileSync(pasted, png(100, 50));
    writeFileSync(named, png(10, 10));
    const draft = `look at ${pasted} and "${named}" plus missing.png`;
    assert.deepEqual(imagePaths(draft, root), [pasted, named]);
    assert.equal(imageChip(imageInfo(pasted)!), "▣ pasted png · 100×50 · 33 B");
    assert.equal(imageChip(imageInfo(named)!), "▣ my shot.png · 10×10 · 33 B");
    const theme = { borderColor: (text: string) => text } as never;
    const lines = roundedInput(["─".repeat(38), " hello", "─".repeat(38), "  autocomplete"], 40, false, theme, undefined, "pi", "", { below: "▣ chip" });
    const plain = lines.map(stripTerminalSequences);
    assert.match(plain[2]!, /^╰/);
    assert.equal(plain[3], " ▣ chip", "chips sit directly below the frame");
    assert.equal(plain[4], "   autocomplete", "autocomplete stays below");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prompt history is newest first, deduplicated, and searchable", async () => {
  const entries = [
    { type: "message", message: { role: "user", content: "fix the login bug" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "add tests for login" }] } },
    { type: "message", message: { role: "user", content: "fix   the login bug" } }
  ];
  const prompts = collectPrompts(entries, [{ firstMessage: "set up CI", modified: new Date(0) }, { firstMessage: "add tests for login" }]);
  assert.deepEqual(prompts.map((item) => [item.text, item.source]), [
    ["fix   the login bug", "this session"], ["add tests for login", "this session"], ["set up CI", "earlier session"]
  ]);
  let component: any;
  const ctx = { hasUI: true, mode: "tui", ui: { notify() {}, custom(factory: Function) {
    return new Promise((resolve) => { component = factory({ requestRender() {} }, { fg: (_c: string, t: string) => t }, {}, resolve); });
  } } };
  const picked = openPromptSearch(ctx as never, prompts);
  for (const key of "ci") component.handleInput(key);
  const screen = component.render(60).map(stripTerminalSequences).join("\n");
  assert.match(screen, /› ci/);
  assert.match(screen, /❯ set up CI · earlier/);
  component.handleInput("\r");
  assert.equal(await picked, "set up CI");
});
