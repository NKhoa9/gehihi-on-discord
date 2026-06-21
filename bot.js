import "dotenv/config";
import { Client, GatewayIntentBits, ActivityType, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } from "discord.js";
import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import { joinAndStartLive, leaveLive } from "./voice.js";

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
  const memoryTagRegex = /\[MEMORY:(ADD|EDIT|DELETE)\s*(?:#(\d+)\s*)?(.+?)\]/gi;
  let match;
  const operations = [];

  while ((match = memoryTagRegex.exec(replyText)) !== null) {
    operations.push({
      action: match[1].toUpperCase(),
      index: match[2] ? parseInt(match[2], 10) : null,
      content: match[3].trim(),
    });
  }

  if (operations.length > 0) {
    const memories = getGuildMemories(guildId);

    for (const op of operations) {
      if (op.action === "ADD") {
        memories.push({ text: op.content, createdAt: new Date().toISOString() });
        logger.log(`[Memory] ADD in guild ${guildId}: "${op.content}"`);
      } else if (op.action === "EDIT" && op.index !== null) {
        const idx = op.index - 1; // 1-indexed for the AI
        if (idx >= 0 && idx < memories.length) {
          logger.log(`[Memory] EDIT #${op.index} in guild ${guildId}: "${memories[idx].text}" -> "${op.content}"`);
          memories[idx].text = op.content;
          memories[idx].updatedAt = new Date().toISOString();
        }
      } else if (op.action === "DELETE" && op.index !== null) {
        const idx = op.index - 1;
        if (idx >= 0 && idx < memories.length) {
          logger.log(`[Memory] DELETE #${op.index} in guild ${guildId}: "${memories[idx].text}"`);
          memories.splice(idx, 1);
        }
      }
    }

    setGuildMemories(guildId, memories);
  }

  // Strip all [MEMORY:...] tags from the visible reply
  return replyText.replace(/\[MEMORY:(?:ADD|EDIT|DELETE)\s*(?:#\d+\s*)?.+?\]/gi, "").trim();
}

function buildMemoryBlock(guildId) {
  const memories = getGuildMemories(guildId);
  if (memories.length === 0) return "";
  const lines = memories.map((m, i) => `#${i + 1}: ${m.text}`).join("\n");
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

/** @type {Map<string, Array<{role: string, text: string}>>} */
const channelHistory = new Map();

function getHistory(channelId) {
  if (!channelHistory.has(channelId)) {
    channelHistory.set(channelId, []);
  }
  return channelHistory.get(channelId);
}

function pushHistory(channelId, role, text) {
  const history = getHistory(channelId);
  history.push({ role, text });
  
  // Trim to max (live-read config)
  const cfg = loadConfig();
  const maxHistory = cfg.max_history || parseInt(process.env.MAX_HISTORY || "30", 10);
  
  while (history.length > maxHistory) {
    history.shift();
  }
}

function clearHistory(channelId) {
  channelHistory.delete(channelId);
}

// ── Attachment Downloading ──────────────────────────────────────────────────

async function downloadAttachment(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer);
}

/**
 * Download Discord attachments and convert them to Gemini inline data parts.
 * @param {import("discord.js").Collection} attachments
 * @returns {Promise<Array<{inlineData: {data: string, mimeType: string}}>>}
 */
async function attachmentsToParts(attachments) {
  const parts = [];

  for (const att of attachments.values()) {
    if (!isSupportedAttachment(att.contentType)) continue;

    try {
      const buffer = await downloadAttachment(att.url);
      const mimeType = att.contentType.split(";")[0].trim();
      parts.push({
        inlineData: {
          data: buffer.toString("base64"),
          mimeType,
        },
      });
    } catch (err) {
      logger.error(`Failed to download attachment ${att.name}:`, err.message);
    }
  }

  return parts;
}

// ── Gemini API Call ─────────────────────────────────────────────────────────

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

async function generateReply(channelId, userText, imageParts = [], guildId = null) {
  // User messages are now pushed to history in messageCreate before calling this

  const history = getHistory(channelId);

  // Build contents array from text-only history
  const contents = history.map((entry) => ({
    role: entry.role,
    parts: [{ text: entry.text }],
  }));

  // Append image parts to the LAST user message (current turn) so Gemini can see them
  if (imageParts.length > 0 && contents.length > 0) {
    const lastMsg = contents[contents.length - 1];
    lastMsg.parts.push(...imageParts);
  }

  // Build system prompt with memories injected
  const memoryBlock = guildId ? buildMemoryBlock(guildId) : "";
  const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT + memoryBlock;

  // 1. Determine task type
  let taskType = "NORMAL";
  if (userText.length > 10) {
    taskType = await classifyPrompt(userText);
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

  // ALWAYS add every message to history so the bot can follow the conversation
  pushHistory(message.channel.id, "user", `${userName} (ID: ${userId}): ${userText}`);

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

    // Download any supported image/pdf attachments
    const imageParts = message.attachments.size > 0
      ? await attachmentsToParts(message.attachments)
      : [];

    const reply = await generateReply(
      message.channel.id,
      userText,
      imageParts,
      message.guildId
    );

    // Process any memory operations from the AI's response (silently)
    let finalReply = reply.trim();
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
      return;
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

            await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false, parse: ['users', 'roles'] } });
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
          for (const chunk of chunks) {
            const embed = new EmbedBuilder()
              .setColor(0x4285F4)
              .setDescription(chunk);
            await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false, parse: ['users', 'roles'] } });
          }
        } else {
          const embed = new EmbedBuilder()
            .setColor(0x4285F4)
            .setDescription(finalReply);
          await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false, parse: ['users', 'roles'] } });
        }
      }
    } else {
      // Plain text for short/casual chats
      await message.reply({ content: finalReply, allowedMentions: { repliedUser: false, parse: ['users', 'roles'] } });
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

  const adminCommands = ["reset_memory", "pause_ai", "config"];
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
