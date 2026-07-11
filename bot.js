import "dotenv/config";
import { Client, GatewayIntentBits, ActivityType, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags, AttachmentBuilder } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import path from "path";
import { joinAndStartLive, leaveLive } from "./voice.js";

// ── Lib Directory Setup ─────────────────────────────────────────────────────

const LIB_IMG = path.resolve("lib/img");
const LIB_GEN_IMG = path.resolve("lib/gen_img");
const LIB_GEN_VID = path.resolve("lib/gen_vid");
const LIB_CACHE = path.resolve("lib/cache");
fs.mkdirSync(LIB_IMG, { recursive: true });
fs.mkdirSync(LIB_GEN_IMG, { recursive: true });
fs.mkdirSync(LIB_GEN_VID, { recursive: true });
fs.mkdirSync(LIB_CACHE, { recursive: true });

// ── Logger Setup ────────────────────────────────────────────────────────────

const LOG_FILE = "bot.log";

const logger = {
  log: (...args) => {
    const msg = `[${new Date().toISOString()}] [INFO] ${args.map(a => typeof a === 'object' && !(a instanceof Error) ? JSON.stringify(a) : a).join(" ")}`;
    console.log(msg);
    fs.appendFileSync(LOG_FILE, msg + "\n");
  },
  warn: (...args) => {
    const msg = `[${new Date().toISOString()}] [WARN] ${args.map(a => typeof a === 'object' && !(a instanceof Error) ? JSON.stringify(a) : a).join(" ")}`;
    console.warn(msg);
    fs.appendFileSync(LOG_FILE, msg + "\n");
  },
  error: (...args) => {
    const msg = `[${new Date().toISOString()}] [ERROR] ${args.map(a => typeof a === 'object' && !(a instanceof Error) ? JSON.stringify(a) : a).join(" ")}`;
    console.error(msg);
    fs.appendFileSync(LOG_FILE, msg + "\n");
  }
};

// ── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync("config.json", "utf-8"));
  } catch (err) {
    logger.warn("Failed to load config.json, using defaults:", err.message);
    return {};
  }
}

const config = loadConfig();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Max retry attempts when hitting the RPM rate limit (429) per model
const MAX_RETRIES = 2;

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN in .env");
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");

// ── Gemini Setup ────────────────────────────────────────────────────────────

const genai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Memory System ───────────────────────────────────────────────────────────

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

function getGuildMemories(guildId) {
  const all = loadMemories();
  return all[guildId] || [];
}

function setGuildMemories(guildId, memories) {
  const all = loadMemories();
  all[guildId] = memories;
  saveMemories(all);
}

/**
 * Process [MEMORY] tags from the AI's response and apply them.
 * Returns the response with all [MEMORY] tags stripped out.
 */
function processMemoryTags(replyText, guildId) {
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

  // Strip all [MEMORY:...] tags from the visible reply
  return replyText.replace(/\[MEMORY:(?:ADD|EDIT|DELETE)\s*(?:#?[a-z0-9]+\s*)?.+?\]/gi, "").trim();
}

function buildMemoryBlock(guildId) {
  const memories = getGuildMemories(guildId);
  if (memories.length === 0) return "";
  const lines = memories.map(m => `[ID: ${m.id || 'N/A'}] ${m.text}`).join("\n");
  return `\n\n--- YOUR MEMORIES FOR THIS SERVER ---\n${lines}\n--- END MEMORIES ---`;
}

// ── System Prompt ───────────────────────────────────────────────────────────

function loadSystemPrompt() {
  try {
    return fs.readFileSync("system_prompt.txt", "utf-8");
  } catch (err) {
    logger.warn("Failed to load system_prompt.txt:", err.message);
    return "You are a friendly AI assistant."; // Extremely basic fallback
  }
}

const BASE_SYSTEM_PROMPT = loadSystemPrompt();

// ── Supported MIME types for Gemini vision ──────────────────────────────────

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

const SUPPORTED_DOC_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/html",
  "text/css",
  "text/javascript",
  "text/csv",
  "text/markdown",
  "text/x-python",
  "application/json",
  "text/xml",
  "audio/wav",
  "audio/mp3",
  "audio/mpeg",
  "audio/ogg",
  "video/mp4",
  "video/mpeg",
  "video/webm",
]);

function isSupportedAttachment(contentType) {
  if (!contentType) return false;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  return SUPPORTED_IMAGE_TYPES.has(mime) || SUPPORTED_DOC_TYPES.has(mime);
}

// ── Conversation History (per-channel) ──────────────────────────────────────
// We only store text in history to avoid memory bloat from image buffers.

/** @type {Map<string, Array<{role: string, text: string, attachments: Array<{filepath: string, mimeType: string}>}>>} */
const channelHistory = new Map();

function getHistory(channelId) {
  if (!channelHistory.has(channelId)) {
    channelHistory.set(channelId, []);
  }
  return channelHistory.get(channelId);
}

function pushHistory(channelId, role, text, attachments = []) {
  const history = getHistory(channelId);
  history.push({ role, text, attachments });
  
  // Trim to max (live-read config)
  const cfg = loadConfig();
  const maxHistory = cfg.max_history || parseInt(process.env.MAX_HISTORY || "30", 10);
  
  while (history.length > maxHistory) {
    const shifted = history.shift();
    // Garbage collection for cached attachments falling out of history
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

function clearHistory(channelId) {
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

// ── Attachment Caching ──────────────────────────────────────────────────────

async function downloadAttachment(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer);
}

/**
 * Download Discord attachments, cache them to disk, and return their metadata.
 * @param {import("discord.js").Collection} attachments
 * @returns {Promise<Array<{filepath: string, mimeType: string}>>}
 */
async function cacheAttachments(attachments) {
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

// ── Image Helpers ───────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif"]);

function getSavedImagesList() {
  try {
    return fs.readdirSync(LIB_IMG).filter(f => {
      const ext = path.extname(f).toLowerCase();
      return IMAGE_EXTENSIONS.has(ext);
    });
  } catch (err) {
    logger.error("Failed to read img directory:", err.message);
    return [];
  }
}

function getSavedImage(name) {
  const files = getSavedImagesList();
  const match = files.find(f => f.toLowerCase().startsWith(name.toLowerCase()));
  if (match) return path.join(LIB_IMG, match);
  return null;
}

async function downloadImageToLib(url, customName = null) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const contentType = res.headers.get("content-type") || "";
  const mime = contentType.split(";")[0].trim().toLowerCase();
  
  const extMap = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
  };
  const ext = extMap[mime] || ".png";
  const nameBase = customName ? customName.replace(/[^a-z0-9_-]/gi, "_") : `img_${Date.now()}`;
  const filename = `${nameBase}${ext}`;
  const filepath = path.join(LIB_IMG, filename);

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filepath, buffer);
  
  // Save to info tracking file
  try {
    const infoFile = path.join(LIB_IMG, "img_info.json");
    let infoData = {};
    if (fs.existsSync(infoFile)) {
      infoData = JSON.parse(fs.readFileSync(infoFile, "utf8"));
    }
    infoData[filename] = {
      sourceUrl: url,
      downloadedAt: new Date().toISOString()
    };
    fs.writeFileSync(infoFile, JSON.stringify(infoData, null, 2), "utf8");
  } catch (err) {
    logger.error("Failed to update img_info.json:", err.message);
  }

  return { filepath, filename };
}

// ── Image Generation (Gemini Native) ────────────────────────────────────────

async function generateImage(prompt) {
  const cfg = loadConfig();
  const imageModels = cfg.models?.image_gen || ["gemini-2.0-flash-preview-image-generation"];

  for (const model of imageModels) {
    try {
      const response = await genai.models.generateContent({
        model: model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          responseModalities: ["TEXT", "IMAGE"],
          temperature: 1.0,
        },
      });

      // Extract image from response parts
      if (response.candidates && response.candidates[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) {
            const mimeType = part.inlineData.mimeType || "image/png";
            const extMap = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
            const ext = extMap[mimeType] || ".png";
            const filename = `gen_${Date.now()}${ext}`;
            const filepath = path.join(LIB_GEN_IMG, filename);

            const buffer = Buffer.from(part.inlineData.data, "base64");
            fs.writeFileSync(filepath, buffer);
            logger.log(`[ImageGen] Generated image saved: ${filename}`);
            return { filepath, filename };
          }
        }
      }

      logger.warn(`[ImageGen] Model ${model} returned no image data.`);
    } catch (err) {
      logger.warn(`[ImageGen] Model ${model} failed:`, err.message);
    }
  }

  return null; // All models failed
}

// ── Video Generation (Gemini Native) ────────────────────────────────────────

async function generateVideo(prompt) {
  const cfg = loadConfig();
  const videoModels = cfg.models?.video_gen || ["veo-2.0-generate-001"];

  for (const model of videoModels) {
    try {
      const response = await genai.models.generateContent({
        model: model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          responseModalities: ["TEXT", "VIDEO"],
          temperature: 1.0,
        },
      });

      // Extract video from response parts
      if (response.candidates && response.candidates[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData || part.fileData) { // Veo might return inlineData or a fileData URL
            // If inlineData
            if (part.inlineData) {
              const mimeType = part.inlineData.mimeType || "video/mp4";
              const extMap = { "video/mp4": ".mp4", "video/webm": ".webm" };
              const ext = extMap[mimeType] || ".mp4";
              const filename = `gen_${Date.now()}${ext}`;
              const filepath = path.join(LIB_GEN_VID, filename);

              const buffer = Buffer.from(part.inlineData.data, "base64");
              fs.writeFileSync(filepath, buffer);
              logger.log(`[VideoGen] Generated video saved: ${filename}`);
              return { filepath, filename };
            }
          }
        }
      }

      logger.warn(`[VideoGen] Model ${model} returned no video data.`);
    } catch (err) {
      logger.warn(`[VideoGen] Model ${model} failed:`, err.message);
    }
  }
  return null;
}

// ── Message Classification ─────────────────────────────────────────────────────────

async function classifyPrompt(text) {
  const prompt = `Classify the following user message into one of these categories:
1: SEARCH (needs up-to-date info, news, weather, real-time facts)
2: THINKING (complex math, coding, logic puzzles, deep reasoning)
3: NORMAL (casual chat, general knowledge, basic questions)
Reply with ONLY the number (1, 2, or 3).
User message: "${text}"`;

  const cfg = loadConfig();
  const modelsDefault = cfg.models?.default || ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemma-4-31b"];

  for (const model of modelsDefault) {
    try {
      const response = await genai.models.generateContent({
        model: model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { maxOutputTokens: 10, temperature: 0 },
      });
      const reply = response.text?.trim() || "3";
      if (reply.includes("1")) return "SEARCH";
      if (reply.includes("2")) return "THINKING";
      return "NORMAL";
    } catch (err) {
      logger.warn(`Classifier failed on ${model}, trying next...`);
    }
  }
  return "NORMAL"; // Fallback to normal on classification error across all default models
}

async function generateReply(channelId, userText, guildId = null) {
  // User messages are now pushed to history in messageCreate before calling this

  const history = getHistory(channelId);

  // Build contents array from history, converting cached files back to inlineData just-in-time
  const contents = history.map((entry) => {
    const parts = [{ text: entry.text }];
    
    if (entry.attachments && entry.attachments.length > 0) {
      for (const att of entry.attachments) {
        try {
          if (fs.existsSync(att.filepath)) {
            const buffer = fs.readFileSync(att.filepath);
            parts.push({
              inlineData: {
                data: buffer.toString("base64"),
                mimeType: att.mimeType
              }
            });
          }
        } catch (err) {
          logger.warn(`Failed to read cached attachment ${att.filepath}:`, err.message);
        }
      }
    }
    
    return { role: entry.role, parts };
  });

  // Build system prompt with memories and image list injected
  const memoryBlock = guildId ? buildMemoryBlock(guildId) : "";
  const savedImages = getSavedImagesList();
  const imagesBlock = savedImages.length > 0 
    ? `\n\n--- YOUR SAVED IMAGES ---\nYou currently have these images saved in your library:\n${savedImages.map(f => `- ${f}`).join("\n")}\nYou can send them using [SEND_IMG: name].\n--- END SAVED IMAGES ---` 
    : "\n\n--- YOUR SAVED IMAGES ---\nYour library is empty. You can save images using [SAVE_IMG: url | name].\n--- END SAVED IMAGES ---";
    
  const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT + memoryBlock + imagesBlock;

  // 1. Determine task type — check for forced tags first
  let taskType = "NORMAL";
  let cleanedUserText = userText;

  if (/\[SEARCH\]/i.test(userText)) {
    taskType = "SEARCH";
    cleanedUserText = userText.replace(/\[SEARCH\]/gi, "").trim() || userText;
    logger.log(`[Forced] User forced SEARCH mode`);
  } else if (/\[THINKING\]/i.test(userText)) {
    taskType = "THINKING";
    cleanedUserText = userText.replace(/\[THINKING\]/gi, "").trim() || userText;
    logger.log(`[Forced] User forced THINKING mode`);
  } else if (cleanedUserText.length > 10) {
    taskType = await classifyPrompt(cleanedUserText);
  }

  const cfg = loadConfig();
  const modelsDefault = cfg.models?.default || ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemma-4-31b"];
  const modelsSearch = cfg.models?.search || ["gemini-2.5-flash"];
  const modelsThinking = cfg.models?.thinking || ["gemini-3.5-flash", "gemini-2.5-flash"];

  let modelList = modelsDefault;
  let useSearch = false;

  if (taskType === "SEARCH") {
    modelList = modelsSearch;
    useSearch = true;
  } else if (taskType === "THINKING") {
    modelList = modelsThinking;
  }

  let reportedIssue = "";
  const retryDelays = [5000, 15000];

  // Attempt generation with selected model list
  for (const model of modelList) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const config = {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.7,
          maxOutputTokens: 1000,
        };
        if (useSearch) {
          config.tools = [{ googleSearch: {} }];
        } else if (taskType === "NORMAL") {
          config.maxOutputTokens = 600;
          config.temperature = 1.0;
        }

        const response = await genai.models.generateContent({
          model: model,
          contents,
          config,
        });

        let replyText = response.text?.trim() || "hmm, I got nothing 🤔";
        if (reportedIssue) replyText = reportedIssue + replyText;

        pushHistory(channelId, "model", replyText);
        return replyText;

      } catch (err) {
        const is429 = err?.message?.includes('"code":429') || err?.message?.includes("RESOURCE_EXHAUSTED") || err?.message?.includes("QUOTA_EXCEEDED") || err?.status === 429;

        if (is429 && attempt < MAX_RETRIES) {
          await sleep(retryDelays[attempt] || 5000);
          continue;
        }

        // Exhausted retries for this specific model or non-429 error
        logger.warn(`${taskType} task failed on ${model}. Error:`, err.message);
        reportedIssue += `⚠️ *(Auto-Fallback: \`${taskType}\` task failed on \`${model}\`. Switching to next model...)*\n\n`;
        break; // break out of retry loop, move to next model
      }
    }
  }

  // If we get here, all models in the assigned list failed. 
  // Let's fallback to the DEFAULT list if we weren't already using it.
  if (taskType !== "NORMAL") {
    reportedIssue += `⚠️ *(Auto-Fallback: All \`${taskType}\` models failed. Falling back to \`NORMAL\` models...)*\n\n`;
    for (const model of modelsDefault) {
      try {
        const response = await genai.models.generateContent({
          model: model,
          contents,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            temperature: 1.0,
            maxOutputTokens: 600,
          },
        });

        let replyText = response.text?.trim() || "hmm, I got nothing 🤔";
        replyText = reportedIssue + replyText;

        pushHistory(channelId, "model", replyText);
        return replyText;

      } catch (err) {
        logger.warn(`Fallback default model ${model} failed. Error:`, err.message);
        reportedIssue += `⚠️ *(Auto-Fallback: \`${model}\` failed...)*\n\n`;
      }
    }
  }

  // If even the ultimate fallback fails
  return reportedIssue + "I had an error with all available models. Out of tokens or quota! 🤦‍♂️";
}

// ── Discord Bot ─────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ── Slash Commands Registration ─────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your current voice channel and start Gemini Live"),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Leave the voice channel"),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear the bot's memory for this channel"),
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check if the bot is alive"),
  new SlashCommandBuilder()
    .setName("memories")
    .setDescription("View the bot's saved memories for this server"),
  new SlashCommandBuilder()
    .setName("reset_memory")
    .setDescription("[Admin] Completely erase the AI's saved memories for this server"),
  new SlashCommandBuilder()
    .setName("pause_ai")
    .setDescription("[Admin] Pause or unpause the AI from responding in text channels"),
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("[Admin] Change bot configuration settings")
    .addStringOption(option => 
      option.setName('setting')
        .setDescription('The setting to change')
        .setRequired(true)
        .addChoices(
          { name: 'max_history', value: 'max_history' },
          { name: 'random_appear_rate', value: 'random_appear_rate' },
          { name: 'silence_duration_ms', value: 'silence_duration_ms' },
          { name: 'voice_name', value: 'voice_name' }
        ))
    .addStringOption(option => option.setName('value').setDescription('The new value').setRequired(true)),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a user from the server")
    .addUserOption(option => option.setName('target').setDescription('The user to kick').setRequired(true))
    .addStringOption(option => option.setName('reason').setDescription('The reason for kicking'))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a user from the server")
    .addUserOption(option => option.setName('target').setDescription('The user to ban').setRequired(true))
    .addStringOption(option => option.setName('reason').setDescription('The reason for banning'))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a user")
    .addUserOption(option => option.setName('target').setDescription('The user to timeout').setRequired(true))
    .addIntegerOption(option => option.setName('duration').setDescription('Duration in minutes').setRequired(true))
    .addStringOption(option => option.setName('reason').setDescription('The reason for timeout'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a user from the server")
    .addStringOption(option => option.setName('userid').setDescription('The ID of the user to unban').setRequired(true))
    .addStringOption(option => option.setName('reason').setDescription('The reason for unbanning'))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Bulk delete messages")
    .addIntegerOption(option => option.setName('amount').setDescription('Number of messages to delete (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder()
    .setName("add_image")
    .setDescription("[Admin] Add an image to the bot's library via URL or attachment")
    .addStringOption(option => option.setName('url').setDescription('Direct URL to the image').setRequired(false))
    .addAttachmentOption(option => option.setName('file').setDescription('Image file upload').setRequired(false))
    .addStringOption(option => option.setName('name').setDescription('Optional custom name for the image').setRequired(false)),
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  const rest = new REST().setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    logger.log("✅ Slash commands synced");
  } catch (err) {
    logger.error("Failed to sync slash commands:", err);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function shouldRespond(message) {
  if (message.author.bot) return false;

  // Mentioned directly
  if (message.mentions.has(client.user)) return true;

  // Replied to the bot
  if (message.reference) {
    // We'll check this via the resolved message
    return true; // We'll verify in the handler
  }

  return false;
}

function cleanContent(message) {
  let text = message.content;
  // Remove bot mentions
  text = text.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
  return text || "hey";
}

// ── Events ──────────────────────────────────────────────────────────────────

client.once("ready", async () => {
  logger.log(`🤖 Logged in as ${client.user.tag}`);
  logger.log(`📡 Connected to ${client.guilds.cache.size} server(s)`);

  client.user.setActivity("your RAMs ✨", { type: ActivityType.Playing });

  await registerCommands();
});

let isAIPaused = false;

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const userText = cleanContent(message);
  const userName = message.author.displayName || message.author.username;
  const userId = message.author.id;
  const timestamp = message.createdAt.toISOString();

  // Build enriched history string with timestamp and reply context
  let historyPrefix = `[${timestamp}] ${userName} (ID: ${userId})`;
  
  if (message.reference) {
    try {
      const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
      const replyAuthor = repliedMsg.author.displayName || repliedMsg.author.username;
      const replyAuthorId = repliedMsg.author.id;
      const replyContent = (repliedMsg.content || "").substring(0, 100);
      historyPrefix += ` [replying to ${replyAuthor} (ID: ${replyAuthorId}): "${replyContent}"]`;
    } catch { }
  }

  // Download and cache any supported image/pdf attachments right away so they enter history
  const cachedAttachments = message.attachments.size > 0
    ? await cacheAttachments(message.attachments)
    : [];

  // ALWAYS add every message to history so the bot can follow the conversation
  pushHistory(message.channel.id, "user", `${historyPrefix}: ${userText}`, cachedAttachments);

  if (isAIPaused) return;

  // Decide if we should process this message
  let isMentioned = message.mentions.has(client.user);
  let isReplyToBot = false;

  if (message.reference && !isMentioned) {
    try {
      const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
      if (repliedTo.author.id === client.user.id) {
        isReplyToBot = true;
      }
    } catch { }
  }

  // Process if mentioned, replied to, or random chance for spontaneous interaction
  const cfg = loadConfig();
  const randomRate = cfg.random_appear_rate ?? 0.05;
  const shouldProcess = isMentioned || isReplyToBot || Math.random() < randomRate;

  if (!shouldProcess) {
    return;
  }

  try {
    await message.channel.sendTyping();

    const reply = await generateReply(
      message.channel.id,
      userText,
      message.guildId
    );

    // Process any memory operations from the AI's response (silently)
    let finalReply = reply.trim();
    
    // Log the full raw response before any tags are stripped out
    logger.log(`\n[Raw AI Response]:\n${finalReply}\n--------------------------`);

    if (message.guildId) {
      finalReply = processMemoryTags(finalReply, message.guildId);
    }

    logger.log(`[Response] to ${userName} in ${message.channel.id}: ${finalReply.substring(0, 200)}`);

    // Check for IGNORE or REACT
    if (finalReply.includes("[IGNORE]")) {
      return;
    }

    const reactMatch = finalReply.match(/\[REACT:\s*(.+?)\]/);
    if (reactMatch) {
      const emoji = reactMatch[1].trim();
      try {
        await message.react(emoji);
      } catch (err) {
        logger.error("Failed to react with emoji:", emoji);
      }
      // Remove the REACT tag and continue processing the rest of the text
      finalReply = finalReply.replace(/\[REACT:\s*.+?\]/gi, "").trim();
      
      // If there's no message text left after reacting, stop here
      if (!finalReply) {
        return;
      }
    }

    // ── Process [IMGGEN: prompt] tag ────────────────────────────────────
    const attachments = [];
    const genImgMatch = finalReply.match(/\[IMGGEN:\s*(.+?)\]/i);
    if (genImgMatch) {
      const imgPrompt = genImgMatch[1].trim();
      finalReply = finalReply.replace(/\[IMGGEN:\s*.+?\]/gi, "").trim();
      
      try {
        await message.channel.sendTyping();
        const result = await generateImage(imgPrompt);
        if (result) {
          attachments.push(new AttachmentBuilder(result.filepath, { name: result.filename }));
        } else {
          finalReply += "\n\n⚠️ *Image generation failed — all models exhausted.*";
        }
      } catch (err) {
        logger.error("[IMGGEN] Error:", err.message);
        finalReply += "\n\n⚠️ *Image generation encountered an error.*";
      }
    }

    // ── Process [VIDGEN: prompt] tag ────────────────────────────────────
    const genVidMatch = finalReply.match(/\[VIDGEN:\s*(.+?)\]/i);
    if (genVidMatch) {
      const vidPrompt = genVidMatch[1].trim();
      finalReply = finalReply.replace(/\[VIDGEN:\s*.+?\]/gi, "").trim();
      
      try {
        await message.channel.sendTyping();
        const result = await generateVideo(vidPrompt);
        if (result) {
          attachments.push(new AttachmentBuilder(result.filepath, { name: result.filename }));
        } else {
          finalReply += "\n\n⚠️ *Video generation failed — all models exhausted.*";
        }
      } catch (err) {
        logger.error("[VIDGEN] Error:", err.message);
        finalReply += "\n\n⚠️ *Video generation encountered an error.*";
      }
    }

    // ── Process [SAVE_IMG: url | name] tag ───────────────────────────────────
    const saveImgRegex = /\[SAVE_IMG:\s*(https?:\/\/[^\s\|]+)\s*\|\s*([^\]]+)\]/gi;
    let saveMatch;
    while ((saveMatch = saveImgRegex.exec(finalReply)) !== null) {
      const url = saveMatch[1].trim();
      const customName = saveMatch[2].trim();
      try {
        const { filename } = await downloadImageToLib(url, customName);
        logger.log(`[SaveImg] AI saved image from URL as ${filename}`);
      } catch (err) {
        logger.error(`[SaveImg] AI failed to save image:`, err.message);
      }
    }
    // Strip all save tags
    finalReply = finalReply.replace(/\[SAVE_IMG:\s*https?:\/\/[^\s\|]+\s*\|\s*[^\]]+\]/gi, "").trim();

    // ── Process [SEND_IMG: name] tag ─────────────────────────────────────────
    const sendImgMatch = finalReply.match(/\[SEND_IMG:\s*([^\]]+)\]/i);
    if (sendImgMatch) {
      const imgName = sendImgMatch[1].trim();
      finalReply = finalReply.replace(/\[SEND_IMG:\s*[^\]]+\]/gi, "").trim();
      const savedImgPath = getSavedImage(imgName);
      if (savedImgPath) {
        attachments.push(new AttachmentBuilder(savedImgPath));
      } else {
        logger.warn(`[SendImg] AI tried to send non-existent image: ${imgName}`);
      }
    }

    let shouldEmbed = false;

    if (finalReply.includes("[EMBED]")) {
      shouldEmbed = true;
      finalReply = finalReply.replace("[EMBED]", "").trim();
    }
    // Also embed if there's a system fallback warning
    if (finalReply.includes("⚠️ *(Auto-Fallback")) {
      shouldEmbed = true;
    }

    // Cleanup excessive newlines caused by stripping tags
    finalReply = finalReply.replace(/\n\s*\n/g, "\n\n").trim();

    // Build base reply options
    const replyOpts = {
      allowedMentions: { repliedUser: false, parse: ['users', 'roles'] },
    };
    if (attachments.length > 0) {
      replyOpts.files = attachments;
    }

    if (shouldEmbed) {
      let isParsedJson = false;

      try {
        const jsonMatch = finalReply.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const embedObj = JSON.parse(jsonMatch[0]);
          if (embedObj && typeof embedObj === 'object') {
            const embed = new EmbedBuilder();
            if (embedObj.title) embed.setTitle(String(embedObj.title).substring(0, 256));
            if (embedObj.description) embed.setDescription(String(embedObj.description).substring(0, 4096));
            if (embedObj.color) embed.setColor(embedObj.color);
            else embed.setColor(0x4285F4);

            if (Array.isArray(embedObj.fields)) {
              for (const f of embedObj.fields) {
                if (f.name && f.value) {
                  embed.addFields({ name: String(f.name).substring(0, 256), value: String(f.value).substring(0, 1024), inline: !!f.inline });
                }
              }
            }
            if (embedObj.footer?.text) embed.setFooter({ text: String(embedObj.footer.text).substring(0, 2048) });

            await message.reply({ ...replyOpts, embeds: [embed] });
            isParsedJson = true;
          }
        }
      } catch (e) {
        // Not valid JSON or failed to build, fallback to text description
      }

      if (!isParsedJson) {
        // Discord Embed description limit is 4096 chars
        if (finalReply.length > 4000) {
          const chunks = finalReply.match(/[\s\S]{1,4000}/g) || [finalReply];
          for (let i = 0; i < chunks.length; i++) {
            const embed = new EmbedBuilder()
              .setColor(0x4285F4)
              .setDescription(chunks[i]);
            // Only attach files on the first chunk
            const opts = i === 0 ? { ...replyOpts, embeds: [embed] } : { embeds: [embed], allowedMentions: replyOpts.allowedMentions };
            await message.reply(opts);
          }
        } else {
          const embed = new EmbedBuilder()
            .setColor(0x4285F4)
            .setDescription(finalReply);
          await message.reply({ ...replyOpts, embeds: [embed] });
        }
      }
    } else {
      // Plain text for short/casual chats
      if (!finalReply && attachments.length > 0) {
        // Image-only response (no text)
        await message.reply(replyOpts);
      } else {
        await message.reply({ ...replyOpts, content: finalReply });
      }
    }
  } catch (err) {
    logger.error("Error handling message:", err);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  logger.log(`[Command] ${interaction.user.tag} used /${interaction.commandName}`);

  if (interaction.commandName === "join") {
    await joinAndStartLive(interaction, logger);
  }

  if (interaction.commandName === "leave") {
    await leaveLive(interaction);
  }

  if (interaction.commandName === "clear") {
    clearHistory(interaction.channelId);
    await interaction.reply({
      content: "🧹 Memory wiped for this channel! Fresh start.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.commandName === "ping") {
    const latency = Math.round(client.ws.ping);
    await interaction.reply({
      content: `🏓 Pong! \`${latency}ms\``,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.commandName === "memories") {
    const memories = getGuildMemories(interaction.guildId);
    if (memories.length === 0) {
      await interaction.reply({ content: "🧠 No memories saved for this server yet!", flags: MessageFlags.Ephemeral });
    } else {
      const lines = memories.map((m, i) => `**#${i + 1}**: ${m.text}`).join("\n");
      const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle("🧠 Bot Memories")
        .setDescription(lines.substring(0, 4096))
        .setFooter({ text: `${memories.length} memory(s) saved` });
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  }

  // ── Admin Commands ────────────────────────────────────────────────────────

  const adminCommands = ["reset_memory", "pause_ai", "config", "add_image"];
  if (adminCommands.includes(interaction.commandName)) {
    const adminEnv = process.env.ADMINS || "";
    const admins = adminEnv.split(",").map(id => id.trim()).filter(id => id);
    
    if (admins.length === 0) {
      return interaction.reply({ content: "❌ No admins are configured! Please add your User ID to the `ADMINS` variable in `.env` (comma separated).", flags: MessageFlags.Ephemeral });
    }
    
    if (!admins.includes(interaction.user.id)) {
      return interaction.reply({ content: "❌ You are not on the bot's admin whitelist.", flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "reset_memory") {
      setGuildMemories(interaction.guildId, []);
      return interaction.reply({ content: "🧠 All AI memories for this server have been completely wiped by an admin." });
    }

    if (interaction.commandName === "pause_ai") {
      isAIPaused = !isAIPaused;
      return interaction.reply({ content: isAIPaused ? "⏸️ AI has been PAUSED globally. It will no longer reply to messages." : "▶️ AI has been UNPAUSED. It will now process messages again." });
    }

    if (interaction.commandName === "config") {
      const setting = interaction.options.getString('setting');
      const valueStr = interaction.options.getString('value');
      let newValue = valueStr;

      // Parse types properly
      if (setting === "max_history" || setting === "silence_duration_ms") {
        newValue = parseInt(valueStr, 10);
        if (isNaN(newValue)) return interaction.reply({ content: "❌ Value must be a valid integer.", flags: MessageFlags.Ephemeral });
      } else if (setting === "random_appear_rate") {
        newValue = parseFloat(valueStr);
        if (isNaN(newValue)) return interaction.reply({ content: "❌ Value must be a valid number (e.g. 0.1).", flags: MessageFlags.Ephemeral });
      }

      const currentConfig = loadConfig();
      currentConfig[setting] = newValue;
      try {
        fs.writeFileSync("config.json", JSON.stringify(currentConfig, null, 2), "utf-8");
        return interaction.reply({ content: `✅ Config updated: \`${setting}\` is now \`${newValue}\`. Note: This setting has immediately taken effect!`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to save config: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    if (interaction.commandName === "add_image") {
      const url = interaction.options.getString('url');
      const attachment = interaction.options.getAttachment('file');
      const customName = interaction.options.getString('name');
      
      const targetUrl = attachment ? attachment.url : url;

      if (!targetUrl) {
        return interaction.reply({ content: "❌ You must provide either a URL or an attachment.", flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const { filename } = await downloadImageToLib(targetUrl, customName);
        const totalImages = getSavedImagesList().length;
        return interaction.editReply({ content: `✅ Image saved as \`${filename}\`. Library now has **${totalImages}** image(s).` });
      } catch (err) {
        logger.error("[add_image] Failed:", err.message);
        return interaction.editReply({ content: `❌ Failed to download image: ${err.message}` });
      }
    }
  }

  // ── Moderation Commands ───────────────────────────────────────────────────

  if (interaction.commandName === "kick") {
    const targetUser = interaction.options.getUser('target');
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
      return interaction.reply({ content: "User not found in this server.", flags: MessageFlags.Ephemeral });
    }

    if (!member.kickable) {
      return interaction.reply({ content: "I cannot kick this user. They might have a higher role than me, or I lack permissions.", flags: MessageFlags.Ephemeral });
    }

    await member.kick(reason);
    await interaction.reply({ content: `👢 Successfully kicked ${targetUser.tag}. Reason: ${reason}` });
  }

  if (interaction.commandName === "ban") {
    const targetUser = interaction.options.getUser('target');
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (member && !member.bannable) {
      return interaction.reply({ content: "I cannot ban this user. They might have a higher role than me, or I lack permissions.", flags: MessageFlags.Ephemeral });
    }

    await interaction.guild.members.ban(targetUser.id, { reason });
    await interaction.reply({ content: `🔨 Successfully banned ${targetUser.tag}. Reason: ${reason}` });
  }

  if (interaction.commandName === "timeout") {
    const targetUser = interaction.options.getUser('target');
    const duration = interaction.options.getInteger('duration');
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
      return interaction.reply({ content: "User not found in this server.", flags: MessageFlags.Ephemeral });
    }

    if (!member.moderatable) {
      return interaction.reply({ content: "I cannot timeout this user. They might have a higher role than me, or I lack permissions.", flags: MessageFlags.Ephemeral });
    }

    const durationMs = duration * 60 * 1000;
    await member.timeout(durationMs, reason);
    await interaction.reply({ content: `⏱️ Successfully timed out ${targetUser.tag} for ${duration} minute(s). Reason: ${reason}` });
  }

  if (interaction.commandName === "unban") {
    const targetId = interaction.options.getString('userid');
    const reason = interaction.options.getString('reason') ?? 'No reason provided';

    try {
      await interaction.guild.members.unban(targetId, reason);
      await interaction.reply({ content: `🕊️ Successfully unbanned user ID ${targetId}. Reason: ${reason}` });
    } catch (err) {
      await interaction.reply({ content: "Failed to unban. Make sure the ID is correct and the user is actually banned.", flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.commandName === "purge") {
    const amount = interaction.options.getInteger('amount');

    try {
      const deleted = await interaction.channel.bulkDelete(amount, true);
      await interaction.reply({ content: `🧹 Successfully deleted ${deleted.size} messages.`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      await interaction.reply({ content: "Failed to delete messages. Note that you can only bulk delete messages that are under 14 days old.", flags: MessageFlags.Ephemeral });
    }
  }
});

// ── Run ─────────────────────────────────────────────────────────────────────

client.login(DISCORD_TOKEN);
