import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";

const LIB_IMG = path.resolve("lib/img");
const LIB_CUSTOM_IMG = path.resolve("lib/custom_img");
if (!fs.existsSync(LIB_CUSTOM_IMG)) fs.mkdirSync(LIB_CUSTOM_IMG, { recursive: true });

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif"]);

export function validateImageBuffer(buffer) {
  if (!buffer || buffer.length < 4) return false;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return true;
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return true;
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return true;
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer.length >= 12 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return true;
  if (buffer[0] === 0x42 && buffer[1] === 0x4D) return true;
  if (buffer.length >= 12 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return true;
  return false;
}

export function getSavedImagesList() {
  try {
    const files = fs.readdirSync(LIB_IMG).filter(f => {
      const ext = path.extname(f).toLowerCase();
      return IMAGE_EXTENSIONS.has(ext);
    });

    try {
      const infoFile = path.join(LIB_IMG, "img_info.json");
      if (fs.existsSync(infoFile)) {
        let infoData = JSON.parse(fs.readFileSync(infoFile, "utf8"));
        let changed = false;
        const validSet = new Set(files);
        for (const key of Object.keys(infoData)) {
          if (!validSet.has(key)) {
            logger.debug(`[Cache] Auto-deleting dead image info entry: ${key}`);
            delete infoData[key];
            changed = true;
          }
        }
        if (changed) fs.writeFileSync(infoFile, JSON.stringify(infoData, null, 2), "utf8");
      }
    } catch (e) {
      logger.debug("Failed to auto-clean img_info.json:", e.message);
    }
    return files;
  } catch (err) {
    logger.error("Failed to read img directory:", err.message);
    return [];
  }
}

export function getSavedImage(name) {
  const files = getSavedImagesList();
  const match = files.find(f => f.toLowerCase().startsWith(name.toLowerCase()));
  if (match) return path.join(LIB_IMG, match);
  return null;
}

async function searchImageFallback(query) {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query + " images")}`, {
       headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }
    });
    const text = await res.text();
    const match = text.match(/<img[^>]+src="(\/\/external-content\.duckduckgo\.com\/iu\/\?u=[^"]+)"/i);
    if (match && match[1]) {
       let u = match[1];
       if (u.includes("u=")) {
          return decodeURIComponent(u.split('u=')[1].split('&')[0]);
       }
    }
  } catch (e) {
    logger.debug("[SearchImg] DDG fallback failed:", e.message);
  }
  return null;
}

export async function searchGoogleImage(query) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;
  if (!apiKey || !cx) {
    logger.debug("[SearchImg] No Google API keys found. Falling back to DDG scrape.");
    return await searchImageFallback(query);
  }
  try {
    const res = await fetch(`https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&searchType=image&num=1`);
    if (!res.ok) throw new Error("Google Custom Search API returned an error: " + res.status);
    const data = await res.json();
    if (data.items && data.items.length > 0) return data.items[0].link;
  } catch (err) {
    logger.error("[SearchImg] Google API failed:", err.message);
    logger.debug("[SearchImg] Falling back to DDG after Google API failure.");
    return await searchImageFallback(query);
  }
  return null;
}

export async function downloadImageToLib(url, customName = null, isCustomUserImg = false) {
  const targetLib = isCustomUserImg ? LIB_CUSTOM_IMG : LIB_IMG;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} — server returned an error`);

  const contentType = res.headers.get("content-type") || "";
  const mime = contentType.split(";")[0].trim().toLowerCase();

  const validImageMimes = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/heic", "image/heif", "image/bmp"]);
  if (!validImageMimes.has(mime)) throw new Error(`URL returned non-image content-type: "${mime}".`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 1024) throw new Error(`Image too small (${buffer.length} bytes) — likely a placeholder.`);
  if (buffer.length > 25 * 1024 * 1024) throw new Error(`Image too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
  if (!validateImageBuffer(buffer)) throw new Error(`File does not have valid image headers (magic bytes mismatch).`);

  const extMap = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg",
    "image/gif": ".gif", "image/webp": ".webp", "image/heic": ".heic",
    "image/heif": ".heif", "image/bmp": ".bmp",
  };
  const ext = extMap[mime] || ".png";
  const nameBase = customName
    ? customName.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "").substring(0, 100) || `img_${Date.now()}`
    : `img_${Date.now()}`;
  const filename = `${nameBase}${ext}`;
  const filepath = path.join(targetLib, filename);

  fs.writeFileSync(filepath, buffer);
  logger.log(`[SaveImg] Validated & saved: ${filename} (${(buffer.length / 1024).toFixed(1)}KB, ${mime})`);
  
  try {
    const infoFile = path.join(targetLib, "img_info.json");
    let infoData = {};
    if (fs.existsSync(infoFile)) infoData = JSON.parse(fs.readFileSync(infoFile, "utf8"));
    infoData[filename] = {
      sourceUrl: url, downloadedAt: new Date().toISOString(), sizeBytes: buffer.length, mimeType: mime
    };
    fs.writeFileSync(infoFile, JSON.stringify(infoData, null, 2), "utf8");
  } catch (err) {
    logger.error("Failed to update img_info.json:", err.message);
  }
  return { filepath, filename };
}
