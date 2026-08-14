import fs from "fs";
import { logger } from "../utils/logger.js";

const MEMORIES_FILE = "memories.json";

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

export function getGuildMemories(guildId) {
  const all = loadMemories();
  return all[guildId] || [];
}

export function setGuildMemories(guildId, memories) {
  const all = loadMemories();
  all[guildId] = memories;
  saveMemories(all);
}

export function processMemoryTags(replyText, guildId) {
  const memoryTagRegex = /\[MEMORY:(ADD|EDIT|DELETE)\s*(?:#?([a-z0-9]+)\s*)?(.+?)\]/gi;
  let match;
  const operations = [];

  while ((match = memoryTagRegex.exec(replyText)) !== null) {
    operations.push({
      action: match[1].toUpperCase(),
      id: match[2] ? match[2].toLowerCase() : null,
      content: match[3].trim(),
    });
  }

  if (operations.length > 0) {
    const memories = getGuildMemories(guildId);

    for (const op of operations) {
      if (op.action === "ADD") {
        const newId = Math.random().toString(36).substring(2, 8);
        memories.push({ id: newId, text: op.content, createdAt: new Date().toISOString() });
        logger.log(`[Memory] ADD in guild ${guildId}: [${newId}] "${op.content}"`);
      } else if (op.action === "EDIT" && op.id) {
        const idx = memories.findIndex(m => m.id === op.id);
        if (idx !== -1) {
          logger.log(`[Memory] EDIT [${op.id}] in guild ${guildId}: "${memories[idx].text}" -> "${op.content}"`);
          memories[idx].text = op.content;
          memories[idx].updatedAt = new Date().toISOString();
        } else {
          logger.warn(`[Memory] EDIT failed: ID ${op.id} not found in guild ${guildId}`);
        }
      } else if (op.action === "DELETE" && op.id) {
        const idx = memories.findIndex(m => m.id === op.id);
        if (idx !== -1) {
          logger.log(`[Memory] DELETE [${op.id}] in guild ${guildId}: "${memories[idx].text}"`);
          memories.splice(idx, 1);
        } else {
          logger.warn(`[Memory] DELETE failed: ID ${op.id} not found in guild ${guildId}`);
        }
      }
    }

    setGuildMemories(guildId, memories);
  }

  return replyText.replace(/\[MEMORY:(?:ADD|EDIT|DELETE)\s*(?:#?[a-z0-9]+\s*)?.+?\]/gi, "").trim();
}

export function buildMemoryBlock(guildId) {
  const memories = getGuildMemories(guildId);
  if (memories.length === 0) return "";
  const lines = memories.map(m => `[ID: ${m.id || 'N/A'}] ${m.text}`).join("\n");
  return `\n\n--- YOUR MEMORIES FOR THIS SERVER ---\n${lines}\n--- END MEMORIES ---`;
}
