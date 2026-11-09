import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import { loadConfig } from "../utils/config.js";

const channelHistory = new Map();

/**
 * Returns the history array for a given channel ID.
 * @param {string} channelId
 * @returns {Array<{ role: string, text: string, attachments: Array, messageId?: string|null, reactions?: Array<{ emoji: string, count: number }> }>}
 */
export function getHistory(channelId) {
  if (!channelHistory.has(channelId)) {
    channelHistory.set(channelId, []);
  }
  return channelHistory.get(channelId);
}

/**
 * Formats a reaction array into a readable string for the AI context.
 * e.g. " [reactions: 👍 x2, ❤️ x1]"
 * @param {Array<{ emoji: string, count: number }>} reactions
 * @returns {string}
 */
export function formatReactionsString(reactions) {
  if (!reactions || reactions.length === 0) return "";
  const parts = reactions.map(r => `${r.emoji} x${r.count}`);
  return ` [reactions: ${parts.join(", ")}]`;
}

/**
 * Pushes a new message entry to channel history.
 * @param {string} channelId
 * @param {string} role - "user" or "model"
 * @param {string} text - Message text
 * @param {Array} attachments - Cached attachment descriptors
 * @param {string|null} messageId - Discord message ID
 * @param {Array<{ emoji: string, count: number }>} reactions - Initial reactions
 */
export function pushHistory(channelId, role, text, attachments = [], messageId = null, reactions = []) {
  const history = getHistory(channelId);
  history.push({ role, text, attachments, messageId, reactions });

  const cfg = loadConfig();
  const maxHistory = cfg.max_history || parseInt(process.env.MAX_HISTORY || "30", 10);

  while (history.length > maxHistory) {
    const shifted = history.shift();
    if (shifted && shifted.attachments && shifted.attachments.length > 0) {
      for (const att of shifted.attachments) {
        try {
          if (att.filepath && fs.existsSync(att.filepath)) {
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

/**
 * Updates the reactions for a specific message in the channel history.
 * @param {string} channelId
 * @param {string} messageId
 * @param {Array<{ emoji: string, count: number }>} reactions
 */
export function updateHistoryReactions(channelId, messageId, reactions) {
  if (!channelId || !messageId) return;
  const history = getHistory(channelId);
  const entry = history.find(e => e.messageId === messageId);
  if (entry) {
    entry.reactions = reactions;
    logger.debug(`[History] Updated reactions for message ${messageId}: ${formatReactionsString(reactions)}`);
  }
}

export function clearHistory(channelId) {
  const history = channelHistory.get(channelId);
  if (history) {
    for (const entry of history) {
      if (entry.attachments) {
        for (const att of entry.attachments) {
          try {
            if (att.filepath && fs.existsSync(att.filepath)) fs.unlinkSync(att.filepath);
          } catch (e) {}
        }
      }
    }
  }
  channelHistory.delete(channelId);
}
