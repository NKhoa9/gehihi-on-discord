import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";

const LIB_CACHE = path.resolve("lib/cache");

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"
]);

const SUPPORTED_DOC_TYPES = new Set([
  "application/pdf", "text/plain", "text/html", "text/css", "text/javascript",
  "text/csv", "text/markdown", "text/x-python", "application/json", "text/xml",
  "audio/wav", "audio/mp3", "audio/mpeg", "audio/ogg",
  "video/mp4", "video/mpeg", "video/webm"
]);

export function isSupportedAttachment(contentType) {
  if (!contentType) return false;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  return SUPPORTED_IMAGE_TYPES.has(mime) || SUPPORTED_DOC_TYPES.has(mime);
}

async function downloadAttachment(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer);
}

export async function cacheAttachments(attachments) {
  const cachedFiles = [];

  for (const att of attachments.values()) {
    if (!isSupportedAttachment(att.contentType)) continue;

    try {
      const buffer = await downloadAttachment(att.url);
      const mimeType = att.contentType.split(";")[0].trim().toLowerCase();
      const ext = "." + (att.name.split('.').pop() || "bin");
      const filename = `cache_${Date.now()}_${Math.random().toString(36).substring(2,8)}${ext}`;
      const filepath = path.join(LIB_CACHE, filename);
      
      fs.writeFileSync(filepath, buffer);
      cachedFiles.push({ filepath, mimeType });
    } catch (err) {
      logger.error(`Failed to cache attachment ${att.name}:`, err.message);
    }
  }

  return cachedFiles;
}
