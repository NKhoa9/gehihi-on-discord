import "dotenv/config";
import { Client, GatewayIntentBits, ActivityType, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags, AttachmentBuilder, Collection } from "discord.js";
import fs from "fs";
import path from "path";
import { joinAndStartLive, leaveLive } from "./voice.js";

// -- New Modular Imports --
import { logger } from "./src/utils/logger.js";
import { loadConfig } from "./src/utils/config.js";
import { getGuildMemories, setGuildMemories, processMemoryTags } from "./src/core/memory.js";
import { pushHistory, clearHistory } from "./src/core/history.js";
import { cacheAttachments } from "./src/media/attachments.js";
import { getSavedImagesList, getSavedImage, downloadImageToLib, searchGoogleImage } from "./src/media/images.js";
import { generateImage, generateVideo, generateReply, generateComparisonReply, generatePromptReply } from "./src/ai/router.js";
import { addKey, removeKey, getAllKeys } from "./src/core/keys.js";
import { isChannelDisabled, disableChannel, enableChannel, getDisabledChannels } from "./src/core/channel_control.js";
import { getScheduledTasks, addScheduledTask, removeScheduledTask, toggleScheduledTask, startAllScheduledTasks, scheduleDailyTask, scheduleRandomTask } from "./src/core/scheduler.js";
import {
  resolveModelList,
  loadModelRegistry,
  addModelToSeries,
  removeModelFromSeries,
  moveModelInSeries,
  addModelToTask,
  removeModelFromTask,
  moveModelInTask,
  createCustomSeries,
  deleteCustomSeries,
  createTaskCategory,
  deleteTaskCategory,
  getAllSeriesNames,
  getAllTaskCategories
} from "./src/ai/models.js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) throw new Error("Missing DISCORD_TOKEN in .env");
if (!process.env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");

// ── Lib Directory Setup ─────────────────────────────────────────────────────
const LIB_IMG = path.resolve("lib/img");
const LIB_GEN_IMG = path.resolve("lib/gen_img");
const LIB_GEN_VID = path.resolve("lib/gen_vid");
const LIB_CACHE = path.resolve("lib/cache");
const LIB_CUSTOM_IMG = path.resolve("lib/custom_img");
fs.mkdirSync(LIB_IMG, { recursive: true });
fs.mkdirSync(LIB_GEN_IMG, { recursive: true });
fs.mkdirSync(LIB_GEN_VID, { recursive: true });
fs.mkdirSync(LIB_CACHE, { recursive: true });
fs.mkdirSync(LIB_CUSTOM_IMG, { recursive: true });

// ── Discord Bot ─────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
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
          { name: 'voice_name', value: 'voice_name' },
          { name: 'model_mode', value: 'model_mode' },
          { name: 'logging', value: 'logging' },
          { name: 'debug_logging', value: 'debug_logging' },
          { name: 'show_errors_in_chat', value: 'show_errors_in_chat' },
          { name: 'greet_new_members', value: 'greet_new_members' },
          { name: 'greet_channel_id', value: 'greet_channel_id' }
        ))
    .addStringOption(option => option.setName('value').setDescription('The new value (or "none" to clear)').setRequired(true)),
  new SlashCommandBuilder()
    .setName("config_check")
    .setDescription("[Admin] View the current bot configuration"),
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
    .addStringOption(option => option.setName('name').setDescription('Custom name for the image').setRequired(true))
    .addStringOption(option => option.setName('url').setDescription('Direct URL to the image').setRequired(false))
    .addAttachmentOption(option => option.setName('file').setDescription('Image file upload').setRequired(false)),

  new SlashCommandBuilder()
    .setName("add_custom_img")
    .setDescription("Add an image to the bot's library (rate-limited)")
    .addStringOption(option => option.setName('name').setDescription('Custom name for the image').setRequired(true))
    .addStringOption(option => option.setName('url').setDescription('Direct URL to the image').setRequired(false))
    .addAttachmentOption(option => option.setName('file').setDescription('Image file upload').setRequired(false)),
  new SlashCommandBuilder()
    .setName("logs")
    .setDescription("[Admin] Fetch the latest bot log entries")
    .addIntegerOption(option => option.setName('lines').setDescription('Number of lines to fetch (default 50, max 200)').setRequired(false).setMinValue(1).setMaxValue(200)),
  new SlashCommandBuilder()
    .setName("compare")
    .setDescription("[Admin] Toggle model comparison mode on/off"),
  new SlashCommandBuilder()
    .setName("compare_add")
    .setDescription("[Admin] Add a model to the comparison list")
    .addStringOption(option => option.setName('model').setDescription('Model name to add (e.g. gemini-3.5-flash-lite)').setRequired(true)),
  new SlashCommandBuilder()
    .setName("compare_remove")
    .setDescription("[Admin] Remove a model from the comparison list")
    .addStringOption(option => option.setName('model').setDescription('Model name to remove').setRequired(true)),
  new SlashCommandBuilder()
    .setName("compare_models")
    .setDescription("[Admin] View the current comparison model list and status"),
  new SlashCommandBuilder()
    .setName("set_models")
    .setDescription("[Admin] Set the active model list for a category")
    .addStringOption(option =>
      option.setName('category')
        .setDescription('The category to update (or custom category)')
        .setRequired(true)
        .setAutocomplete(true))
    .addStringOption(option =>
      option.setName('models')
        .setDescription('Comma-separated list of models (e.g. gemini-3.5-flash-lite, gemini-3.1-flash-lite)')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName("series_add")
    .setDescription("[Admin] Add a model to a series in models.json")
    .addStringOption(option =>
      option.setName('series')
        .setDescription('The series to add to (e.g. flash-series or custom)')
        .setRequired(true)
        .setAutocomplete(true))
    .addStringOption(option =>
      option.setName('model')
        .setDescription('The model name (e.g. gemini-3.8-flash)')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('position')
        .setDescription('Insert at 1-based position (optional, default: end)')
        .setRequired(false)
        .setMinValue(1)),
  new SlashCommandBuilder()
    .setName("series_remove")
    .setDescription("[Admin] Remove a model from a series in models.json")
    .addStringOption(option =>
      option.setName('series')
        .setDescription('The series to remove from')
        .setRequired(true)
        .setAutocomplete(true))
    .addStringOption(option =>
      option.setName('model')
        .setDescription('The model name to remove')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName("series_move")
    .setDescription("[Admin] Move a model's priority (up/down/top/bottom) in a series in models.json")
    .addStringOption(option =>
      option.setName('series')
        .setDescription('The series')
        .setRequired(true)
        .setAutocomplete(true))
    .addStringOption(option =>
      option.setName('model')
        .setDescription('The model to move')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('direction')
        .setDescription('Move direction')
        .setRequired(false)
        .addChoices(
          { name: '⬆️ Up (higher priority)', value: 'up' },
          { name: '⬇️ Down (lower priority)', value: 'down' },
          { name: '🔝 Top (highest priority)', value: 'top' },
          { name: '🔚 Bottom (lowest priority)', value: 'bottom' }
        ))
    .addIntegerOption(option =>
      option.setName('position')
        .setDescription('Or specific target position (1 = first)')
        .setRequired(false)
        .setMinValue(1)),
  new SlashCommandBuilder()
    .setName("series_list")
    .setDescription("[Admin] View model series pools in models.json")
    .addStringOption(option =>
      option.setName('series')
        .setDescription('Filter by specific series (optional)')
        .setRequired(false)
        .setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName("model_add")
    .setDescription("[Admin] Add a series or model to a task category in config.json")
    .addStringOption(option =>
      option.setName('category')
        .setDescription('The task category (built-in or custom)')
        .setRequired(true)
        .setAutocomplete(true))
    .addStringOption(option =>
      option.setName('item')
        .setDescription('Series name (e.g. flash-series) or specific model name')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('position')
        .setDescription('Insert at 1-based position (optional, default: end)')
        .setRequired(false)
        .setMinValue(1)),
  new SlashCommandBuilder()
    .setName("model_remove")
    .setDescription("[Admin] Remove a series or model from a task category in config.json")
    .addStringOption(option =>
      option.setName('category')
        .setDescription('The task category (built-in or custom)')
        .setRequired(true)
        .setAutocomplete(true))
    .addStringOption(option =>
      option.setName('item')
        .setDescription('Series or model name to remove')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName("model_move")
    .setDescription("[Admin] Move a series or model's priority (up/down/top/bottom) in config.json")
    .addStringOption(option =>
      option.setName('category')
        .setDescription('The task category (built-in or custom)')
        .setRequired(true)
        .setAutocomplete(true))
    .addStringOption(option =>
      option.setName('item')
        .setDescription('Series or model to move')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('direction')
        .setDescription('Move direction')
        .setRequired(false)
        .addChoices(
          { name: '⬆️ Up (higher priority)', value: 'up' },
          { name: '⬇️ Down (lower priority)', value: 'down' },
          { name: '🔝 Top (highest priority)', value: 'top' },
          { name: '🔚 Bottom (lowest priority)', value: 'bottom' }
        ))
    .addIntegerOption(option =>
      option.setName('position')
        .setDescription('Or specific target position (1 = first)')
        .setRequired(false)
        .setMinValue(1)),
  new SlashCommandBuilder()
    .setName("donate_key")
    .setDescription("Donate your Gemini API key to help the bot when rate limits hit")
    .addStringOption(option =>
      option.setName('key')
        .setDescription('Your Gemini API key')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName("remove_key")
    .setDescription("Remove your previously donated Gemini API key"),
  new SlashCommandBuilder()
    .setName("disable_ai")
    .setDescription("[Admin] Disable AI responses in a specific channel")
    .addChannelOption(option => option.setName('channel').setDescription('The channel to disable AI in (defaults to current)').setRequired(false)),
  new SlashCommandBuilder()
    .setName("enable_ai")
    .setDescription("[Admin] Re-enable AI responses in a previously disabled channel")
    .addChannelOption(option => option.setName('channel').setDescription('The channel to re-enable AI in (defaults to current)').setRequired(false)),
  new SlashCommandBuilder()
    .setName("schedule_add")
    .setDescription("[Admin] Add a scheduled AI message task")
    .addChannelOption(option => option.setName('channel').setDescription('Channel to send messages in (defaults to current)').setRequired(false))
    .addStringOption(option => option.setName('prompt').setDescription('What the AI should talk about').setRequired(false))
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Schedule type')
        .setRequired(false)
        .addChoices(
          { name: 'Random interval', value: 'random' },
          { name: 'Daily at fixed time', value: 'daily' }
        ))
    .addIntegerOption(option => option.setName('interval_min').setDescription('Min minutes between messages (random type, default 60)').setRequired(false).setMinValue(5))
    .addIntegerOption(option => option.setName('interval_max').setDescription('Max minutes between messages (random type, default 480)').setRequired(false).setMinValue(10))
    .addIntegerOption(option => option.setName('hour').setDescription('Hour in UTC (daily type, 0-23)').setRequired(false).setMinValue(0).setMaxValue(23))
    .addIntegerOption(option => option.setName('minute').setDescription('Minute (daily type, 0-59)').setRequired(false).setMinValue(0).setMaxValue(59)),
  new SlashCommandBuilder()
    .setName("schedule_remove")
    .setDescription("[Admin] Remove a scheduled task by ID")
    .addStringOption(option => option.setName('id').setDescription('Task ID to remove').setRequired(true)),
  new SlashCommandBuilder()
    .setName("schedule_toggle")
    .setDescription("[Admin] Enable/disable a scheduled task")
    .addStringOption(option => option.setName('id').setDescription('Task ID to toggle').setRequired(true)),
  new SlashCommandBuilder()
    .setName("schedule_list")
    .setDescription("[Admin] View all scheduled tasks"),
  new SlashCommandBuilder()
    .setName("series_create")
    .setDescription("[Admin] Create a new custom model series in models.json")
    .addStringOption(option => option.setName('name').setDescription('Series name (e.g. my-custom-series)').setRequired(true))
    .addStringOption(option => option.setName('models').setDescription('Comma-separated initial models (optional)').setRequired(false)),
  new SlashCommandBuilder()
    .setName("series_delete")
    .setDescription("[Admin] Delete a custom model series from models.json")
    .addStringOption(option => option.setName('name').setDescription('Series name to delete').setRequired(true)),
  new SlashCommandBuilder()
    .setName("category_create")
    .setDescription("[Admin] Create a new custom task category in config.json")
    .addStringOption(option => option.setName('name').setDescription('Category name (e.g. creative)').setRequired(true))
    .addStringOption(option => option.setName('items').setDescription('Comma-separated initial series/models (optional)').setRequired(false)),
  new SlashCommandBuilder()
    .setName("category_delete")
    .setDescription("[Admin] Delete a custom task category from config.json")
    .addStringOption(option => option.setName('name').setDescription('Category name to delete').setRequired(true)),
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

function cleanContent(message) {
  let text = message.content;
  text = text.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
  // Convert Discord custom emojis <:name:id> and <a:name:id> to readable :name:
  text = text.replace(/<a?:(\w+):\d+>/g, ':$1:');
  return text || "hey";
}

// ── Rate Limiting for /add_custom_img ───────────────────────────────────────
const IMG_RATE_LIMIT = 3;          // max images per window
const IMG_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const IMG_MAX_SIZE = 8 * 1024 * 1024;      // 8MB
const userImgRateMap = new Map(); // userId -> [timestamps]

function checkImgRateLimit(userId) {
  const now = Date.now();
  const timestamps = userImgRateMap.get(userId) || [];
  const valid = timestamps.filter(t => now - t < IMG_RATE_WINDOW_MS);
  userImgRateMap.set(userId, valid);
  if (valid.length >= IMG_RATE_LIMIT) {
    const oldest = valid[0];
    const resetIn = Math.ceil((oldest + IMG_RATE_WINDOW_MS - now) / 60000);
    return { allowed: false, resetIn };
  }
  return { allowed: true };
}

function recordImgUpload(userId) {
  const timestamps = userImgRateMap.get(userId) || [];
  timestamps.push(Date.now());
  userImgRateMap.set(userId, timestamps);
}

// ── Smart Text Splitter ─────────────────────────────────────────────────────
function smartSplit(text, maxLength) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let currentText = text;

  while (currentText.length > maxLength) {
    let splitPos = -1;

    // 1. Try to split by paragraph (\n\n)
    let pMatch = [...currentText.substring(0, maxLength).matchAll(/\n\n/g)];
    if (pMatch.length > 0) splitPos = pMatch[pMatch.length - 1].index;

    // 2. Try single newline
    if (splitPos === -1) {
      let nMatch = [...currentText.substring(0, maxLength).matchAll(/\n/g)];
      if (nMatch.length > 0) splitPos = nMatch[nMatch.length - 1].index;
    }

    // 3. Try sentence boundary (. ! ?)
    if (splitPos === -1) {
      let sMatch = [...currentText.substring(0, maxLength).matchAll(/([.!?])\s/g)];
      if (sMatch.length > 0) splitPos = sMatch[sMatch.length - 1].index + 1;
    }

    // 4. Try word boundary (space)
    if (splitPos === -1) {
      splitPos = currentText.substring(0, maxLength).lastIndexOf(" ");
    }

    // 5. Hard split if no good boundary found
    if (splitPos === -1 || splitPos === 0) {
      splitPos = maxLength;
    }

    chunks.push(currentText.substring(0, splitPos).trim());
    currentText = currentText.substring(splitPos).trim();
  }

  if (currentText.length > 0) {
    chunks.push(currentText);
  }

  return chunks;
}

// ── Events ──────────────────────────────────────────────────────────────────

// ── Scheduled Messages Sender ───────────────────────────────────────────────

async function sendScheduledMessage(channelId, guildId, prompt) {
  try {
    if (isChannelDisabled(channelId)) {
      logger.debug(`[Scheduler] Skipping scheduled message in disabled channel ${channelId}`);
      return;
    }
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;
    const reply = await generatePromptReply(prompt, guildId);
    if (reply && !reply.includes("[IGNORE]")) {
      const chunks = smartSplit(reply, 2000);
      for (const chunk of chunks) {
        await channel.send({ content: chunk, allowedMentions: { parse: ['users', 'roles'] } });
      }
      logger.log(`[Scheduler] Sent scheduled message in ${channelId}`);
    }
  } catch (err) {
    logger.error(`[Scheduler] Failed to send to ${channelId}:`, err.message);
  }
}

client.once("ready", async () => {
  logger.log(`🤖 Logged in as ${client.user.tag}`);
  logger.log(`📡 Connected to ${client.guilds.cache.size} server(s)`);
  client.user.setActivity("your RAMs ✨", { type: ActivityType.Playing });
  await registerCommands();

  // Start all enabled scheduled tasks
  startAllScheduledTasks(sendScheduledMessage);
});

// ── Greet New Members ───────────────────────────────────────────────────────

client.on("guildMemberAdd", async (member) => {
  const cfg = loadConfig();
  if (cfg.greet_new_members === false) return;

  // 1. Check configured greet channel
  let channel = null;
  if (cfg.greet_channel_id) {
    channel = member.guild.channels.cache.get(cfg.greet_channel_id) || await client.channels.fetch(cfg.greet_channel_id).catch(() => null);
  }
  // 2. Fall back to system channel
  if (!channel && member.guild.systemChannel) {
    channel = member.guild.systemChannel;
  }
  // 3. Fall back to first available text channel where bot can send messages
  if (!channel) {
    const me = member.guild.members.me || client.user.id;
    channel = member.guild.channels.cache.find(ch =>
      ch.isTextBased() &&
      ch.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)
    );
  }
  if (!channel) return;

  // Skip if channel is disabled
  if (isChannelDisabled(channel.id, cfg)) return;

  try {
    const prompt = `A new member just joined the Discord server! Their name is "${member.displayName}" (username: ${member.user.username}, ID: ${member.id}). The server name is "${member.guild.name}". Write a short, warm, and fun welcome greeting for them. Keep it casual and friendly, 1-3 sentences max. Don't use any control tags.`;
    const greeting = await generatePromptReply(prompt, member.guild.id);
    if (greeting) {
      await channel.send({ content: greeting, allowedMentions: { parse: ['users'] } });
      logger.log(`[Greet] Welcomed ${member.user.username} in ${member.guild.name}`);
    }
  } catch (err) {
    logger.error(`[Greet] Failed to greet ${member.user.username}:`, err.message);
  }
});

let isAIPaused = false;

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const userText = cleanContent(message);
  const userName = message.author.displayName || message.author.username;
  const userId = message.author.id;
  const timestamp = message.createdAt.toISOString();

  let historyPrefix = `[${timestamp}] ${userName} (ID: ${userId})`;

  if (message.reference) {
    try {
      const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
      const replyAuthor = repliedMsg.author.displayName || repliedMsg.author.username;
      const replyAuthorId = repliedMsg.author.id;
      let replyContent = (repliedMsg.content || "").substring(0, 100);
      replyContent = replyContent.replace(/<a?:(\w+):\d+>/g, ':$1:');
      historyPrefix += ` [replying to ${replyAuthor} (ID: ${replyAuthorId}): "${replyContent}"]`;
    } catch { }
  }

  const cachedAttachments = message.attachments.size > 0
    ? await cacheAttachments(message.attachments)
    : [];

  pushHistory(message.channel.id, "user", `${historyPrefix}: ${userText}`, cachedAttachments);

  if (isAIPaused) return;

  // Check if AI is disabled in this channel
  if (isChannelDisabled(message.channel.id)) return;

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

  const cfg = loadConfig();
  const randomRate = cfg.random_appear_rate ?? 0.05;
  const shouldProcess = isMentioned || isReplyToBot || Math.random() < randomRate;

  if (!shouldProcess) {
    logger.debug(`[Ignore] Random dice failed or not mentioned. userName: ${userName}`);
    return;
  }

  logger.debug(`[Process] Starting generation for message from ${userName}`);
  try {
    await message.channel.sendTyping();

    // ── Model Comparison Mode ───────────────────────────────────────────
    if (cfg.model_compare?.enabled && cfg.model_compare?.models?.length > 0) {
      logger.log(`[Compare] Comparison mode active — querying ${cfg.model_compare.models.length} models`);

      const results = await generateComparisonReply(
        message.channel.id,
        userText,
        message.guildId
      );

      // Color palette for embeds so each model is visually distinct
      const colors = [0x5865F2, 0x57F287, 0xFEE75C, 0xED4245, 0xEB459E, 0x3498DB, 0xE67E22, 0x9B59B6, 0x1ABC9C, 0xE91E63];

      const embeds = results.map((r, i) => {
        const embed = new EmbedBuilder()
          .setColor(colors[i % colors.length])
          .setAuthor({ name: `Model ${i + 1}` })
          .setTitle(`\`${r.model}\``);

        if (r.error) {
          embed.setDescription(`❌ **Error:** ${r.error.substring(0, 4000)}`);
        } else {
          embed.setDescription(r.reply.substring(0, 4096));
        }

        embed.setFooter({ text: `⏱ ${r.durationMs}ms` });
        return embed;
      });

      // Discord allows max 10 embeds per message; send in batches if needed
      const replyOpts = { allowedMentions: { repliedUser: false, parse: ['users', 'roles'] } };
      for (let i = 0; i < embeds.length; i += 10) {
        const batch = embeds.slice(i, i + 10);
        if (i === 0) {
          await message.reply({ ...replyOpts, content: `🔬 **Model Comparison** (${results.length} models)`, embeds: batch });
        } else {
          await message.channel.send({ ...replyOpts, embeds: batch });
        }
      }
      return; // Skip normal reply flow
    }
    // ── End Comparison Mode ─────────────────────────────────────────────

    const replyResult = await generateReply(
      message.channel.id,
      userText,
      message.guildId
    );

    const replyText = typeof replyResult === "object" ? replyResult.text : replyResult;
    const modelUsed = typeof replyResult === "object" ? replyResult.model : null;

    let finalReply = (replyText || "").trim();
    logger.log(`\n[Raw AI Response]:\n${finalReply}\n--------------------------`);

    if (message.guildId) {
      finalReply = processMemoryTags(finalReply, message.guildId);
    }

    logger.log(`[Response] to ${userName} in ${message.channel.id}: ${finalReply}`);

    if (finalReply.includes("[IGNORE]")) return;

    const reactMatch = finalReply.match(/\[REACT:\s*(.+?)\]/);
    if (reactMatch) {
      const emoji = reactMatch[1].trim();
      try { await message.react(emoji); } catch (err) { logger.error("Failed to react:", emoji); }
      finalReply = finalReply.replace(/\[REACT:\s*.+?\]/gi, "").trim();
      if (!finalReply) return;
    }

    const attachments = [];

    // [IMGGEN]
    const genImgMatch = finalReply.match(/\[IMGGEN:\s*(.+?)\]/i);
    if (genImgMatch) {
      const imgPrompt = genImgMatch[1].trim();
      finalReply = finalReply.replace(/\[IMGGEN:\s*.+?\]/gi, "").trim();
      try {
        await message.channel.sendTyping();
        const result = await generateImage(imgPrompt);
        if (result) attachments.push(new AttachmentBuilder(result.filepath, { name: result.filename }));
        else finalReply += "\n\n⚠️ *Image generation failed.*";
      } catch (err) {
        logger.error("[IMGGEN] Error:", err.message);
        finalReply += "\n\n⚠️ *Image generation error.*";
      }
    }

    // [VIDGEN]
    const genVidMatch = finalReply.match(/\[VIDGEN:\s*(.+?)\]/i);
    if (genVidMatch) {
      const vidPrompt = genVidMatch[1].trim();
      finalReply = finalReply.replace(/\[VIDGEN:\s*.+?\]/gi, "").trim();
      try {
        await message.channel.sendTyping();
        const result = await generateVideo(vidPrompt);
        if (result) attachments.push(new AttachmentBuilder(result.filepath, { name: result.filename }));
        else finalReply += "\n\n⚠️ *Video generation failed.*";
      } catch (err) {
        logger.error("[VIDGEN] Error:", err.message);
        finalReply += "\n\n⚠️ *Video generation error.*";
      }
    }

    // [SEARCH_IMG]
    const searchImgRegex = /\[SEARCH_IMG:\s*([^\]]+)\]/gi;
    let searchMatch;
    const searchImgWarnings = [];
    while ((searchMatch = searchImgRegex.exec(finalReply)) !== null) {
      const query = searchMatch[1].trim();
      try {
        const url = await searchGoogleImage(query);
        if (url) {
          const customName = query.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "").substring(0, 50);
          const result = await downloadImageToLib(url, customName);
          attachments.push(new AttachmentBuilder(result.filepath, { name: result.filename }));
        } else {
          searchImgWarnings.push(`⚠️ *Found no images for "${query}"*`);
        }
      } catch (err) {
        searchImgWarnings.push(`⚠️ *Failed to search/save image for "${query}": ${err.message}*`);
      }
    }
    finalReply = finalReply.replace(/\[SEARCH_IMG:\s*[^\]]+\]/gi, "").trim();
    if (searchImgWarnings.length > 0) finalReply += "\n" + searchImgWarnings.join("\n");

    // [SAVE_IMG]
    const saveImgRegex = /\[SAVE_IMG:\s*(https?:\/\/[^\s\|]+)\s*\|\s*([^\]]+)\]/gi;
    let saveMatch;
    const saveImgWarnings = [];
    while ((saveMatch = saveImgRegex.exec(finalReply)) !== null) {
      const url = saveMatch[1].trim();
      const customName = saveMatch[2].trim();
      try {
        await downloadImageToLib(url, customName);
      } catch (err) {
        saveImgWarnings.push(`⚠️ *Failed to save image "${customName}": ${err.message}*`);
      }
    }
    finalReply = finalReply.replace(/\[SAVE_IMG:\s*https?:\/\/[^\s\|]+\s*\|\s*[^\]]+\]/gi, "").trim();
    if (saveImgWarnings.length > 0) finalReply += "\n" + saveImgWarnings.join("\n");

    // [SEND_IMG]
    const sendImgMatch = finalReply.match(/\[SEND_IMG:\s*([^\]]+)\]/i);
    if (sendImgMatch) {
      const imgName = sendImgMatch[1].trim();
      finalReply = finalReply.replace(/\[SEND_IMG:\s*[^\]]+\]/gi, "").trim();
      const savedImgPath = getSavedImage(imgName);
      if (savedImgPath) attachments.push(new AttachmentBuilder(savedImgPath));
    }

    let shouldEmbed = false;
    if (finalReply.includes("[EMBED]")) {
      shouldEmbed = true;
      finalReply = finalReply.replace("[EMBED]", "").trim();
    }
    if (finalReply.includes("⚠️ *(Auto-Fallback")) shouldEmbed = true;

    finalReply = finalReply.replace(/\n\s*\n/g, "\n\n").trim();

    // Task 4: Push the PROCESSED reply to history (after all tag stripping)
    pushHistory(message.channel.id, "model", finalReply);

    const replyOpts = {
      allowedMentions: { repliedUser: false, parse: ['users', 'roles'] },
    };
    if (attachments.length > 0) replyOpts.files = attachments;

    const hasModelFootnote = modelUsed && modelUsed !== "none";

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
                if (f.name && f.value) embed.addFields({ name: String(f.name).substring(0, 256), value: String(f.value).substring(0, 1024), inline: !!f.inline });
              }
            }
            const footerText = embedObj.footer?.text ? String(embedObj.footer.text).substring(0, 2000) : null;
            if (footerText && hasModelFootnote) {
              embed.setFooter({ text: `${footerText} •  ${modelUsed}` });
            } else if (footerText) {
              embed.setFooter({ text: footerText });
            } else if (hasModelFootnote) {
              embed.setFooter({ text: ` ${modelUsed}` });
            }
            await message.reply({ ...replyOpts, embeds: [embed] });
            isParsedJson = true;
          }
        }
      } catch (e) { }

      if (!isParsedJson) {
        if (finalReply.length > 4096) {
          const chunks = finalReply.match(/[\s\S]{1,4096}/g) || [finalReply];
          for (let i = 0; i < chunks.length; i++) {
            const embed = new EmbedBuilder().setColor(0x4285F4).setDescription(chunks[i]);
            if (hasModelFootnote && i === chunks.length - 1) {
              embed.setFooter({ text: ` ${modelUsed}` });
            }
            const opts = i === 0 ? { ...replyOpts, embeds: [embed] } : { embeds: [embed], allowedMentions: replyOpts.allowedMentions };
            await message.reply(opts);
          }
        } else {
          const embed = new EmbedBuilder().setColor(0x4285F4).setDescription(finalReply);
          if (hasModelFootnote) embed.setFooter({ text: ` ${modelUsed}` });
          await message.reply({ ...replyOpts, embeds: [embed] });
        }
      }
    } else {
      if (hasModelFootnote && finalReply) {
        finalReply += `\n-#  ${modelUsed}`;
      }
      if (!finalReply && attachments.length > 0) {
        if (hasModelFootnote) {
          await message.reply({ ...replyOpts, content: `-#  ${modelUsed}` });
        } else {
          await message.reply(replyOpts);
        }
      } else if (finalReply.length > 2000) {
        // Chunk long non-embed replies smartly to respect Discord's 2000 char limit
        const chunks = smartSplit(finalReply, 2000);
        for (let i = 0; i < chunks.length; i++) {
          const opts = i === 0
            ? { ...replyOpts, content: chunks[i] }
            : { content: chunks[i], allowedMentions: replyOpts.allowedMentions };
          await message.reply(opts);
        }
      } else {
        await message.reply({ ...replyOpts, content: finalReply });
      }
    }
  } catch (err) {
    logger.error("Error handling message:", err);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isAutocomplete()) {
    try {
      const focusedOption = interaction.options.getFocused(true);
      if (focusedOption.name === "series") {
        const list = getAllSeriesNames();
        const filtered = list.filter(s => s.toLowerCase().includes(focusedOption.value.toLowerCase())).slice(0, 25);
        return await interaction.respond(filtered.map(s => ({ name: s, value: s })));
      }
      if (focusedOption.name === "category") {
        const list = getAllTaskCategories();
        const filtered = list.filter(c => c.toLowerCase().includes(focusedOption.value.toLowerCase())).slice(0, 25);
        return await interaction.respond(filtered.map(c => ({ name: c, value: c })));
      }
    } catch (err) {
      logger.error("[Autocomplete] Error:", err.message);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  logger.log(`[Command] ${interaction.user.tag} used /${interaction.commandName}`);

  if (interaction.commandName === "join") await joinAndStartLive(interaction, logger);
  if (interaction.commandName === "leave") await leaveLive(interaction);

  if (interaction.commandName === "clear") {
    clearHistory(interaction.channelId);
    await interaction.reply({ content: "🧹 Memory wiped for this channel! Fresh start.", flags: MessageFlags.Ephemeral });
  }

  if (interaction.commandName === "ping") {
    const latency = Math.round(client.ws.ping);
    await interaction.reply({ content: `🏓 Pong! \`${latency}ms\``, flags: MessageFlags.Ephemeral });
  }

  if (interaction.commandName === "memories") {
    const memories = getGuildMemories(interaction.guildId);
    if (memories.length === 0) {
      await interaction.reply({ content: "🧠 No memories saved for this server yet!", flags: MessageFlags.Ephemeral });
    } else {
      const lines = memories.map((m, i) => `**#${i + 1}**: ${m.text}`).join("\n");
      const embed = new EmbedBuilder().setColor(0x9B59B6).setTitle("🧠 Bot Memories").setDescription(lines.substring(0, 4096)).setFooter({ text: `${memories.length} memory(s) saved` });
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  }

  const adminCommands = [
    "reset_memory", "pause_ai", "config", "config_check", "add_image", "logs",
    "compare", "compare_add", "compare_remove", "compare_models", "set_models",
    "series_add", "series_remove", "series_move", "series_list",
    "model_add", "model_remove", "model_move",
    "disable_ai", "enable_ai",
    "schedule_add", "schedule_remove", "schedule_toggle", "schedule_list",
    "series_create", "series_delete", "category_create", "category_delete"
  ];
  if (adminCommands.includes(interaction.commandName)) {
    const adminEnv = process.env.ADMINS || "";
    const admins = adminEnv.split(",").map(id => id.trim()).filter(id => id);

    if (admins.length === 0) return interaction.reply({ content: "❌ No admins are configured! Please add your User ID to the `ADMINS` variable in `.env` (comma separated).", flags: MessageFlags.Ephemeral });
    if (!admins.includes(interaction.user.id)) return interaction.reply({ content: "❌ You are not on the bot's admin whitelist.", flags: MessageFlags.Ephemeral });

    if (interaction.commandName === "reset_memory") {
      setGuildMemories(interaction.guildId, []);
      return interaction.reply({ content: "🧠 All AI memories for this server have been completely wiped by an admin." });
    }

    if (interaction.commandName === "pause_ai") {
      isAIPaused = !isAIPaused;
      return interaction.reply({ content: isAIPaused ? "⏸️ AI has been PAUSED globally." : "▶️ AI has been UNPAUSED." });
    }

    if (interaction.commandName === "config") {
      const setting = interaction.options.getString('setting');
      const valueStr = interaction.options.getString('value');
      let newValue = valueStr;
      if (setting === "max_history" || setting === "silence_duration_ms") {
        newValue = parseInt(valueStr, 10);
        if (isNaN(newValue)) return interaction.reply({ content: "❌ Value must be a valid integer.", flags: MessageFlags.Ephemeral });
      } else if (setting === "random_appear_rate") {
        newValue = parseFloat(valueStr);
        if (isNaN(newValue)) return interaction.reply({ content: "❌ Value must be a valid number (e.g. 0.1).", flags: MessageFlags.Ephemeral });
      } else if (setting === "logging" || setting === "debug_logging" || setting === "show_errors_in_chat" || setting === "greet_new_members") {
        const lower = valueStr.toLowerCase();
        if (lower === "true" || lower === "on" || lower === "1") newValue = true;
        else if (lower === "false" || lower === "off" || lower === "0") newValue = false;
        else return interaction.reply({ content: "❌ Value must be `true`/`on` or `false`/`off`.", flags: MessageFlags.Ephemeral });
      } else if (setting === "greet_channel_id") {
        if (valueStr.toLowerCase() === "none" || valueStr.toLowerCase() === "clear") {
          newValue = null;
        } else {
          newValue = valueStr.replace(/[<#>]/g, "").trim();
        }
      } else if (setting === "model_mode") {
        const lower = valueStr.toLowerCase();
        if (lower !== "flash" && lower !== "flash-lite") {
          return interaction.reply({ content: "❌ Value for `model_mode` must be `flash` or `flash-lite`.", flags: MessageFlags.Ephemeral });
        }
        newValue = lower;
      }

      const currentConfig = loadConfig();
      currentConfig[setting] = newValue;
      try {
        fs.writeFileSync("config.json", JSON.stringify(currentConfig, null, 2), "utf-8");
        return interaction.reply({ content: `✅ Config updated: \`${setting}\` is now \`${newValue}\`.`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to save config: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    if (interaction.commandName === "add_image") {
      const url = interaction.options.getString('url');
      const attachment = interaction.options.getAttachment('file');
      const customName = interaction.options.getString('name');
      const targetUrl = attachment ? attachment.url : url;

      if (!targetUrl) return interaction.reply({ content: "❌ You must provide either a URL or an attachment.", flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const { filename } = await downloadImageToLib(targetUrl, customName);
        const totalImages = getSavedImagesList().length;
        return interaction.editReply({ content: `✅ Image saved as \`${filename}\`. Library now has **${totalImages}** image(s).` });
      } catch (err) {
        return interaction.editReply({ content: `❌ Failed to download image: ${err.message}` });
      }
    }

    if (interaction.commandName === "config_check") {
      const currentConfig = loadConfig();
      const embed = new EmbedBuilder()
        .setColor(0x2F3136)
        .setTitle("⚙️ Current Bot Configuration")
        .addFields(
          { name: "📝 Logging", value: `\`${currentConfig.logging !== false ? "ON" : "OFF"}\``, inline: true },
          { name: "🐛 Debug Logs", value: `\`${currentConfig.debug_logging ? "ON" : "OFF"}\``, inline: true },
          { name: "⚠️ Chat Errors", value: `\`${currentConfig.show_errors_in_chat ? "SHOW" : "HIDE"}\``, inline: true },
          { name: "📜 Max History", value: `\`${currentConfig.max_history ?? "N/A"}\``, inline: true },
          { name: "🎲 Random Rate", value: `\`${currentConfig.random_appear_rate ?? "N/A"}\``, inline: true },
          { name: "🔇 Silence MS", value: `\`${currentConfig.silence_duration_ms ?? "N/A"}\``, inline: true },
          { name: "🎙️ Voice Name", value: `\`${currentConfig.voice_name ?? "N/A"}\``, inline: true },
          { name: "⚡ Model Mode", value: `\`${currentConfig.model_mode || "flash-lite"}\``, inline: true },
          { name: "⏸️ AI Paused", value: `\`${isAIPaused ? "YES" : "NO"}\``, inline: true },
        );

      const greetStatus = currentConfig.greet_new_members !== false ? "✅ ON" : "❌ OFF";
      const greetChannel = currentConfig.greet_channel_id ? ` in <#${currentConfig.greet_channel_id}>` : " (system channel)";
      embed.addFields({ name: "👋 Member Greeting", value: `${greetStatus}${greetChannel}`, inline: true });

      const models = currentConfig.models || {};
      const registry = loadModelRegistry();
      const modelSections = [
        ["🔍 Classifier Models (always flash-lite)", models.classifier || ["flash-lite-series"]],
        ["🤖 Default Models", models.default],
        ["🔍 Search Models", models.search],
        ["🧠 Thinking Models", models.thinking],
        ["🎤 Live Models", models.live],
        ["🖼️ Image Gen Models", models.image_gen],
        ["🎬 Video Gen Models", models.video_gen],
      ];
      for (const [label, list] of modelSections) {
        if (Array.isArray(list) && list.length > 0) {
          const resolved = resolveModelList(list, registry);
          const rawDisplay = list.map(m => registry[m] ? `📁 \`${m}\`` : `\`${m}\``).join(", ");
          const resolvedDisplay = resolved.map(m => `\`${m}\``).join(", ");
          const valueText = (rawDisplay !== resolvedDisplay && list.some(m => registry[m]))
            ? `${rawDisplay}\n└ *Active: ${resolvedDisplay}*`
            : resolvedDisplay;
          embed.addFields({ name: label, value: valueText, inline: false });
        }
      }

      // Custom task categories in config.models
      const standardKeys = ["classifier", "default", "search", "thinking", "live", "image_gen", "video_gen"];
      const customCats = Object.entries(models).filter(([k]) => !standardKeys.includes(k));
      for (const [catName, list] of customCats) {
        if (Array.isArray(list) && list.length > 0) {
          const resolved = resolveModelList(list, registry);
          const rawDisplay = list.map(m => registry[m] ? `📁 \`${m}\`` : `\`${m}\``).join(", ");
          const resolvedDisplay = resolved.map(m => `\`${m}\``).join(", ");
          const valueText = (rawDisplay !== resolvedDisplay && list.some(m => registry[m]))
            ? `${rawDisplay}\n└ *Active: ${resolvedDisplay}*`
            : resolvedDisplay;
          embed.addFields({ name: `✨ Custom Task: [${catName}]`, value: valueText, inline: false });
        } else {
          embed.addFields({ name: `✨ Custom Task: [${catName}]`, value: "*(empty)*", inline: false });
        }
      }

      // Custom series in models.json
      const standardSeries = ["flash-lite-series", "flash-series", "gemma-series", "live-series", "image-gen-series", "video-gen-series"];
      const customSeries = Object.keys(registry).filter(s => !standardSeries.includes(s));
      if (customSeries.length > 0) {
        const seriesInfo = customSeries.map(s => {
          const count = registry[s]?.length || 0;
          return `• \`${s}\` (${count} model${count !== 1 ? 's' : ''})`;
        }).join("\n");
        embed.addFields({ name: "📦 Custom Series Pools", value: seriesInfo, inline: false });
      }

      // Disabled channels
      const disabledChs = getDisabledChannels(currentConfig);
      const disabledChsVal = disabledChs.length > 0
        ? disabledChs.map(id => `<#${id}>`).join(", ")
        : "*None (AI active everywhere)*";
      embed.addFields({ name: "🔇 Disabled Channels", value: disabledChsVal, inline: false });

      // Scheduled tasks
      const schedTasks = getScheduledTasks(currentConfig);
      const activeSchedCount = schedTasks.filter(t => t.enabled).length;
      embed.addFields({
        name: "⏰ Scheduled Tasks",
        value: `${schedTasks.length} task(s) (${activeSchedCount} active) — Use \`/schedule_list\` to view`,
        inline: false
      });

      // Show comparison config
      const compare = currentConfig.model_compare || { enabled: false, models: [] };
      const compareStatus = compare.enabled ? "✅ ON" : "❌ OFF";
      const compareList = compare.models.length > 0 ? compare.models.map(m => `\`${m}\``).join(", ") : "*(none)*";
      embed.addFields({ name: "🔬 Model Compare", value: `**Status:** ${compareStatus}\n**Models:** ${compareList}`, inline: false });

      const donatedKeysList = getAllKeys();
      const keysValue = donatedKeysList.length > 0
        ? `\`${donatedKeysList.length}\` key(s) (${donatedKeysList.map(k => k.username || k.userId).join(", ")})`
        : "`0` keys";
      embed.addFields({ name: "🔑 Donated Keys", value: keysValue, inline: false });

      const imgCount = getSavedImagesList().length;
      embed.setFooter({ text: `Image library: ${imgCount} image(s) | Config loaded from config.json` });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "logs") {
      const lineCount = interaction.options.getInteger('lines') || 50;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const logContent = fs.readFileSync("bot.log", "utf-8");
        const allLines = logContent.split("\n");
        const tail = allLines.slice(-lineCount).join("\n");
        if (tail.length <= 4000) {
          const embed = new EmbedBuilder()
            .setColor(0x2F3136)
            .setTitle(`📋 Last ${lineCount} log lines`)
            .setDescription(`\`\`\`\n${tail}\n\`\`\``)
            .setFooter({ text: `Total log lines: ${allLines.length}` });
          return interaction.editReply({ embeds: [embed] });
        } else {
          const buf = Buffer.from(tail, "utf-8");
          const attachment = new AttachmentBuilder(buf, { name: "bot_log_tail.txt" });
          return interaction.editReply({ content: `📋 Last ${lineCount} log lines (too long for embed, sent as file):`, files: [attachment] });
        }
      } catch (err) {
        return interaction.editReply({ content: `❌ Failed to read log file: ${err.message}` });
      }
    }

    // ── Model Comparison Commands ──────────────────────────────────────────
    if (interaction.commandName === "compare") {
      const currentConfig = loadConfig();
      const compare = currentConfig.model_compare || { enabled: false, models: [] };
      compare.enabled = !compare.enabled;
      currentConfig.model_compare = compare;
      try {
        fs.writeFileSync("config.json", JSON.stringify(currentConfig, null, 2), "utf-8");
        const status = compare.enabled ? "✅ **ON**" : "❌ **OFF**";
        const modelList = compare.models.length > 0 ? compare.models.map(m => `\`${m}\``).join(", ") : "*(none)*";
        return interaction.reply({
          content: `🔬 Model comparison mode: ${status}\n📋 Models: ${modelList}`,
          flags: MessageFlags.Ephemeral
        });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to save config: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    if (interaction.commandName === "compare_add") {
      const model = interaction.options.getString('model');
      const currentConfig = loadConfig();
      const compare = currentConfig.model_compare || { enabled: false, models: [] };
      if (compare.models.includes(model)) {
        return interaction.reply({ content: `⚠️ \`${model}\` is already in the comparison list.`, flags: MessageFlags.Ephemeral });
      }
      compare.models.push(model);
      currentConfig.model_compare = compare;
      try {
        fs.writeFileSync("config.json", JSON.stringify(currentConfig, null, 2), "utf-8");
        return interaction.reply({
          content: `✅ Added \`${model}\` to comparison list.\n📋 Current models (${compare.models.length}): ${compare.models.map(m => `\`${m}\``).join(", ")}`,
          flags: MessageFlags.Ephemeral
        });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to save config: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    if (interaction.commandName === "compare_remove") {
      const model = interaction.options.getString('model');
      const currentConfig = loadConfig();
      const compare = currentConfig.model_compare || { enabled: false, models: [] };
      const idx = compare.models.indexOf(model);
      if (idx === -1) {
        return interaction.reply({ content: `⚠️ \`${model}\` is not in the comparison list.\n📋 Current models: ${compare.models.map(m => `\`${m}\``).join(", ") || "*(none)*"}`, flags: MessageFlags.Ephemeral });
      }
      compare.models.splice(idx, 1);
      currentConfig.model_compare = compare;
      try {
        fs.writeFileSync("config.json", JSON.stringify(currentConfig, null, 2), "utf-8");
        return interaction.reply({
          content: `🗑️ Removed \`${model}\` from comparison list.\n📋 Current models (${compare.models.length}): ${compare.models.map(m => `\`${m}\``).join(", ") || "*(none)*"}`,
          flags: MessageFlags.Ephemeral
        });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to save config: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    if (interaction.commandName === "compare_models") {
      const currentConfig = loadConfig();
      const compare = currentConfig.model_compare || { enabled: false, models: [] };
      const embed = new EmbedBuilder()
        .setColor(compare.enabled ? 0x57F287 : 0xED4245)
        .setTitle("🔬 Model Comparison Config")
        .addFields(
          { name: "Status", value: compare.enabled ? "✅ Enabled" : "❌ Disabled", inline: true },
          { name: "Model Count", value: `${compare.models.length}`, inline: true },
        );
      if (compare.models.length > 0) {
        embed.addFields({ name: "Models", value: compare.models.map((m, i) => `**${i + 1}.** \`${m}\``).join("\n"), inline: false });
      } else {
        embed.addFields({ name: "Models", value: "*(none configured — use /compare_add)*", inline: false });
      }
      embed.setFooter({ text: "Use /compare to toggle • /compare_add & /compare_remove to manage models" });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "set_models") {
      const category = interaction.options.getString('category');
      const modelsStr = interaction.options.getString('models');
      const modelList = modelsStr.split(",").map(m => m.trim()).filter(m => m.length > 0);
      if (modelList.length === 0) {
        return interaction.reply({ content: "❌ You must provide at least one valid model name or series.", flags: MessageFlags.Ephemeral });
      }
      const currentConfig = loadConfig();
      if (!currentConfig.models) currentConfig.models = {};
      currentConfig.models[category] = modelList;
      try {
        fs.writeFileSync("config.json", JSON.stringify(currentConfig, null, 2), "utf-8");
        const resolved = resolveModelList(modelList);
        const resolvedInfo = (resolved.length > 0 && (resolved.length !== modelList.length || resolved[0] !== modelList[0]))
          ? `\n\n📋 **Resolved Models (${resolved.length}):**\n${resolved.map(m => `• \`${m}\``).join("\n")}`
          : "";
        return interaction.reply({
          content: `✅ Updated \`${category}\` models:\n${modelList.map(m => `• \`${m}\``).join("\n")}${resolvedInfo}`,
          flags: MessageFlags.Ephemeral
        });
      } catch (err) {
        return interaction.reply({ content: `❌ Failed to save config: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
    }

    // ── Series Management Commands (models.json) ───────────────────────────
    if (interaction.commandName === "series_add") {
      const series = interaction.options.getString('series');
      const model = interaction.options.getString('model').trim();
      const position = interaction.options.getInteger('position');
      const res = addModelToSeries(series, model, position);
      if (!res.success) {
        if (res.error === "already_exists") {
          return interaction.reply({ content: `⚠️ \`${model}\` is already in \`${series}\`.\n📋 Current list: ${res.list.map((m, i) => `**${i + 1}.** \`${m}\``).join(", ")}`, flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: `❌ Failed to add model: ${res.error}`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({
        content: `✅ Added \`${model}\` to series \`${series}\`! (${res.list.length} models)\n${res.list.map((m, i) => `**${i + 1}.** \`${m}\``).join("\n")}`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "series_remove") {
      const series = interaction.options.getString('series');
      const model = interaction.options.getString('model').trim();
      const res = removeModelFromSeries(series, model);
      if (!res.success) {
        if (res.error === "model_not_found") {
          return interaction.reply({ content: `⚠️ \`${model}\` is not in \`${series}\`.\n📋 Current list: ${res.list?.map(m => `\`${m}\``).join(", ") || "*(empty)*"}`, flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: `❌ Failed to remove model: ${res.error}`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({
        content: `🗑️ Removed \`${model}\` from series \`${series}\`.\n📋 Remaining (${res.list.length}):\n${res.list.map((m, i) => `**${i + 1}.** \`${m}\``).join("\n") || "*(empty)*"}`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "series_move") {
      const series = interaction.options.getString('series');
      const model = interaction.options.getString('model').trim();
      const direction = interaction.options.getString('direction');
      const position = interaction.options.getInteger('position');

      if (!direction && !position) {
        return interaction.reply({ content: "❌ You must specify either `direction` (up/down/top/bottom) or a `position` number.", flags: MessageFlags.Ephemeral });
      }

      const res = moveModelInSeries(series, model, { direction, position });
      if (!res.success) {
        if (res.error === "not_found") {
          return interaction.reply({ content: `⚠️ \`${model}\` is not in \`${series}\`.\n📋 Current list: ${res.list?.map(m => `\`${m}\``).join(", ") || "*(empty)*"}`, flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: `❌ Failed to move model: ${res.error}`, flags: MessageFlags.Ephemeral });
      }

      if (res.unchanged) {
        return interaction.reply({ content: `ℹ️ \`${model}\` is already at position **#${res.newIndex + 1}** in \`${series}\`.`, flags: MessageFlags.Ephemeral });
      }

      return interaction.reply({
        content: `🔄 Moved \`${model}\` in \`${series}\`: **#${res.oldIndex + 1}** ➔ **#${res.newIndex + 1}**\n\n📋 **New Priority Order:**\n${res.list.map((m, i) => `**${i + 1}.** \`${m}\``).join("\n")}`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "series_list") {
      const targetSeries = interaction.options.getString('series');
      const registry = loadModelRegistry();
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("📁 Model Series Registry (`models.json`)");

      if (targetSeries) {
        const list = registry[targetSeries] || [];
        embed.setDescription(`Showing models in \`${targetSeries}\` (${list.length}):`);
        if (list.length > 0) {
          embed.addFields({ name: targetSeries, value: list.map((m, i) => `**${i + 1}.** \`${m}\``).join("\n"), inline: false });
        } else {
          embed.addFields({ name: targetSeries, value: "*(empty series)*", inline: false });
        }
      } else {
        const keys = Object.keys(registry);
        embed.setDescription(`Found **${keys.length}** series in \`models.json\`:`);
        for (const k of keys) {
          const list = registry[k] || [];
          const text = list.length > 0 ? list.map((m, i) => `**${i + 1}.** \`${m}\``).join("\n") : "*(empty)*";
          embed.addFields({ name: `📁 ${k} (${list.length})`, value: text, inline: false });
        }
      }
      embed.setFooter({ text: "Use /series_add, /series_remove, /series_move to manage series" });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ── Task Models Management Commands (config.json) ──────────────────────
    if (interaction.commandName === "model_add") {
      const category = interaction.options.getString('category');
      const item = interaction.options.getString('item').trim();
      const position = interaction.options.getInteger('position');
      const res = addModelToTask(category, item, position);
      if (!res.success) {
        if (res.error === "already_exists") {
          return interaction.reply({ content: `⚠️ \`${item}\` is already in category \`${category}\`.\n📋 Current list: ${res.list.map((m, i) => `**${i + 1}.** \`${m}\``).join(", ")}`, flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: `❌ Failed to add to task: ${res.error}`, flags: MessageFlags.Ephemeral });
      }

      const resolved = resolveModelList(res.list);
      return interaction.reply({
        content: `✅ Added \`${item}\` to task \`${category}\`!\n\n📋 **Configured (${res.list.length}):**\n${res.list.map((m, i) => `**${i + 1}.** \`${m}\``).join("\n")}\n\n🔍 **Resolved Models (${resolved.length}):**\n${resolved.map((m, i) => `• \`${m}\``).join("\n")}`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "model_remove") {
      const category = interaction.options.getString('category');
      const item = interaction.options.getString('item').trim();
      const res = removeModelFromTask(category, item);
      if (!res.success) {
        if (res.error === "item_not_found") {
          return interaction.reply({ content: `⚠️ \`${item}\` is not in category \`${category}\`.\n📋 Current list: ${res.list?.map(m => `\`${m}\``).join(", ") || "*(empty)*"}`, flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: `❌ Failed to remove from task: ${res.error}`, flags: MessageFlags.Ephemeral });
      }

      const resolved = resolveModelList(res.list);
      return interaction.reply({
        content: `🗑️ Removed \`${item}\` from task \`${category}\`.\n\n📋 **Remaining (${res.list.length}):**\n${res.list.map((m, i) => `**${i + 1}.** \`${m}\``).join("\n") || "*(empty)*"}\n\n🔍 **Resolved Models (${resolved.length}):**\n${resolved.map((m, i) => `• \`${m}\``).join("\n") || "*(none)*"}`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "model_move") {
      const category = interaction.options.getString('category');
      const item = interaction.options.getString('item').trim();
      const direction = interaction.options.getString('direction');
      const position = interaction.options.getInteger('position');

      if (!direction && !position) {
        return interaction.reply({ content: "❌ You must specify either `direction` (up/down/top/bottom) or a `position` number.", flags: MessageFlags.Ephemeral });
      }

      const res = moveModelInTask(category, item, { direction, position });
      if (!res.success) {
        if (res.error === "not_found") {
          return interaction.reply({ content: `⚠️ \`${item}\` is not in category \`${category}\`.\n📋 Current list: ${res.list?.map(m => `\`${m}\``).join(", ") || "*(empty)*"}`, flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: `❌ Failed to move in task: ${res.error}`, flags: MessageFlags.Ephemeral });
      }

      if (res.unchanged) {
        return interaction.reply({ content: `ℹ️ \`${item}\` is already at position **#${res.newIndex + 1}** in task \`${category}\`.`, flags: MessageFlags.Ephemeral });
      }

      const resolved = resolveModelList(res.list);
      return interaction.reply({
        content: `🔄 Moved \`${item}\` in task \`${category}\`: **#${res.oldIndex + 1}** ➔ **#${res.newIndex + 1}**\n\n📋 **New Configured Order:**\n${res.list.map((m, i) => `**${i + 1}.** \`${m}\``).join("\n")}\n\n🔍 **Resolved Priority Order:**\n${resolved.map((m, i) => `**${i + 1}.** \`${m}\``).join("\n")}`,
        flags: MessageFlags.Ephemeral
      });
    }
    // ── Channel Control Commands ──────────────────────────────────────────
    if (interaction.commandName === "disable_ai") {
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      const res = disableChannel(channel.id);
      if (res.alreadyDisabled) {
        return interaction.reply({ content: `ℹ️ AI is already disabled in <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: `🔇 AI responses have been **disabled** in <#${channel.id}>.\nUse \`/enable_ai\` to re-enable.`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "enable_ai") {
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      const res = enableChannel(channel.id);
      if (!res.wasDisabled) {
        return interaction.reply({ content: `ℹ️ AI was not disabled in <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: `🔊 AI responses have been **re-enabled** in <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
    }

    // ── Scheduled Tasks Commands ─────────────────────────────────────────
    if (interaction.commandName === "schedule_add") {
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      const prompt = interaction.options.getString('prompt') || "Send something fun or interesting to the chat";
      const type = interaction.options.getString('type') || "random";
      const intervalMin = interaction.options.getInteger('interval_min') || 60;
      const intervalMax = interaction.options.getInteger('interval_max') || 480;
      const hour = interaction.options.getInteger('hour');
      const minute = interaction.options.getInteger('minute') ?? 0;

      if (type === "daily" && hour == null) {
        return interaction.reply({ content: "❌ Daily schedule requires the `hour` option (0-23 UTC).", flags: MessageFlags.Ephemeral });
      }
      if (type === "random" && intervalMin >= intervalMax) {
        return interaction.reply({ content: "❌ `interval_min` must be less than `interval_max`.", flags: MessageFlags.Ephemeral });
      }

      const task = addScheduledTask({
        channelId: channel.id,
        guildId: interaction.guildId,
        prompt,
        type,
        intervalMin,
        intervalMax,
        fixedHour: hour,
        fixedMinute: minute,
        createdBy: interaction.user.id,
      });

      // Start it immediately
      if (type === "daily") {
        scheduleDailyTask(task, sendScheduledMessage);
      } else {
        scheduleRandomTask(task, sendScheduledMessage);
      }

      const scheduleInfo = type === "daily"
        ? `Daily at **${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC**`
        : `Random every **${intervalMin}–${intervalMax} min**`;

      return interaction.reply({
        content: `✅ Scheduled task created!\n🆔 \`${task.id}\`\n📋 Channel: <#${channel.id}>\n⏰ ${scheduleInfo}\n💬 Prompt: *${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}*`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "schedule_remove") {
      const id = interaction.options.getString('id');
      const res = removeScheduledTask(id);
      if (!res.success) {
        return interaction.reply({ content: `❌ Task \`${id}\` not found.`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: `🗑️ Removed scheduled task \`${id}\`.`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "schedule_toggle") {
      const id = interaction.options.getString('id');
      const res = toggleScheduledTask(id);
      if (!res.success) {
        return interaction.reply({ content: `❌ Task \`${id}\` not found.`, flags: MessageFlags.Ephemeral });
      }
      const status = res.task.enabled ? "▶️ **Enabled**" : "⏸️ **Disabled**";

      // If re-enabled, restart the timer
      if (res.task.enabled) {
        if (res.task.type === "daily") {
          scheduleDailyTask(res.task, sendScheduledMessage);
        } else {
          scheduleRandomTask(res.task, sendScheduledMessage);
        }
      }

      return interaction.reply({ content: `⏰ Task \`${id}\`: ${status}`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "schedule_list") {
      const tasks = getScheduledTasks();
      if (tasks.length === 0) {
        return interaction.reply({ content: "📋 No scheduled tasks configured.", flags: MessageFlags.Ephemeral });
      }

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("⏰ Scheduled Tasks")
        .setDescription(`${tasks.length} task(s) configured`);

      for (const t of tasks.slice(0, 25)) {
        const status = t.enabled ? "✅" : "⏸️";
        const schedule = t.type === "daily"
          ? `Daily at ${String(t.fixed_hour ?? 0).padStart(2, '0')}:${String(t.fixed_minute ?? 0).padStart(2, '0')} UTC`
          : `Random ${t.interval_min || 60}–${t.interval_max || 480} min`;
        embed.addFields({
          name: `${status} \`${t.id}\` — <#${t.channel_id}>`,
          value: `${schedule}\n💬 *${(t.prompt || "").substring(0, 80)}${(t.prompt || "").length > 80 ? "..." : ""}*`,
          inline: false
        });
      }
      embed.setFooter({ text: "Use /schedule_add, /schedule_remove, /schedule_toggle" });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // ── Custom Series & Category Commands ────────────────────────────────
    if (interaction.commandName === "series_create") {
      const name = interaction.options.getString('name');
      const modelsStr = interaction.options.getString('models');
      const initialModels = modelsStr ? modelsStr.split(",").map(m => m.trim()).filter(Boolean) : [];
      const res = createCustomSeries(name, initialModels);
      if (!res.success) {
        if (res.error === "already_exists") {
          return interaction.reply({ content: `⚠️ Series \`${name}\` already exists.`, flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: `❌ Failed: ${res.error}`, flags: MessageFlags.Ephemeral });
      }
      const listStr = res.list.length > 0 ? res.list.map(m => `\`${m}\``).join(", ") : "*(empty)*";
      return interaction.reply({
        content: `✅ Created series \`${res.name}\`!\n📋 Models: ${listStr}\n\nYou can now use it in task categories with \`/model_add\`, or trigger it in chat with \`[${res.name}]\`.`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "series_delete") {
      const name = interaction.options.getString('name');
      const res = deleteCustomSeries(name);
      if (!res.success) {
        return interaction.reply({ content: `❌ Series \`${name}\` not found.`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: `🗑️ Deleted series \`${res.name}\`.`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "category_create") {
      const name = interaction.options.getString('name');
      const itemsStr = interaction.options.getString('items');
      const initialItems = itemsStr ? itemsStr.split(",").map(i => i.trim()).filter(Boolean) : [];
      const res = createTaskCategory(name, initialItems);
      if (!res.success) {
        if (res.error === "already_exists") {
          return interaction.reply({ content: `⚠️ Category \`${name}\` already exists.`, flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: `❌ Failed: ${res.error}`, flags: MessageFlags.Ephemeral });
      }
      const listStr = res.list.length > 0 ? res.list.map(i => `\`${i}\``).join(", ") : "*(empty)*";
      return interaction.reply({
        content: `✅ Created task category \`${res.name}\`!\n📋 Items: ${listStr}\n\nYou can trigger it in chat with \`[CATEGORY: ${res.name}]\` or \`[${res.name}]\`.\nUse \`/model_add\` to add series/models to it.`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (interaction.commandName === "category_delete") {
      const name = interaction.options.getString('name');
      const protected_cats = ["default", "classifier", "search", "thinking", "live", "image_gen", "video_gen"];
      if (protected_cats.includes(name.toLowerCase())) {
        return interaction.reply({ content: `❌ Cannot delete built-in category \`${name}\`.`, flags: MessageFlags.Ephemeral });
      }
      const res = deleteTaskCategory(name);
      if (!res.success) {
        return interaction.reply({ content: `❌ Category \`${name}\` not found.`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: `🗑️ Deleted task category \`${res.name}\`.`, flags: MessageFlags.Ephemeral });
    }
  }

  // ── Donated API Keys Commands (Public) ───────────────────────────────────
  if (interaction.commandName === "donate_key") {
    const key = interaction.options.getString('key').trim();
    if (!key) {
      return interaction.reply({ content: "❌ API key cannot be empty.", flags: MessageFlags.Ephemeral });
    }
    const result = addKey(interaction.user.id, interaction.user.username, key);
    return interaction.reply({
      content: result.updated
        ? "✅ Your donated Gemini API key has been updated! Thank you for supporting the bot! 🙏"
        : "✅ Your Gemini API key has been securely saved! Thank you for donating! 🙏",
      flags: MessageFlags.Ephemeral
    });
  }

  if (interaction.commandName === "remove_key") {
    const removed = removeKey(interaction.user.id);
    return interaction.reply({
      content: removed
        ? "🗑️ Your donated API key has been removed."
        : "⚠️ You do not have a donated API key registered.",
      flags: MessageFlags.Ephemeral
    });
  }

  // ── User Image Upload (rate-limited) ─────────────────────────────────────
  if (interaction.commandName === "add_custom_img") {
    const { allowed, resetIn } = checkImgRateLimit(interaction.user.id);
    if (!allowed) {
      return interaction.reply({ content: `❌ Rate limit reached! You can upload up to **${IMG_RATE_LIMIT}** images per hour. Try again in ~**${resetIn}** minute(s).`, flags: MessageFlags.Ephemeral });
    }

    const url = interaction.options.getString('url');
    const attachment = interaction.options.getAttachment('file');
    const customName = interaction.options.getString('name');
    const targetUrl = attachment ? attachment.url : url;

    if (!targetUrl) return interaction.reply({ content: "❌ You must provide either a URL or an attachment.", flags: MessageFlags.Ephemeral });

    // Check file size for attachments
    if (attachment && attachment.size > IMG_MAX_SIZE) {
      return interaction.reply({ content: `❌ File too large! Maximum size is **${IMG_MAX_SIZE / 1024 / 1024}MB**. Your file is **${(attachment.size / 1024 / 1024).toFixed(1)}MB**.`, flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const { filename } = await downloadImageToLib(targetUrl, customName, true);
      recordImgUpload(interaction.user.id);
      const totalImages = getSavedImagesList().length;
      const remaining = IMG_RATE_LIMIT - (userImgRateMap.get(interaction.user.id)?.length || 0);
      return interaction.editReply({ content: `✅ Image saved as \`${filename}\`. Library now has **${totalImages}** image(s).\n📊 You have **${remaining}** upload(s) remaining this hour.` });
    } catch (err) {
      return interaction.editReply({ content: `❌ Failed to download image: ${err.message}` });
    }
  }

  // ── Moderation Commands ───────────────────────────────────────────────────
  if (interaction.commandName === "kick") {
    const targetUser = interaction.options.getUser('target');
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!member) return interaction.reply({ content: "User not found in this server.", flags: MessageFlags.Ephemeral });
    if (!member.kickable) return interaction.reply({ content: "I cannot kick this user.", flags: MessageFlags.Ephemeral });
    await member.kick(reason);
    await interaction.reply({ content: `👢 Successfully kicked ${targetUser.tag}. Reason: ${reason}` });
  }

  if (interaction.commandName === "ban") {
    const targetUser = interaction.options.getUser('target');
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (member && !member.bannable) return interaction.reply({ content: "I cannot ban this user.", flags: MessageFlags.Ephemeral });
    await interaction.guild.members.ban(targetUser.id, { reason });
    await interaction.reply({ content: `🔨 Successfully banned ${targetUser.tag}. Reason: ${reason}` });
  }

  if (interaction.commandName === "timeout") {
    const targetUser = interaction.options.getUser('target');
    const duration = interaction.options.getInteger('duration');
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!member) return interaction.reply({ content: "User not found in this server.", flags: MessageFlags.Ephemeral });
    if (!member.moderatable) return interaction.reply({ content: "I cannot timeout this user.", flags: MessageFlags.Ephemeral });
    await member.timeout(duration * 60 * 1000, reason);
    await interaction.reply({ content: `⏱️ Successfully timed out ${targetUser.tag} for ${duration} minute(s). Reason: ${reason}` });
  }

  if (interaction.commandName === "unban") {
    const targetId = interaction.options.getString('userid');
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    try {
      await interaction.guild.members.unban(targetId, reason);
      await interaction.reply({ content: `🕊️ Successfully unbanned user ID ${targetId}. Reason: ${reason}` });
    } catch (err) {
      await interaction.reply({ content: "Failed to unban.", flags: MessageFlags.Ephemeral });
    }
  }

  if (interaction.commandName === "purge") {
    const amount = interaction.options.getInteger('amount');
    try {
      const deleted = await interaction.channel.bulkDelete(amount, true);
      await interaction.reply({ content: `🧹 Successfully deleted ${deleted.size} messages.`, flags: MessageFlags.Ephemeral });
    } catch (err) {
      await interaction.reply({ content: "Failed to delete messages.", flags: MessageFlags.Ephemeral });
    }
  }
});

client.login(DISCORD_TOKEN);
