import { logger } from "../utils/logger.js";

/**
 * Builds a prompt block describing the available custom emojis on this Discord server.
 * Limits to 50 emojis to prevent context window saturation.
 * @param {import("discord.js").Guild|null} guild
 * @returns {string}
 */
export function buildGuildEmojisBlock(guild) {
  if (!guild || !guild.emojis) return "";

  try {
    const availableEmojis = guild.emojis.cache.filter(e => e.available !== false);
    if (availableEmojis.size === 0) return "";

    const emojiList = [];
    let count = 0;
    for (const [_, emoji] of availableEmojis) {
      if (count >= 50) break;
      const tag = emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
      emojiList.push(`${tag} (:${emoji.name}:)`);
      count++;
    }

    if (emojiList.length === 0) return "";

    return `\n\n--- SERVER CUSTOM EMOJIS ---\nYou have access to the following custom emojis available on this server:\n${emojiList.join(" ")}\nYou are encouraged to acknowledge, react with, and use them naturally in your responses! You can write them as <:name:id> (or simply :name:) in messages, or inside [REACT: :name:]. Do NOT invent or hallucinate custom emojis that are not listed here.\n--- END SERVER CUSTOM EMOJIS ---`;
  } catch (err) {
    logger.warn("[Emojis] Failed to build guild emojis block:", err.message);
    return "";
  }
}

/**
 * Replaces standalone :emoji_name: in the text with Discord custom emoji format <:name:id> or <a:name:id>
 * @param {string} text
 * @param {import("discord.js").Guild|null} guild
 * @returns {string}
 */
export function resolveGuildEmojis(text, guild) {
  if (!guild || !guild.emojis || !text) return text;

  try {
    return text.replace(/(?<!<a?):([a-zA-Z0-9_]{2,32}):(?![\d]+>)/g, (match, name) => {
      const lower = name.toLowerCase();
      const emoji = guild.emojis.cache.find(e => e.name.toLowerCase() === lower && e.available !== false);
      if (emoji) {
        return emoji.animated ? `<a:${emoji.name}:${emoji.id}>` : `<:${emoji.name}:${emoji.id}>`;
      }
      return match;
    });
  } catch (err) {
    logger.warn("[Emojis] Error resolving guild emojis in text:", err.message);
    return text;
  }
}

/**
 * Resolves an emoji string for Discord reactions (message.react).
 * Supports standard Unicode emojis, <:name:id>, <a:name:id>, :name:, or raw name.
 * Returns either the custom emoji ID (for guild emojis) or the original string (for Unicode).
 * @param {string} rawEmoji
 * @param {import("discord.js").Guild|null} guild
 * @returns {string}
 */
export function resolveReactEmoji(rawEmoji, guild) {
  if (!rawEmoji) return "";
  // Strip accidental reaction count suffixes (e.g. " x1", " x2", "x1", "*1")
  let cleaned = rawEmoji.trim().replace(/\s*[xX*×]\s*\d+$/i, "").trim();
  if (!cleaned) return "";

  // If already in Discord tag format <:name:id> or <a:name:id>
  const customTagMatch = cleaned.match(/<a?:[a-zA-Z0-9_]+:(\d+)>/);
  if (customTagMatch) {
    return customTagMatch[1];
  }

  // If pure numeric ID
  if (/^\d{17,20}$/.test(cleaned)) {
    return cleaned;
  }

  const isColonWrapped = /^:[a-zA-Z0-9_]+:$/.test(cleaned);
  const cleanName = cleaned.replace(/^:|:$/g, "").trim().toLowerCase();

  // Check if it's a server custom emoji by name (:name: or name)
  if (guild && guild.emojis) {
    const guildEmoji = guild.emojis.cache.find(e => e.name.toLowerCase() === cleanName && e.available !== false);
    if (guildEmoji) {
      return guildEmoji.id;
    }
  }

  // Also check client global/application emoji cache if available
  if (guild?.client?.emojis) {
    const appEmoji = guild.client.emojis.cache.find(e => e.name.toLowerCase() === cleanName && e.available !== false);
    if (appEmoji) {
      return appEmoji.id;
    }
  }

  // If it was explicitly formatted as a custom emoji name (:name:), but wasn't found in cache:
  // It's a non-existent/hallucinated custom emoji. Returning this string to Discord will trigger "Unknown Emoji" error.
  if (isColonWrapped) {
    logger.warn(`[Emojis] Custom emoji "${cleaned}" not found on server "${guild?.name || 'unknown'}".`);
    return "";
  }

  // Otherwise assume it's a standard Unicode emoji
  return cleaned;
}

