import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import { loadConfig } from "../utils/config.js";

const channelHistory = new Map();
const initializedChannels = new Set();
const initializingPromises = new Map();

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
 * Returns whether a channel has already had its initial history fetched or cleared.
 * @param {string} channelId
 * @returns {boolean}
 */
export function isHistoryInitialized(channelId) {
  return initializedChannels.has(channelId);
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
 * Extracts reactions from a Discord Message's reaction cache.
 * @param {import("discord.js").Message} message
 * @returns {Array<{ emoji: string, count: number }>}
 */
export function extractMessageReactions(message) {
  const reactions = [];
  if (message?.reactions?.cache?.size > 0) {
    for (const [, rx] of message.reactions.cache) {
      const emojiStr = rx.emoji.id
        ? `<${rx.emoji.animated ? "a" : ""}:${rx.emoji.name}:${rx.emoji.id}>`
        : rx.emoji.name;
      reactions.push({ emoji: emojiStr, count: rx.count });
    }
  }
  return reactions;
}

/**
 * Cleans Discord message content by stripping bot mention and normalizing custom emojis.
 * @param {string} rawContent
 * @param {string|null} botUserId
 * @returns {string}
 */
export function cleanMessageContent(rawContent, botUserId = null) {
  let text = rawContent || "";
  if (botUserId) {
    text = text.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
  }
  text = text.replace(/<a?:(\w+):\d+>/g, ":$1:");
  return text.trim();
}

function summarizeEmbeds(embeds) {
  if (!embeds || embeds.length === 0) return "";
  const parts = [];
  for (const emb of embeds) {
    const segs = [];
    if (emb.title) segs.push(emb.title);
    if (emb.description) segs.push(emb.description.substring(0, 400));
    if (segs.length > 0) parts.push(`[Embed: ${segs.join(" — ")}]`);
  }
  return parts.join(" ");
}

/**
 * Formats a Discord user message into the standard AI history format.
 * @param {import("discord.js").Message} message
 * @param {string|null} botUserId
 * @param {import("discord.js").Message|null} repliedMsg
 * @param {string} fallbackText
 * @returns {string}
 */
export function formatUserMessageText(message, botUserId = null, repliedMsg = null, fallbackText = "hey") {
  const userName = message.author?.displayName || message.author?.username || "Unknown";
  const userId = message.author?.id || "0";
  const botTag = message.author?.bot ? " [BOT]" : "";
  const timestamp = message.createdAt ? message.createdAt.toISOString() : new Date().toISOString();

  let historyPrefix = `[${timestamp}] ${userName}${botTag} (ID: ${userId})`;

  if (repliedMsg) {
    const replyAuthor = repliedMsg.author?.displayName || repliedMsg.author?.username || "Unknown";
    const replyAuthorId = repliedMsg.author?.id || "0";
    let replyContent = (repliedMsg.content || "").substring(0, 100);
    replyContent = replyContent.replace(/<a?:(\w+):\d+>/g, ":$1:");
    const rxList = extractMessageReactions(repliedMsg);
    const repliedRx = formatReactionsString(rxList);
    historyPrefix += ` [replying to ${replyAuthor} (ID: ${replyAuthorId})${repliedRx}: "${replyContent}"]`;
  }

  let body = cleanMessageContent(message.content, botUserId);
  if (!body && message.embeds?.length > 0) {
    body = summarizeEmbeds(message.embeds);
  }
  if (!body && message.stickers?.size > 0) {
    body = `[Sticker: ${[...message.stickers.values()].map(s => s.name).join(", ")}]`;
  }
  if (!body) body = fallbackText;

  return `${historyPrefix}: ${body}`;
}

function formatFetchedBotText(message) {
  let text = (message.content || "").replace(/\n-#\s+.*$/s, "").trim();
  if (!text && message.embeds?.length > 0) {
    text = summarizeEmbeds(message.embeds);
  }
  if (!text && message.attachments?.size > 0) {
    const names = [...message.attachments.values()].map(a => a.name || "file");
    text = `[Sent attachment: ${names.join(", ")}]`;
  }
  return text;
}

/**
 * Fetches prior messages in a channel before the bot begins collecting new messages,
 * populating channel history for immediate context. Safe against concurrent calls.
 *
 * @param {import("discord.js").TextBasedChannel} channel
 * @param {string|null} botUserId
 * @param {string|null} excludeMessageId - Usually the incoming message ID that triggered init
 * @returns {Promise<number>} Number of historical entries added
 */
export async function ensureChannelHistoryFetched(channel, botUserId = null, excludeMessageId = null) {
  if (!channel?.id) return 0;
  const channelId = channel.id;

  if (initializedChannels.has(channelId)) return 0;
  if (initializingPromises.has(channelId)) {
    return await initializingPromises.get(channelId);
  }

  const task = (async () => {
    try {
      const cfg = loadConfig();
      const maxHistory = cfg.max_history || parseInt(process.env.MAX_HISTORY || "30", 10);
      const rawLimit = cfg.history_fetch_limit !== undefined ? Number(cfg.history_fetch_limit) : 20;
      const fetchLimit = Number.isFinite(rawLimit)
        ? Math.max(0, Math.min(100, Math.min(rawLimit, maxHistory)))
        : Math.min(20, maxHistory);

      if (fetchLimit <= 0 || !channel.messages?.fetch) {
        initializedChannels.add(channelId);
        return 0;
      }

      const fetchOpts = excludeMessageId
        ? { limit: fetchLimit, before: excludeMessageId }
        : { limit: fetchLimit };

      const fetched = await channel.messages.fetch(fetchOpts);
      const ordered = [...fetched.values()]
        .filter(m => m.id !== excludeMessageId)
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

      let added = 0;
      const history = getHistory(channelId);

      for (const msg of ordered) {
        const reactions = extractMessageReactions(msg);

        if (botUserId && msg.author?.id === botUserId) {
          const botText = formatFetchedBotText(msg);
          if (!botText) continue;

          const lastEntry = history[history.length - 1];
          if (lastEntry && lastEntry.role === "model") {
            lastEntry.text = `${lastEntry.text}\n${botText}`;
            lastEntry.messageId = msg.id;
            if (reactions.length > 0) lastEntry.reactions = reactions;
          } else {
            pushHistory(channelId, "model", botText, [], msg.id, reactions);
            added++;
          }
          continue;
        }

        const hasContent = Boolean(msg.content?.trim() || msg.embeds?.length || msg.attachments?.size || msg.stickers?.size);
        if (!hasContent) continue;

        let repliedMsg = null;
        if (msg.reference?.messageId) {
          repliedMsg = fetched.get(msg.reference.messageId) || channel.messages.cache.get(msg.reference.messageId) || null;
        }

        let formatted = formatUserMessageText(msg, botUserId, repliedMsg, "");
        if (msg.attachments?.size > 0) {
          const attDesc = [...msg.attachments.values()]
            .map(a => `${a.name || "file"}${a.contentType ? ` (${a.contentType.split(";")[0]})` : ""}`)
            .join(", ");
          formatted = formatted.endsWith(": ")
            ? `${formatted}[Previously attached: ${attDesc}]`
            : `${formatted}\n[Previously attached: ${attDesc}]`;
        }

        if (formatted.endsWith(": ")) continue;
        pushHistory(channelId, "user", formatted, [], msg.id, reactions);
        added++;
      }

      initializedChannels.add(channelId);
      logger.log(`[History] Fetched ${added} prior message(s) for #${channel.name || channelId} before collecting new messages`);
      return added;
    } catch (err) {
      initializedChannels.add(channelId);
      logger.warn(`[History] Failed to pre-fetch messages for channel ${channelId}:`, err.message);
      return 0;
    } finally {
      initializingPromises.delete(channelId);
    }
  })();

  initializingPromises.set(channelId, task);
  return await task;
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
  if (messageId && history.some(e => e.messageId === messageId)) {
    return;
  }
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
  // Keep channel marked initialized so /clear gives a true fresh start without re-fetching old messages
  initializedChannels.add(channelId);
}
