import fs from "fs";
import { logger } from "../utils/logger.js";

const MEMORIES_FILE = "memories.json";
const UNIVERSAL_KEY = "_universal";

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

/**
 * Returns all universal memories (facts, skills, permanent global knowledge).
 * @returns {Array<{ id: string, text: string, type: "universal", createdAt: string, updatedAt?: string }>}
 */
export function getUniversalMemories() {
  const all = loadMemories();
  return all[UNIVERSAL_KEY] || all["universal"] || [];
}

/**
 * Saves universal memories.
 * @param {Array} memories
 */
export function setUniversalMemories(memories) {
  const all = loadMemories();
  all[UNIVERSAL_KEY] = memories;
  saveMemories(all);
}

/**
 * Returns server-specific memories for a given guild ID.
 * @param {string} guildId
 * @returns {Array<{ id: string, text: string, type: "server", createdAt: string, updatedAt?: string }>}
 */
export function getGuildMemories(guildId) {
  if (!guildId) return [];
  const all = loadMemories();
  return all[guildId] || [];
}

/**
 * Saves server-specific memories for a given guild ID.
 * @param {string} guildId
 * @param {Array} memories
 */
export function setGuildMemories(guildId, memories) {
  if (!guildId) return;
  const all = loadMemories();
  all[guildId] = memories;
  saveMemories(all);
}

/**
 * Processes memory tags in AI response text:
 * - [MEMORY:ADD:UNIVERSAL text] or [MEMORY:ADD UNIVERSAL: text] -> universal fact/skill
 * - [MEMORY:ADD:SERVER text] or [MEMORY:ADD SERVER: text] -> server context
 * - [MEMORY:ADD text] -> defaults to server context if in a guild, otherwise universal
 * - [MEMORY:EDIT #id text] -> edits existing memory across server or universal
 * - [MEMORY:DELETE #id (reason)] -> deletes existing memory across server or universal
 *
 * @param {string} replyText
 * @param {string|null} guildId
 * @returns {string} Cleaned reply text without memory tags
 */
export function processMemoryTags(replyText, guildId = null) {
  const memoryTagRegex = /\[MEMORY:(ADD(?::(?:UNIVERSAL|GLOBAL|SERVER))?|EDIT|DELETE)\s*([^\]]+)\]/gi;
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
        // Check if content starts with UNIVERSAL: / GLOBAL: / SERVER: or (UNIVERSAL) / (SERVER)
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
          logger.log(`[Memory] ADD [UNIVERSAL]: [${newId}] "${op.content}"`);
        } else {
          serverMemories.push(newMem);
          serverChanged = true;
          logger.log(`[Memory] ADD [SERVER] in guild ${guildId}: [${newId}] "${op.content}"`);
        }
      } else if (op.action === "EDIT" && op.id) {
        let updated = false;

        // Try server memories first
        if (guildId) {
          const idx = serverMemories.findIndex(m => m.id === op.id);
          if (idx !== -1) {
            logger.log(`[Memory] EDIT [SERVER] [${op.id}] in guild ${guildId}: "${serverMemories[idx].text}" -> "${op.content}"`);
            serverMemories[idx].text = op.content;
            serverMemories[idx].updatedAt = new Date().toISOString();
            serverChanged = true;
            updated = true;
          }
        }

        // Try universal memories
        if (!updated) {
          const idx = universalMemories.findIndex(m => m.id === op.id);
          if (idx !== -1) {
            logger.log(`[Memory] EDIT [UNIVERSAL] [${op.id}]: "${universalMemories[idx].text}" -> "${op.content}"`);
            universalMemories[idx].text = op.content;
            universalMemories[idx].updatedAt = new Date().toISOString();
            universalChanged = true;
            updated = true;
          }
        }

        if (!updated) {
          logger.warn(`[Memory] EDIT failed: ID ${op.id} not found in guild ${guildId} or universal`);
        }
      } else if (op.action === "DELETE" && op.id) {
        let deleted = false;

        // Try server memories first
        if (guildId) {
          const idx = serverMemories.findIndex(m => m.id === op.id);
          if (idx !== -1) {
            logger.log(`[Memory] DELETE [SERVER] [${op.id}] in guild ${guildId}: "${serverMemories[idx].text}"`);
            serverMemories.splice(idx, 1);
            serverChanged = true;
            deleted = true;
          }
        }

        // Try universal memories
        if (!deleted) {
          const idx = universalMemories.findIndex(m => m.id === op.id);
          if (idx !== -1) {
            logger.log(`[Memory] DELETE [UNIVERSAL] [${op.id}]: "${universalMemories[idx].text}"`);
            universalMemories.splice(idx, 1);
            universalChanged = true;
            deleted = true;
          }
        }

        if (!deleted) {
          logger.warn(`[Memory] DELETE failed: ID ${op.id} not found in guild ${guildId} or universal`);
        }
      }
    }

    if (universalChanged) setUniversalMemories(universalMemories);
    if (serverChanged && guildId) setGuildMemories(guildId, serverMemories);
  }

  return replyText.replace(/\[MEMORY:(?:ADD(?::(?:UNIVERSAL|GLOBAL|SERVER))?|EDIT|DELETE)\s*[^\]]*\]/gi, "").trim();
}

/**
 * Builds the structured memory block to inject into the system prompt.
 * Segregates Universal Facts & Skills from Server-Specific Context & Flow.
 *
 * @param {string|null} guildId
 * @returns {string} Formatted memory block or empty string if no memories exist
 */
export function buildMemoryBlock(guildId = null) {
  const universalMemories = getUniversalMemories();
  const serverMemories = guildId ? getGuildMemories(guildId) : [];

  if (universalMemories.length === 0 && serverMemories.length === 0) return "";

  const sections = [];

  if (universalMemories.length > 0) {
    const uLines = universalMemories.map(m => `- [ID: ${m.id || 'N/A'}] ${m.text}`).join("\n");
    sections.push(`[UNIVERSAL FACTS & SKILLS] (Active across all servers - use as general knowledge, permanent facts, and skills):\n${uLines}`);
  }

  if (serverMemories.length > 0) {
    const sLines = serverMemories.map(m => `- [ID: ${m.id || 'N/A'}] ${m.text}`).join("\n");
    sections.push(`[SERVER-SPECIFIC CONTEXT] (Active only in this server - use for local lore, member nicknames, running jokes, and conversation flow):\n${sLines}`);
  }

  return `\n\n--- YOUR MEMORIES & KNOWLEDGE ---\n${sections.join("\n\n")}\n--- END MEMORIES ---`;
}
