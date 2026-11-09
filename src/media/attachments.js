import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";

const LIB_CACHE = path.resolve("lib/cache");
if (!fs.existsSync(LIB_CACHE)) fs.mkdirSync(LIB_CACHE, { recursive: true });

/**
 * Checks if a buffer contains valid UTF-8 text without binary null bytes.
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function isTextBuffer(buf) {
  if (!buf || buf.length === 0) return true;
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return false; // Null byte indicates compiled binary
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, len));
    return true;
  } catch {
    return false;
  }
}

const EXTENSION_MIME_MAP = {
  // Images
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
  ".heif": "image/heif", ".bmp": "image/bmp", ".svg": "image/svg+xml",
  // Audio
  ".mp3": "audio/mp3", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".flac": "audio/flac", ".aac": "audio/aac", ".m4a": "audio/x-m4a",
  // Video
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".avi": "video/x-msvideo", ".mkv": "video/x-matroska",
  // Documents & Data
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".md": "text/markdown", ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html", ".htm": "text/html",
  ".css": "text/css",
  ".xml": "text/xml",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
  ".ts": "text/javascript", ".tsx": "text/javascript", ".jsx": "text/javascript",
  ".py": "text/x-python",
};

/**
 * Resolves a suitable MIME type for Gemini API.
 * @param {string} filename
 * @param {string|null} contentType - Discord provided content type
 * @param {Buffer} buffer - Downloaded file buffer
 * @returns {{ mimeType: string, isText: boolean } | null} Returns null if unsupported binary
 */
export function resolveAttachmentMime(filename, contentType, buffer) {
  const ext = "." + (filename.split(".").pop() || "").toLowerCase();
  const rawMime = contentType ? contentType.split(";")[0].trim().toLowerCase() : "";

  // 1. Direct media types
  if (rawMime.startsWith("image/") || rawMime.startsWith("audio/") || rawMime.startsWith("video/") || rawMime === "application/pdf") {
    return { mimeType: rawMime, isText: false };
  }

  // 2. Known extension media mapping
  if (EXTENSION_MIME_MAP[ext] && !EXTENSION_MIME_MAP[ext].startsWith("text/") && EXTENSION_MIME_MAP[ext] !== "application/json") {
    return { mimeType: EXTENSION_MIME_MAP[ext], isText: false };
  }

  // 3. Known text/code extension mapping
  if (EXTENSION_MIME_MAP[ext]) {
    return { mimeType: EXTENSION_MIME_MAP[ext], isText: true };
  }

  // 4. Universal text/code fallback check: if buffer is UTF-8 text, accept as text/plain!
  if (rawMime.startsWith("text/") || isTextBuffer(buffer)) {
    return { mimeType: rawMime.startsWith("text/") ? rawMime : "text/plain", isText: true };
  }

  // 5. Unsupported binary file (compiled executables, archives, etc.)
  return null;
}

/**
 * Downloads and caches attachments dynamically without requiring an exhaustive extension whitelist.
 * Code, text, configs, audio, video, images, and PDFs are all accepted.
 * Unsupported binaries (.exe, .zip, etc.) are caught and flagged gracefully.
 *
 * @param {Collection<string, import("discord.js").Attachment>} attachments
 * @returns {Promise<Array<{ filepath: string|null, mimeType: string, filename: string, isUnsupported?: boolean }>>}
 */
export async function cacheAttachments(attachments) {
  const cachedFiles = [];

  for (const att of attachments.values()) {
    // 20MB safety limit to avoid memory exhaustion
    if (att.size && att.size > 20 * 1024 * 1024) {
      logger.warn(`[Attachment] ${att.name} exceeds 20MB limit (${(att.size / 1024 / 1024).toFixed(1)}MB), skipping.`);
      cachedFiles.push({
        filepath: null,
        mimeType: "unsupported/oversized",
        filename: att.name,
        isUnsupported: true
      });
      continue;
    }

    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`Download failed with status ${res.status}`);
      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);

      const resolved = resolveAttachmentMime(att.name, att.contentType, buffer);

      if (!resolved) {
        logger.warn(`[Attachment] Skipping unsupported binary attachment: ${att.name}`);
        cachedFiles.push({
          filepath: null,
          mimeType: "unsupported/binary",
          filename: att.name,
          isUnsupported: true
        });
        continue;
      }

      const ext = path.extname(att.name) || (resolved.isText ? ".txt" : ".bin");
      const safeFilename = `cache_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;
      const filepath = path.join(LIB_CACHE, safeFilename);

      fs.writeFileSync(filepath, buffer);
      logger.log(`[Attachment] Cached "${att.name}" as ${resolved.mimeType} (${(buffer.length / 1024).toFixed(1)}KB)`);

      cachedFiles.push({
        filepath,
        mimeType: resolved.mimeType,
        filename: att.name,
        isUnsupported: false
      });
    } catch (err) {
      logger.error(`[Attachment] Failed to process ${att.name}:`, err.message);
    }
  }

  return cachedFiles;
}
