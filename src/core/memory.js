import fs from "fs";
import { logger } from "../utils/logger.js";
import { loadConfig } from "../utils/config.js";
import { isChannelDisabled } from "./channel_control.js";

const MEMORIES_FILE = "memories.json";
const UNIVERSAL_KEY = "_universal";

const DEFAULT_TEMP_TTL_MINUTES = 240; // 4 hours
const MAX_CROSS_CHANNEL_SUMMARIES = 5;

/**
 * In-memory temporary memory store per channel.
 * Map<channelId, {
 *   channelId: string,
 *   channelName: string,
 *   guildId: string|null,
 *   isPrivate: boolean,
 *   summary: string,
 *   updatedAt: number,
 *   messageCountSinceUpdate: number
 * }>
 */
const tempMemories = new Map();

function loadMemories() {
  try {
    if (fs.existsSync(MEMORIES_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORIES_FILE, "utf-8"));
    }
  } catch (err) {
    logger.warn("Failed to load memories.json:", err.message);
  }
  return {};
}

function saveMemories(memories) {
  try {
    fs.writeFileSync(MEMORIES_FILE, JSON.stringify(memories, null, 2), "utf-8");
  } catch (err) {
    logger.error("Failed to save memories.json:", err.message);
  }
}

// ── Permanent Memory (Universal & Server-Specific) ──────────────────────────

/**
 * Returns all permanent universal memories (facts, skills, permanent global knowledge).
 * @returns {Array<{ id: string, text: string, type: "universal", createdAt: string, updatedAt?: string }>}
 */
export function getUniversalMemories() {
  const all = loadMemories();
  return all[UNIVERSAL_KEY] || all["universal"] || [];
}

/**
 * Saves permanent universal memories.
 * @param {Array} memories
 */
export function setUniversalMemories(memories) {
  const all = loadMemories();
  all[UNIVERSAL_KEY] = memories;
  saveMemories(all);
}

/**
 * Returns permanent server-specific memories for a given guild ID.
 * @param {string} guildId
 * @returns {Array<{ id: string, text: string, type: "server", createdAt: string, updatedAt?: string }>}
 */
export function getGuildMemories(guildId) {
  if (!guildId) return [];
  const all = loadMemories();
  return all[guildId] || [];
}

/**
 * Saves permanent server-specific memories for a given guild ID.
 * @param {string} guildId
 * @param {Array} memories
 */
export function setGuildMemories(guildId, memories) {
  if (!guildId) return;
  const all = loadMemories();
  all[guildId] = memories;
  saveMemories(all);
}

// ── Temporary Memory (Current Convo Summary & Cross-Channel Context) ────────

function getTempMemoryTtlMs(cfg = loadConfig()) {
  const minutes = Number(cfg.temp_memory_ttl_minutes);
  const validMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_TEMP_TTL_MINUTES;
  return validMinutes * 60 * 1000;
}

function isTempMemoryEnabled(cfg = loadConfig()) {
  return cfg.temp_memory_enabled !== false;
}

function pruneIfExpired(channelId, entry, ttlMs) {
  if (!entry) return null;
  if (entry.summary && Date.now() - entry.updatedAt > ttlMs) {
    tempMemories.delete(channelId);
    return null;
  }
  return entry;
}

function formatAge(timestampMs) {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

/**
 * Returns active temporary memory for a channel, or null if absent/expired/disabled.
 * @param {string} channelId
 * @returns {{ channelId: string, channelName: string, guildId: string|null, isPrivate: boolean, summary: string, updatedAt: number, messageCountSinceUpdate: number } | null}
 */
export function getTempMemory(channelId) {
  if (!channelId) return null;
  const cfg = loadConfig();
  if (!isTempMemoryEnabled(cfg)) return null;

  const entry = pruneIfExpired(channelId, tempMemories.get(channelId), getTempMemoryTtlMs(cfg));
  if (!entry || !entry.summary) return null;
  return entry;
}

/**
 * Sets or updates temporary memory for a channel.
 * @param {string} channelId
 * @param {string} summary
 * @param {{ guildId?: string|null, channelName?: string, isPrivate?: boolean }} meta
 */
export function setTempMemory(channelId, summary, meta = {}) {
  if (!channelId) return;
  const cleanSummary = (summary || "").trim();
  if (!cleanSummary) {
    clearTempMemory(channelId);
    return;
  }

  const existing = tempMemories.get(channelId);
  tempMemories.set(channelId, {
    channelId,
    channelName: meta.channelName || existing?.channelName || channelId,
    guildId: meta.guildId !== undefined ? meta.guildId : (existing?.guildId ?? null),
    isPrivate: meta.isPrivate !== undefined ? !!meta.isPrivate : (existing?.isPrivate ?? false),
    summary: cleanSummary,
    updatedAt: Date.now(),
    messageCountSinceUpdate: 0,
  });

  logger.log(`[TempMemory] Updated for #${meta.channelName || existing?.channelName || channelId}: "${cleanSummary}"`);
}

/**
 * Clears temporary memory for a specific channel.
 * @param {string} channelId
 */
export function clearTempMemory(channelId) {
  if (!channelId) return;
  if (tempMemories.delete(channelId)) {
    logger.log(`[TempMemory] Cleared for channel ${channelId}`);
  }
}

/**
 * Clears all temporary memories belonging to a guild.
 * @param {string} guildId
 */
export function clearGuildTempMemories(guildId) {
  if (!guildId) return;
  let count = 0;
  for (const [chId, entry] of tempMemories.entries()) {
    if (entry.guildId === guildId) {
      tempMemories.delete(chId);
      count++;
    }
  }
  logger.log(`[TempMemory] Cleared ${count} channel temp memor(y/ies) for guild ${guildId}`);
}

/**
 * Clears all temporary memories across all guilds and DMs.
 */
export function clearAllTempMemories() {
  const count = tempMemories.size;
  tempMemories.clear();
  logger.log(`[TempMemory] Cleared all ${count} temp memor(y/ies)`);
}

/**
 * Records an incoming message for a channel so background summarization knows how many messages arrived since the last summary.
 * @param {string} channelId
 * @param {{ guildId?: string|null, channelName?: string, isPrivate?: boolean }} meta
 * @param {number} increment
 * @returns {number} Updated message count since last summary
 */
export function noteTempMemoryMessage(channelId, meta = {}, increment = 1) {
  if (!channelId) return 0;
  const cfg = loadConfig();
  if (!isTempMemoryEnabled(cfg)) return 0;

  let entry = pruneIfExpired(channelId, tempMemories.get(channelId), getTempMemoryTtlMs(cfg));
  if (!entry) {
    entry = {
      channelId,
      channelName: meta.channelName || channelId,
      guildId: meta.guildId ?? null,
      isPrivate: !!meta.isPrivate,
      summary: "",
      updatedAt: 0,
      messageCountSinceUpdate: 0,
    };
    tempMemories.set(channelId, entry);
  } else {
    if (meta.channelName) entry.channelName = meta.channelName;
    if (meta.guildId !== undefined) entry.guildId = meta.guildId;
    if (meta.isPrivate !== undefined) entry.isPrivate = !!meta.isPrivate;
  }

  entry.messageCountSinceUpdate += increment;
  return entry.messageCountSinceUpdate;
}

/**
 * Resets the message counter since last temp memory summary for a channel.
 * @param {string} channelId
 */
export function resetTempMemoryCounter(channelId) {
  const entry = tempMemories.get(channelId);
  if (entry) {
    entry.messageCountSinceUpdate = 0;
  }
}

/**
 * Returns active temporary memories for a guild (optionally excluding one channel and private/disabled channels).
 * @param {string} guildId
 * @param {string|null} excludeChannelId
 * @param {boolean} includePrivate
 * @returns {Array<{ channelId: string, channelName: string, guildId: string|null, isPrivate: boolean, summary: string, updatedAt: number, ageLabel: string }>}
 */
export function getGuildTempMemories(guildId, excludeChannelId = null, includePrivate = false) {
  if (!guildId) return [];
  const cfg = loadConfig();
  if (!isTempMemoryEnabled(cfg)) return [];

  const ttlMs = getTempMemoryTtlMs(cfg);
  const results = [];

  for (const [chId, rawEntry] of tempMemories.entries()) {
    const entry = pruneIfExpired(chId, rawEntry, ttlMs);
    if (!entry || !entry.summary) continue;
    if (entry.guildId !== guildId) continue;
    if (excludeChannelId && entry.channelId === excludeChannelId) continue;
    if (!includePrivate && entry.isPrivate) continue;
    if (isChannelDisabled(entry.channelId, cfg)) continue;

    results.push({
      ...entry,
      ageLabel: formatAge(entry.updatedAt),
    });
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results.slice(0, MAX_CROSS_CHANNEL_SUMMARIES);
}

// ── Tag Processing ──────────────────────────────────────────────────────────

/**
 * Processes permanent and temporary memory tags in AI response text:
 * Permanent Memory tags (supports both [MEMORY:...] and [PERM_MEMORY:...]):
 * - [MEMORY:ADD:UNIVERSAL text] / [PERM_MEMORY:ADD:UNIVERSAL text] -> permanent universal fact/skill
 * - [MEMORY:ADD:SERVER text] / [PERM_MEMORY:ADD:SERVER text] -> permanent server context
 * - [MEMORY:ADD text] -> defaults to server context if in a guild, otherwise universal
 * - [MEMORY:EDIT #id text] -> edits existing permanent memory across server or universal
 * - [MEMORY:DELETE #id (reason)] -> deletes existing permanent memory across server or universal
 *
 * Temporary Memory tags:
 * - [TEMP_MEMORY: summary text] -> sets/updates temp memory for current channel
 * - [TEMP_MEMORY:CLEAR] -> clears temp memory for current channel
 *
 * @param {string} replyText
 * @param {string|null} guildId
 * @param {string|null} channelId
 * @param {{ guildId?: string|null, channelName?: string, isPrivate?: boolean }} channelMeta
 * @returns {string} Cleaned reply text without memory tags
 */
export function processMemoryTags(replyText, guildId = null, channelId = null, channelMeta = {}) {
  const memoryTagRegex = /\[(?:PERM_)?MEMORY:(ADD(?::(?:UNIVERSAL|GLOBAL|SERVER))?|EDIT|DELETE)\s*([^\]]+)\]/gi;
  let match;
  const operations = [];

  while ((match = memoryTagRegex.exec(replyText)) !== null) {
    const rawAction = match[1].toUpperCase();
    const rest = match[2].trim();

    if (rawAction.startsWith("ADD")) {
      let scope = null;
      let content = rest;

      if (rawAction.includes("UNIVERSAL") || rawAction.includes("GLOBAL")) {
        scope = "universal";
      } else if (rawAction.includes("SERVER")) {
        scope = "server";
      } else {
        const scopeMatch = rest.match(/^(?:\((UNIVERSAL|GLOBAL|SERVER)\)|(UNIVERSAL|GLOBAL|SERVER))\s*[:-]?\s*(.+)$/is);
        if (scopeMatch) {
          const matchedScope = (scopeMatch[1] || scopeMatch[2]).toUpperCase();
          scope = matchedScope === "SERVER" ? "server" : "universal";
          content = scopeMatch[3].trim();
        } else {
          scope = guildId ? "server" : "universal";
        }
      }

      if (content) {
        operations.push({
          action: "ADD",
          scope,
          id: null,
          content,
        });
      }
    } else if (rawAction === "EDIT") {
      const editMatch = rest.match(/^#?([a-z0-9]+)\s+(.+)$/is);
      if (editMatch) {
        operations.push({
          action: "EDIT",
          id: editMatch[1].toLowerCase(),
          content: editMatch[2].trim(),
        });
      } else {
        logger.warn(`[Memory] Invalid EDIT tag format: ${match[0]}`);
      }
    } else if (rawAction === "DELETE") {
      const deleteMatch = rest.match(/^#?([a-z0-9]+)(?:\s+(.*))?$/is);
      if (deleteMatch) {
        operations.push({
          action: "DELETE",
          id: deleteMatch[1].toLowerCase(),
          content: deleteMatch[2] ? deleteMatch[2].trim() : "",
        });
      } else {
        logger.warn(`[Memory] Invalid DELETE tag format: ${match[0]}`);
      }
    }
  }

  if (operations.length > 0) {
    let universalMemories = getUniversalMemories();
    let serverMemories = guildId ? getGuildMemories(guildId) : [];
    let universalChanged = false;
    let serverChanged = false;

    for (const op of operations) {
      if (op.action === "ADD") {
        const newId = Math.random().toString(36).substring(2, 8);
        const newMem = {
          id: newId,
          text: op.content,
          type: op.scope === "universal" ? "universal" : "server",
          createdAt: new Date().toISOString()
        };

        if (op.scope === "universal" || !guildId) {
          universalMemories.push(newMem);
          universalChanged = true;
          logger.log(`[PermanentMemory] ADD [UNIVERSAL]: [${newId}] "${op.content}"`);
        } else {
          serverMemories.push(newMem);
          serverChanged = true;
          logger.log(`[PermanentMemory] ADD [SERVER] in guild ${guildId}: [${newId}] "${op.content}"`);
        }
      } else if (op.action === "EDIT" && op.id) {
        let updated = false;

        if (guildId) {
          const idx = serverMemories.findIndex(m => m.id === op.id);
          if (idx !== -1) {
            logger.log(`[PermanentMemory] EDIT [SERVER] [${op.id}] in guild ${guildId}: "${serverMemories[idx].text}" -> "${op.content}"`);
            serverMemories[idx].text = op.content;
            serverMemories[idx].updatedAt = new Date().toISOString();
            serverChanged = true;
            updated = true;
          }
        }

        if (!updated) {
          const idx = universalMemories.findIndex(m => m.id === op.id);
          if (idx !== -1) {
            logger.log(`[PermanentMemory] EDIT [UNIVERSAL] [${op.id}]: "${universalMemories[idx].text}" -> "${op.content}"`);
            universalMemories[idx].text = op.content;
            universalMemories[idx].updatedAt = new Date().toISOString();
            universalChanged = true;
            updated = true;
          }
        }

        if (!updated) {
          logger.warn(`[PermanentMemory] EDIT failed: ID ${op.id} not found in guild ${guildId} or universal`);
        }
      } else if (op.action === "DELETE" && op.id) {
        let deleted = false;

        if (guildId) {
          const idx = serverMemories.findIndex(m => m.id === op.id);
          if (idx !== -1) {
            logger.log(`[PermanentMemory] DELETE [SERVER] [${op.id}] in guild ${guildId}: "${serverMemories[idx].text}"`);
            serverMemories.splice(idx, 1);
            serverChanged = true;
            deleted = true;
          }
        }

        if (!deleted) {
          const idx = universalMemories.findIndex(m => m.id === op.id);
          if (idx !== -1) {
            logger.log(`[PermanentMemory] DELETE [UNIVERSAL] [${op.id}]: "${universalMemories[idx].text}"`);
            universalMemories.splice(idx, 1);
            universalChanged = true;
            deleted = true;
          }
        }

        if (!deleted) {
          logger.warn(`[PermanentMemory] DELETE failed: ID ${op.id} not found in guild ${guildId} or universal`);
        }
      }
    }

    if (universalChanged) setUniversalMemories(universalMemories);
    if (serverChanged && guildId) setGuildMemories(guildId, serverMemories);
  }

  // Process [TEMP_MEMORY: ...] tags
  const tempTagRegex = /\[TEMP_MEMORY:\s*([^\]]+)\]/gi;
  let tempMatch;
  while ((tempMatch = tempTagRegex.exec(replyText)) !== null) {
    const content = tempMatch[1].trim();
    if (channelId && isTempMemoryEnabled()) {
      if (content.toUpperCase() === "CLEAR") {
        clearTempMemory(channelId);
      } else if (content) {
        setTempMemory(channelId, content, { guildId, ...channelMeta });
      }
    }
  }

  return replyText
    .replace(/\[(?:PERM_)?MEMORY:(?:ADD(?::(?:UNIVERSAL|GLOBAL|SERVER))?|EDIT|DELETE)\s*[^\]]*\]/gi, "")
    .replace(/\[TEMP_MEMORY:\s*[^\]]*\]/gi, "")
    .trim();
}

// ── Prompt Injection ────────────────────────────────────────────────────────

/**
 * Builds the structured Permanent + Temporary memory blocks to inject into the system prompt.
 *
 * @param {string|null} guildId
 * @param {string|null} channelId
 * @returns {string} Formatted memory blocks or empty string if no memories exist
 */
export function buildMemoryBlock(guildId = null, channelId = null) {
  const blocks = [];

  // 1. Permanent Memories
  const universalMemories = getUniversalMemories();
  const serverMemories = guildId ? getGuildMemories(guildId) : [];

  if (universalMemories.length > 0 || serverMemories.length > 0) {
    const permSections = [];

    if (universalMemories.length > 0) {
      const uLines = universalMemories.map(m => `- [ID: ${m.id || 'N/A'}] ${m.text}`).join("\n");
      permSections.push(`[PERMANENT - UNIVERSAL FACTS & SKILLS] (Active across all servers - long-term general knowledge and skills):\n${uLines}`);
    }

    if (serverMemories.length > 0) {
      const sLines = serverMemories.map(m => `- [ID: ${m.id || 'N/A'}] ${m.text}`).join("\n");
      permSections.push(`[PERMANENT - SERVER-SPECIFIC CONTEXT] (Active only in this server - long-term lore, nicknames, and user preferences):\n${sLines}`);
    }

    blocks.push(`\n\n--- YOUR PERMANENT MEMORIES & KNOWLEDGE ---\n${permSections.join("\n\n")}\n--- END PERMANENT MEMORIES ---`);
  }

  // 2. Temporary Memories (Current channel convo summary + cross-channel context)
  const currentTemp = channelId ? getTempMemory(channelId) : null;
  const crossChannelTemps = guildId ? getGuildTempMemories(guildId, channelId, false) : [];

  if (currentTemp || crossChannelTemps.length > 0) {
    const tempSections = [];

    if (currentTemp) {
      tempSections.push(`[TEMP - THIS CHANNEL (#${currentTemp.channelName}) — ${formatAge(currentTemp.updatedAt)}]:\n${currentTemp.summary}`);
    }

    if (crossChannelTemps.length > 0) {
      const crossLines = crossChannelTemps
        .map(t => `- [#${t.channelName}] (${t.ageLabel}): ${t.summary}`)
        .join("\n");
      tempSections.push(`[TEMP - OTHER CHANNELS IN THIS SERVER] (Cross-channel context — know what's happening elsewhere, never confuse which channel each event belongs to):\n${crossLines}`);
    }

    blocks.push(`\n\n--- TEMPORARY MEMORY (CURRENT CONVO SUMMARY) ---\nUse this strictly as a grounded summary of current/recent conversations to prevent hallucinations. Do NOT treat temporary chat state as permanent fact.\n${tempSections.join("\n\n")}\n--- END TEMPORARY MEMORY ---`);
  }

  return blocks.join("");
}
