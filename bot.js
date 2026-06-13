import "dotenv/config";
import { Client, GatewayIntentBits, ActivityType, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from "discord.js";
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

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MODELS_DEFAULT = ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemma-4-31b"];
const MODELS_THINKING = ["gemini-3.5-flash", "gemini-2.5-flash"];
const MODELS_SEARCH = ["gemini-2.5-flash"];

const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || "30", 10);
// Max retry attempts when hitting the RPM rate limit (429) per model
const MAX_RETRIES = 2;

if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN in .env");
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");

// ── Gemini Setup ────────────────────────────────────────────────────────────

const genai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SYSTEM_PROMPT = `You are a chill, friendly bot hanging out in a Discord server. \
Your name is Gemini, using Gemini API by Google, while the bot creation is done by Lukas. \
You talk casually — like a witty friend in a group chat. Keep responses concise \
(1-3 sentences usually, unless someone asks for something detailed). \
Throw in emojis occasionally but don't overdo it. \
You can be playful, sarcastic (lightly), and humorous. \
Never be mean-spirited. If someone asks you something you don't know, just say so honestly. \
You speak naturally — no robotic "As an AI language model…" stuff. \
Respond in whatever language the user writes in. \
Use Discord markdown formatting (bold, italic, code blocks, etc.) when it makes sense. \
No Latex. \
Note: Each message from a user will start with their display name, like 'Username: Message content'. Use this to distinguish who you are talking to. \
IMPORTANT: You have the ability to send messages as rich Discord Embeds. \
You can use embed whenever you see fit. \
If your response is long, complex, or contains code blocks/lists, you SHOULD use an embed. \
To use an embed, start your response exactly with the tag [EMBED]. \
If you want a FULLY CUSTOM embed (with titles, fields, custom colors), output the tag [EMBED] followed immediately by a JSON object containing "title", "description", "color" (as integer), "fields" (array of name/value/inline), and "footer" (object with text). \
Otherwise, just write normal text after [EMBED] and it will be wrapped automatically. \
\
NEW ABILITY: You can now choose to just REACT to a message with an emoji! \
If someone says something where a simple reaction is better than a text reply, output EXACTLY the tag [REACT: 🍎] (replace the apple with your chosen emoji). Do not output anything else. \
If you think the message doesn't need any reply or reaction, output EXACTLY [IGNORE].`;

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
  // Trim to max
  while (history.length > MAX_HISTORY) {
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

  for (const model of MODELS_DEFAULT) {
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

async function generateReply(channelId, userText, imageParts = []) {
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

  // 1. Determine task type
  let taskType = "NORMAL";
  if (userText.length > 10) {
    taskType = await classifyPrompt(userText);
  }

  let modelList = MODELS_DEFAULT;
  let useSearch = false;

  if (taskType === "SEARCH") {
    modelList = MODELS_SEARCH;
    useSearch = true;
  } else if (taskType === "THINKING") {
    modelList = MODELS_THINKING;
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
    for (const model of MODELS_DEFAULT) {
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

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const userText = cleanContent(message);
  const userName = message.author.displayName || message.author.username;

  logger.log(`[Message] ${userName} (${message.author.id}) in ${message.channel.id}: ${userText.substring(0, 100)}`);

  // ALWAYS add every message to history so the bot can follow the conversation
  pushHistory(message.channel.id, "user", `${userName}: ${userText}`);

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

  // Process if mentioned, replied to, or a 5% chance for spontaneous interaction
  const shouldProcess = isMentioned || isReplyToBot || Math.random() < 0.35;

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
      imageParts
    );

    let finalReply = reply.trim();

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
      ephemeral: true,
    });
  }

  if (interaction.commandName === "ping") {
    const latency = Math.round(client.ws.ping);
    await interaction.reply({
      content: `🏓 Pong! \`${latency}ms\``,
      ephemeral: true,
    });
  }

  if (interaction.commandName === "kick") {
    const targetUser = interaction.options.getUser('target');
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
      return interaction.reply({ content: "User not found in this server.", ephemeral: true });
    }

    if (!member.kickable) {
      return interaction.reply({ content: "I cannot kick this user. They might have a higher role than me, or I lack permissions.", ephemeral: true });
    }

    await member.kick(reason);
    await interaction.reply({ content: `👢 Successfully kicked ${targetUser.tag}. Reason: ${reason}` });
  }

  if (interaction.commandName === "ban") {
    const targetUser = interaction.options.getUser('target');
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (member && !member.bannable) {
      return interaction.reply({ content: "I cannot ban this user. They might have a higher role than me, or I lack permissions.", ephemeral: true });
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
      return interaction.reply({ content: "User not found in this server.", ephemeral: true });
    }

    if (!member.moderatable) {
      return interaction.reply({ content: "I cannot timeout this user. They might have a higher role than me, or I lack permissions.", ephemeral: true });
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
      await interaction.reply({ content: "Failed to unban. Make sure the ID is correct and the user is actually banned.", ephemeral: true });
    }
  }

  if (interaction.commandName === "purge") {
    const amount = interaction.options.getInteger('amount');

    try {
      const deleted = await interaction.channel.bulkDelete(amount, true);
      await interaction.reply({ content: `🧹 Successfully deleted ${deleted.size} messages.`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: "Failed to delete messages. Note that you can only bulk delete messages that are under 14 days old.", ephemeral: true });
    }
  }
});

// ── Run ─────────────────────────────────────────────────────────────────────

client.login(DISCORD_TOKEN);
