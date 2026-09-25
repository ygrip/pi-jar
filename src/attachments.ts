import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

export interface ImageInfo { path: string; name: string; bytes: number; width?: number; height?: number; format: string }

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const HEADER_BYTES = 64 * 1024;
const cache = new Map<string, { mtime: number; info: ImageInfo }>();

/** Width × height from an image header (PNG, GIF, JPEG, WebP), or undefined. */
export function imageSize(header: Buffer): { width: number; height: number; format: string } | undefined {
  if (header.length >= 24 && header.readUInt32BE(0) === 0x89504e47 && header.toString("ascii", 12, 16) === "IHDR") {
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20), format: "PNG" };
  }
  if (header.length >= 10 && header.toString("ascii", 0, 3) === "GIF") return { width: header.readUInt16LE(6), height: header.readUInt16LE(8), format: "GIF" };
  if (header.length >= 30 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") {
    const chunk = header.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + header.readUIntLE(24, 3), height: 1 + header.readUIntLE(27, 3), format: "WebP" };
    if (chunk === "VP8 ") return { width: header.readUInt16LE(26) & 0x3fff, height: header.readUInt16LE(28) & 0x3fff, format: "WebP" };
    if (chunk === "VP8L") {
      const bits = header.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: "WebP" };
    }
  }
  if (header.length >= 4 && header[0] === 0xff && header[1] === 0xd8) {
    let at = 2;
    while (at + 9 < header.length) {
      if (header[at] !== 0xff) { at++; continue; }
      const marker = header[at + 1]!;
      // Start-of-frame markers carry the dimensions (C4, C8 and CC are not frames).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: header.readUInt16BE(at + 7), height: header.readUInt16BE(at + 5), format: "JPEG" };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      at += 2 + header.readUInt16BE(at + 2);
    }
  }
  return undefined;
}

/** Image file paths mentioned in a draft (Pi pastes clipboard images as temp file paths). */
export function imagePaths(text: string, cwd = process.cwd()): string[] {
  const found = new Set<string>();
  const tokens = text.match(/"[^"\n]+"|'[^'\n]+'|(?:\\ |[^\s"'])+/g) ?? [];
  for (const raw of tokens) {
    const token = raw.replace(/^["']|["']$/g, "").replace(/\\ /g, " ").replace(/^@/, "");
    if (!IMAGE.test(token)) continue;
    const path = token.startsWith("~/") ? resolve(homedir(), token.slice(2)) : isAbsolute(token) ? token : resolve(cwd, token);
    if (existsSync(path)) found.add(path);
  }
  return [...found].slice(0, 8);
}

export function imageInfo(path: string): ImageInfo | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return undefined;
    const cached = cache.get(path);
    if (cached && cached.mtime === stat.mtimeMs) return cached.info;
    const header = Buffer.alloc(Math.min(HEADER_BYTES, stat.size));
    const fd = openSync(path, "r");
    try { readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
    const size = imageSize(header);
    const info: ImageInfo = { path, name: basename(path), bytes: stat.size, format: size?.format ?? (path.split(".").pop() ?? "").toUpperCase(),
      ...(size ? { width: size.width, height: size.height } : {}) };
    cache.set(path, { mtime: stat.mtimeMs, info });
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    return info;
  } catch { return undefined; }
}

export const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Short chip text: "▣ shot.png · 1280×720 · 240 KB". Temp clipboard names are shortened. */
export function imageChip(info: ImageInfo): string {
  const name = /^pi-clipboard-/.test(info.name) ? `pasted ${info.format.toLowerCase()}` : info.name;
  return `▣ ${name}${info.width ? ` · ${info.width}×${info.height}` : ""} · ${formatBytes(info.bytes)}`;
}
