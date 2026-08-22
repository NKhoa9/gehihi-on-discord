import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import { loadConfig } from "../utils/config.js";

const channelHistory = new Map();

export function getHistory(channelId) {
  if (!channelHistory.has(channelId)) {
    channelHistory.set(channelId, []);
  }
  return channelHistory.get(channelId);
}

export function pushHistory(channelId, role, text, attachments = []) {
  const history = getHistory(channelId);
  history.push({ role, text, attachments });
  
  const cfg = loadConfig();
  const maxHistory = cfg.max_history || parseInt(process.env.MAX_HISTORY || "30", 10);
  
  while (history.length > maxHistory) {
    const shifted = history.shift();
    if (shifted && shifted.attachments && shifted.attachments.length > 0) {
      for (const att of shifted.attachments) {
        try {
          if (fs.existsSync(att.filepath)) {
            fs.unlinkSync(att.filepath);
            logger.log(`[Cache] Garbage collected old attachment: ${path.basename(att.filepath)}`);
          }
        } catch (err) {
          logger.warn(`[Cache] Failed to delete ${att.filepath}:`, err.message);
        }
      }
    }
  }
}

export function clearHistory(channelId) {
  const history = channelHistory.get(channelId);
  if (history) {
    for (const entry of history) {
      if (entry.attachments) {
        for (const att of entry.attachments) {
          try {
            if (fs.existsSync(att.filepath)) fs.unlinkSync(att.filepath);
          } catch (e) {}
        }
      }
    }
  }
  channelHistory.delete(channelId);
}
