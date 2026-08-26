import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { randomBytes } from "node:crypto";

const UPLOAD_DIR = join(process.cwd(), "uploads");
const MAX_DIR_SIZE_MB = 500;

function ensureDir() {
  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });
}

function dirSizeMB(): number {
  let bytes = 0;
  for (const entry of readdirSync(UPLOAD_DIR)) {
    const stat = statSync(join(UPLOAD_DIR, entry));
    if (stat.isFile()) bytes += stat.size;
  }
  return bytes / (1024 * 1024);
}

function pruneOldest(keepBytes: number) {
  const files = readdirSync(UPLOAD_DIR)
    .map((name) => ({ name, stat: statSync(join(UPLOAD_DIR, name)) }))
    .filter((f) => f.stat.isFile())
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  let totalBytes = files.reduce((sum, f) => sum + f.stat.size, 0);
  for (const file of files) {
    if (totalBytes <= keepBytes) break;
    unlinkSync(join(UPLOAD_DIR, file.name));
    totalBytes -= file.stat.size;
  }
}

export function saveImage(buffer: Buffer, ext: string): string {
  ensureDir();
  const safeExt = (ext || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  const filename = `${Date.now()}-${randomBytes(6).toString("hex")}.${safeExt}`;
  writeFileSync(join(UPLOAD_DIR, filename), buffer);
  if (dirSizeMB() > MAX_DIR_SIZE_MB) pruneOldest(MAX_DIR_SIZE_MB * 0.75 * 1024 * 1024);
  return filename;
}

export function isLocalImage(url: string): boolean {
  return /^[a-f0-9]{13}-[a-f0-12]{12}\.(png|jpe?g|webp|gif)$/i.test(url);
}

export function localImagePath(filename: string): string {
  return join(UPLOAD_DIR, filename);
}

export function localToAttachmentUrl(filename: string): string {
  return `attachment://${filename}`;
}
