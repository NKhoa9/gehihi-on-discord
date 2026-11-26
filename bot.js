import "dotenv/config";
import { Client, GatewayIntentBits, Partials, ActivityType, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags, AttachmentBuilder, Collection } from "discord.js";
import fs from "fs";
import path from "path";
import { joinAndStartLive, leaveLive } from "./voice.js";

// -- New Modular Imports --
import {
  logger,
  LOG_CATEGORIES,
  LOG_PRESETS,
  DEFAULT_LOGGING_CONFIG,
  isLoggingMasterEnabled,
  setLoggingMasterEnabled,
  loadLoggingConfig,
  saveLoggingConfig
} from "./src/utils/logger.js";
import { loadConfig } from "./src/utils/config.js";
import {
  getGuildMemories,
  setGuildMemories,
  getUniversalMemories,
  setUniversalMemories,
  processMemoryTags,
  getTempMemory,
  getGuildTempMemories,
  clearTempMemory,
  clearGuildTempMemories,
  clearAllTempMemories,
  noteTempMemoryMessage
} from "./src/core/memory.js";
import { resolveGuildEmojis, resolveReactEmoji } from "./src/core/emojis.js";
import { shouldRespond, recordBotReply } from "./src/core/trigger.js";
import {
  pushHistory,
  clearHistory,
  updateHistoryReactions,
  getHistory,
  ensureChannelHistoryFetched,
  formatUserMessageText,
  extractMessageReactions,
  cleanMessageContent
} from "./src/core/history.js";
import { cacheAttachments } from "./src/media/attachments.js";
import { getSavedImagesList, getSavedImage, downloadImageToLib, searchGoogleImage } from "./src/media/images.js";
import { generateImage, generateVideo, generateReply, generateComparisonReply, generatePromptReply, getThinkingEffort, maybeUpdateTempMemory } from "./src/ai/router.js";
import { setLatestFeedback, updateFeedbackScoreFromMessage, clearFeedback, getLatestFeedback } from "./src/core/feedback.js";
import { addKey, removeKey, getAllKeys } from "./src/core/keys.js";
import { isChannelDisabled, disableChannel, enableChannel, getDisabledChannels } from "./src/core/channel_control.js";
import { openConfigHub, handleConfigUIInteraction } from "./src/core/config_ui.js";
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
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildExpressions,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
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
    .setDescription("Clear the bot's history and temp memory for this channel"),
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check if the bot is alive"),
  new SlashCommandBuilder()
    .setName("memories")
    .setDescription("View the bot's saved permanent and temporary memories")
    .addStringOption(option =>
      option.setName("scope")
        .setDescription("Which memories to view")
        .setRequired(false)
        .addChoices(
          { name: "all (permanent + temp)", value: "all" },
          { name: "permanent (universal + server)", value: "permanent" },
          { name: "universal (permanent facts & skills)", value: "universal" },
          { name: "server (permanent context & lore)", value: "server" },
          { name: "temp (current convo & cross-channel)", value: "temp" }
        )
    ),
  new SlashCommandBuilder()
    .setName("reset_memory")
    .setDescription("[Admin] Erase AI permanent or temporary memories")
    .addStringOption(option =>
      option.setName("scope")
        .setDescription("Which memories to erase")
        .setRequired(false)
        .addChoices(
          { name: "server (permanent server memories)", value: "server" },
          { name: "universal (permanent global facts & skills)", value: "universal" },
          { name: "temp (temp memory for this channel)", value: "temp" },
          { name: "temp_server (all temp memories in this server)", value: "temp_server" },
          { name: "all (all permanent & temp memories)", value: "all" }
        )
    ),
  new SlashCommandBuilder()
    .setName("pause_ai")
    .setDescription("[Admin] Pause or unpause the AI from responding in text channels"),
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("[Admin] Open the interactive bot configuration form"),
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
    .addIntegerOption(option => option.setName('lines').setDescription('Number of lines to fetch (default 50, max 200)').setRequired(false).setMinValue(1).setMaxValue(200))
    .addStringOption(option =>
      option.setName('level')
        .setDescription('Filter by log level (optional)')
        .setRequired(false)
        .addChoices(
          { name: 'debug', value: 'DEBUG' },
          { name: 'info', value: 'INFO' },
          { name: 'warn', value: 'WARN' },
          { name: 'error', value: 'ERROR' }
        ))
    .addStringOption(option =>
      option.setName('category')
        .setDescription('Filter by log category (optional)')
        .setRequired(false)
        .addChoices(...LOG_CATEGORIES.map(c => ({ name: c, value: c }))))
    .addStringOption(option => option.setName('search').setDescription('Filter lines containing text (optional)').setRequired(false)),
  new SlashCommandBuilder()
    .setName("log_config")
    .setDescription("[Admin] Manage logging levels, categories, destinations, and presets (logging.json)")
    .addSubcommand(sub =>
      sub.setName("view")
        .setDescription("View current logging configuration"))
    .addSubcommand(sub =>
      sub.setName("master")
        .setDescription("Toggle master logging on/off in config.json")
        .addBooleanOption(o => o.setName("enabled").setDescription("Turn logging on or off").setRequired(true)))
    .addSubcommand(sub =>
      sub.setName("level")
        .setDescription("Enable or disable a log level in logging.json")
        .addStringOption(o =>
          o.setName("name")
            .setDescription("Log level")
            .setRequired(true)
            .addChoices(
              { name: "debug", value: "debug" },
              { name: "info", value: "info" },
              { name: "warn", value: "warn" },
              { name: "error", value: "error" }
            ))
        .addBooleanOption(o => o.setName("enabled").setDescription("Enable or disable this level").setRequired(true)))
    .addSubcommand(sub =>
      sub.setName("category")
        .setDescription("Enable or disable a log category (or all) in logging.json")
        .addStringOption(o =>
          o.setName("name")
            .setDescription("Log category")
            .setRequired(true)
            .addChoices(
              { name: "all (every category)", value: "all" },
              ...LOG_CATEGORIES.map(c => ({ name: c, value: c }))
            ))
        .addBooleanOption(o => o.setName("enabled").setDescription("Enable or disable this category").setRequired(true)))
    .addSubcommand(sub =>
      sub.setName("options")
        .setDescription("Update console/file destinations, rotation size, or raw AI truncation")
        .addBooleanOption(o => o.setName("console").setDescription("Log to console"))
        .addBooleanOption(o => o.setName("file").setDescription("Log to file"))
        .addIntegerOption(o => o.setName("max_file_size_mb").setDescription("Max log file size in MB before rotation (0 = unlimited)").setMinValue(0).setMaxValue(500))
        .addIntegerOption(o => o.setName("raw_max_chars").setDescription("Max chars for raw AI logs (0 = unlimited)").setMinValue(0).setMaxValue(20000)))
    .addSubcommand(sub =>
      sub.setName("preset")
        .setDescription("Apply a quick logging preset")
        .addStringOption(o =>
          o.setName("mode")
            .setDescription("Preset mode")
            .setRequired(true)
            .addChoices(
              { name: "silent (disable all logging)", value: "silent" },
              { name: "minimal (warn & error only)", value: "minimal" },
              { name: "balanced (no debug or bulky raw AI dumps)", value: "balanced" },
              { name: "verbose (everything enabled)", value: "verbose" }
            )))
    .addSubcommand(sub =>
      sub.setName("reset")
        .setDescription("Reset logging.json to defaults and enable logging"))
    .addSubcommand(sub =>
      sub.setName("clear_file")
        .setDescription("Clear the active log file")),
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
  // ── Thinking Effort Commands ────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("thinking_set")
    .setDescription("[Admin] Set thinking effort level (low, medium, high)")
    .addStringOption(option =>
      option.setName('effort')
        .setDescription('Thinking effort level')
        .setRequired(true)
        .addChoices(
          { name: 'low', value: 'low' },
          { name: 'medium', value: 'medium' },
          { name: 'high', value: 'high' }
        ))
    .addStringOption(option =>
      option.setName('model')
        .setDescription('Specific model name (for local mode; omit for global setting)')
        .setRequired(false)
        .setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName("thinking_mode")
    .setDescription("[Admin] Switch thinking effort mode (global vs local)")
    .addStringOption(option =>
      option.setName('mode')
        .setDescription('Mode: global (1 setting for all) or local (each model uses its own setting)')
        .setRequired(true)
        .addChoices(
          { name: 'global (1 setting for all models)', value: 'global' },
          { name: 'local (each model uses a different setting)', value: 'local' }
        )),
  new SlashCommandBuilder()
    .setName("thinking_check")
    .setDescription("[Admin] View the current thinking effort configuration"),
  new SlashCommandBuilder()
    .setName("feedback")
    .setDescription("[Admin] Toggle or check the AI response feedback reaction feature")
    .addStringOption(option =>
      option.setName('enabled')
        .setDescription('Turn feedback system on or off')
        .setRequired(false)
        .addChoices(
          { name: 'on (enable ⬆️/⬇️ reactions)', value: 'on' },
          { name: 'off (disable feedback reactions)', value: 'off' }
        )),
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
  return cleanMessageContent(message.content, client.user.id) || "hey";
}

function getChannelMeta(channel, guild) {
  let isPrivate = false;
  if (guild && channel?.permissionsFor && guild.roles?.everyone) {
    isPrivate = !channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel);
  }
  return {
    guildId: guild?.id || null,
    channelName: channel?.name || "dm",
    isPrivate,
  };
}

const TEMP_MEMORY_SUMMARY_INTERVAL = 8;

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
    const reply = await generatePromptReply(prompt, guildId, channel.guild || null, channelId);
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
  logger.log(`[Startup] 🤖 Logged in as ${client.user.tag} across ${client.guilds.cache.size} server(s)`);
  client.user.setActivity("Brainrot AI slop ✨", { type: ActivityType.Playing });
  await registerCommands();

  // Pre-fetch custom emojis for all connected guilds
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.emojis.fetch();
    } catch (err) {
      logger.warn(`[Emojis] Failed to fetch emojis for guild ${guild.name}:`, err.message);
    }
  }

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
    const greeting = await generatePromptReply(prompt, member.guild.id, member.guild, channel.id);
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

  if (message.guild && message.guild.emojis.cache.size === 0) {
    await message.guild.emojis.fetch().catch(() => { });
  }

  const channelDisabled = isChannelDisabled(message.channel.id);
  const channelMeta = getChannelMeta(message.channel, message.guild);

  // Fetch prior messages in this channel before collecting new messages
  let fetchedCount = 0;
  if (!channelDisabled) {
    fetchedCount = await ensureChannelHistoryFetched(message.channel, client.user.id, message.id);
  }

  const userText = cleanContent(message);
  const userName = message.author.displayName || message.author.username;

  let repliedMsg = null;
  if (message.reference) {
    try {
      repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
    } catch { }
  }

  const cachedAttachments = message.attachments.size > 0
    ? await cacheAttachments(message.attachments)
    : [];

  const initialReactions = extractMessageReactions(message);
  const formattedUserEntry = formatUserMessageText(message, client.user.id, repliedMsg, "hey");
  pushHistory(message.channel.id, "user", formattedUserEntry, cachedAttachments, message.id, initialReactions);

  const msgCountSinceSummary = !channelDisabled
    ? noteTempMemoryMessage(message.channel.id, channelMeta, 1 + fetchedCount)
    : 0;

  if (isAIPaused || channelDisabled) return;

  let isMentioned = message.mentions.has(client.user);
  let isReplyToBot = Boolean(repliedMsg && repliedMsg.author?.id === client.user.id);

  const cfg = loadConfig();
  const decision = shouldRespond({
    message,
    client,
    cfg,
    userText,
    isMentioned,
    isReplyToBot
  });

  if (!decision.shouldProcess) {
    logger.debug(`[Ignore] Trigger check not passed (${decision.reason}, mode: ${decision.mode}). userName: ${userName}`);
    if (msgCountSinceSummary >= TEMP_MEMORY_SUMMARY_INTERVAL) {
      void maybeUpdateTempMemory(message.channel.id, message.guildId, channelMeta);
    }
    return;
  }

  logger.debug(`[Process] Starting generation for message from ${userName}`);
  try {
    await message.channel.sendTyping();

    // Sync latest reactions for messages in this channel's history from Discord cache
    for (const entry of getHistory(message.channel.id)) {
      if (entry.messageId) {
        const cached = message.channel.messages.cache.get(entry.messageId);
        if (cached && cached.reactions?.cache?.size > 0) {
          const rxList = [];
          for (const [, rx] of cached.reactions.cache) {
            const emojiStr = rx.emoji.id ? `<${rx.emoji.animated ? "a" : ""}:${rx.emoji.name}:${rx.emoji.id}>` : rx.emoji.name;
            rxList.push({ emoji: emojiStr, count: rx.count });
          }
          entry.reactions = rxList;
        }
      }
    }

    // ── Model Comparison Mode ───────────────────────────────────────────
    if (cfg.model_compare?.enabled && cfg.model_compare?.models?.length > 0) {
      logger.log(`[Compare] Comparison mode active — querying ${cfg.model_compare.models.length} models`);

      const results = await generateComparisonReply(
        message.channel.id,
        userText,
        message.guildId,
        message.guild
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
      recordBotReply(message.channel.id);
      return; // Skip normal reply flow
    }
    // ── End Comparison Mode ─────────────────────────────────────────────

    const replyResult = await generateReply(
      message.channel.id,
      userText,
      message.guildId,
      message.guild
    );

    const replyText = typeof replyResult === "object" ? replyResult.text : replyResult;
    const modelUsed = typeof replyResult === "object" ? replyResult.model : null;
    const thinkingEffort = typeof replyResult === "object" ? replyResult.thinkingEffort : null;
    const modelFooter = modelUsed && modelUsed !== "none"
      ? (thinkingEffort ? `${modelUsed} (${thinkingEffort})` : modelUsed)
      : null;

    let finalReply = (replyText || "").trim();
    logger.rawAI("output", `Raw AI Response (to ${userName} in ${message.channel.id})`, finalReply);

    finalReply = processMemoryTags(finalReply, message.guildId, message.channel.id, channelMeta);

    logger.debug(`[Response] Prepared reply for ${userName} in ${message.channel.id} (${finalReply.length} chars)`);

    if (finalReply.includes("[IGNORE]")) return;

    const reactMatch = finalReply.match(/\[REACT:\s*(.+?)\]/);
    if (reactMatch) {
      const rawEmoji = reactMatch[1].trim();
      const emojiToReact = resolveReactEmoji(rawEmoji, message.guild);
      if (emojiToReact) {
        try {
          await message.react(emojiToReact);
        } catch (err) {
          logger.error(`Failed to react with "${rawEmoji}":`, err.message);
        }
      }
      finalReply = finalReply.replace(/\[REACT:\s*.+?\]/gi, "").trim();
      if (!finalReply) {
        recordBotReply(message.channel.id);
        return;
      }
    }

    if (message.guild) {
      finalReply = resolveGuildEmojis(finalReply, message.guild);
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
    pushHistory(message.channel.id, "model", finalReply, [], null, []);
    recordBotReply(message.channel.id);

    const postReplyCount = noteTempMemoryMessage(message.channel.id, channelMeta, 1);
    if (postReplyCount >= TEMP_MEMORY_SUMMARY_INTERVAL) {
      void maybeUpdateTempMemory(message.channel.id, message.guildId, channelMeta);
    }

    const replyOpts = {
      allowedMentions: { repliedUser: false, parse: ['users', 'roles'] },
    };
    if (attachments.length > 0) replyOpts.files = attachments;

    const hasModelFootnote = !!modelFooter;

    let sentMsg = null;
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
              embed.setFooter({ text: `${footerText} •  ${modelFooter}` });
            } else if (footerText) {
              embed.setFooter({ text: footerText });
            } else if (hasModelFootnote) {
              embed.setFooter({ text: ` ${modelFooter}` });
            }
            sentMsg = await message.reply({ ...replyOpts, embeds: [embed] });
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
              embed.setFooter({ text: ` ${modelFooter}` });
            }
            const opts = i === 0 ? { ...replyOpts, embeds: [embed] } : { embeds: [embed], allowedMentions: replyOpts.allowedMentions };
            const m = await message.reply(opts);
            if (!sentMsg) sentMsg = m;
          }
        } else {
          const embed = new EmbedBuilder().setColor(0x4285F4).setDescription(finalReply);
          if (hasModelFootnote) embed.setFooter({ text: ` ${modelFooter}` });
          sentMsg = await message.reply({ ...replyOpts, embeds: [embed] });
        }
      }
    } else {
      if (hasModelFootnote && finalReply) {
        finalReply += `\n-#  ${modelFooter}`;
      }
      if (!finalReply && attachments.length > 0) {
        if (hasModelFootnote) {
          sentMsg = await message.reply({ ...replyOpts, content: `-#  ${modelFooter}` });
        } else {
          sentMsg = await message.reply(replyOpts);
        }
      } else if (finalReply.length > 2000) {
        // Chunk long non-embed replies smartly to respect Discord's 2000 char limit
        const chunks = smartSplit(finalReply, 2000);
        for (let i = 0; i < chunks.length; i++) {
          const opts = i === 0
            ? { ...replyOpts, content: chunks[i] }
            : { content: chunks[i], allowedMentions: replyOpts.allowedMentions };
          const m = await message.reply(opts);
          if (!sentMsg) sentMsg = m;
        }
      } else {
        sentMsg = await message.reply({ ...replyOpts, content: finalReply });
      }
    }

    if (sentMsg?.id) {
      const hist = getHistory(message.channel.id);
      const lastModel = [...hist].reverse().find(e => e.role === "model" && !e.messageId);
      if (lastModel) lastModel.messageId = sentMsg.id;

      // Feedback reactions (⬆️ and ⬇️) for AI response rating
      const currentConfig = loadConfig();
      if (currentConfig.feedback_system !== false) {
        setLatestFeedback(message.channel.id, sentMsg.id);
        sentMsg.react("⬆️").then(() => sentMsg.react("⬇️")).catch(() => { });
      }
    }
  } catch (err) {
    logger.error("Error handling message:", err);
  }
});

// ── Reaction Tracking ──────────────────────────────────────────────────────

async function handleReactionUpdate(reaction) {
  try {
    // Partials: ensure the reaction and message are fully loaded
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();

    const msg = reaction.message;
    const channelId = msg.channel.id;
    const messageId = msg.id;

    // Build the full reactions list from the message's current reaction cache
    const reactions = [];
    for (const [, rx] of msg.reactions.cache) {
      const emojiStr = rx.emoji.id
        ? `<${rx.emoji.animated ? "a" : ""}:${rx.emoji.name}:${rx.emoji.id}>`
        : rx.emoji.name;
      reactions.push({ emoji: emojiStr, count: rx.count });
    }

    updateHistoryReactions(channelId, messageId, reactions);

    // Update feedback score if this is the latest bot response in this channel
    updateFeedbackScoreFromMessage(msg);
  } catch (err) {
    logger.debug("[Reactions] Failed to update reaction in history:", err.message);
  }
}

client.on("messageReactionAdd", async (reaction, user) => {
  // Ensure arrow up (⬆️) and arrow down (⬇️) are mutually exclusive per user
  if (user && !user.bot) {
    try {
      if (reaction.partial) await reaction.fetch();
      if (reaction.message.partial) await reaction.message.fetch();

      const emojiName = reaction.emoji.name;
      const isUp = emojiName === "⬆️" || emojiName === "⬆";
      const isDown = emojiName === "⬇️" || emojiName === "⬇";

      if (isUp || isDown) {
        const oppositeNames = isUp ? ["⬇️", "⬇"] : ["⬆️", "⬆"];
        const oppositeReact = reaction.message.reactions.cache.find(r => oppositeNames.includes(r.emoji.name));
        if (oppositeReact) {
          await oppositeReact.users.remove(user.id).catch(() => {});
        }
      }
    } catch (err) {
      logger.debug("[Feedback] Error enforcing mutually exclusive feedback reactions:", err.message);
    }
  }

  await handleReactionUpdate(reaction);
});
client.on("messageReactionRemove", handleReactionUpdate);

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
      if (focusedOption.name === "model" && interaction.commandName === "thinking_set") {
        const registry = loadModelRegistry();
        const allModels = [...new Set(Object.values(registry).flat())];
        const filtered = allModels.filter(m => m.toLowerCase().includes(focusedOption.value.toLowerCase())).slice(0, 25);
        return await interaction.respond(filtered.map(m => ({ name: m, value: m })));
      }
    } catch (err) {
      logger.error("[Autocomplete] Error:", err.message);
    }
    return;
  }

  if (interaction.isStringSelectMenu() || interaction.isButton() || interaction.isModalSubmit()) {
    try {
      const handled = await handleConfigUIInteraction(interaction);
      if (handled) return;
    } catch (err) {
      logger.error("[ConfigUI] Interaction error:", err);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: `❌ Config UI error: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;
  logger.log(`[Command] ${interaction.user.tag} used /${interaction.commandName}`);

  if (interaction.commandName === "join") return await joinAndStartLive(interaction, logger);
  if (interaction.commandName === "leave") return await leaveLive(interaction);

  if (interaction.commandName === "clear") {
    clearHistory(interaction.channelId);
    clearTempMemory(interaction.channelId);
    clearFeedback(interaction.channelId);
    return await interaction.reply({ content: "🧹 Channel history & temp memory wiped! Fresh start.", flags: MessageFlags.Ephemeral });
  }

  if (interaction.commandName === "ping") {
    const latency = Math.round(client.ws.ping);
    const pauseStatus = isAIPaused ? "⏸️ Paused (globally)" : "▶️ Active";
    return await interaction.reply({ content: `🏓 Pong! \`${latency}ms\` • AI Status: **${pauseStatus}**`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.commandName === "memories") {
    const scope = interaction.options.getString("scope") || "all";
    const includeUniversal = scope === "all" || scope === "permanent" || scope === "universal";
    const includeServer = scope === "all" || scope === "permanent" || scope === "server";
    const includeTemp = scope === "all" || scope === "temp";

    const universalMemories = includeUniversal ? getUniversalMemories() : [];
    const serverMemories = includeServer && interaction.guildId ? getGuildMemories(interaction.guildId) : [];
    const channelTemp = includeTemp ? getTempMemory(interaction.channelId) : null;
    const crossTemp = includeTemp && interaction.guildId ? getGuildTempMemories(interaction.guildId, interaction.channelId, false) : [];

    const hasPerm = universalMemories.length > 0 || serverMemories.length > 0;
    const hasTemp = Boolean(channelTemp) || crossTemp.length > 0;

    if (!hasPerm && !hasTemp) {
      const emptyMessages = {
        universal: "🧠 No permanent universal memories saved yet!",
        server: "🧠 No permanent server memories saved for this server yet!",
        permanent: "🧠 No permanent memories saved yet!",
        temp: "📝 No temporary conversation memory recorded right now.",
        all: "🧠 No permanent or temporary memories saved yet!",
      };
      return interaction.reply({ content: emptyMessages[scope] || emptyMessages.all, flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle("🧠 AI Memories");

    if (universalMemories.length > 0) {
      const uLines = universalMemories.map((m, i) => `**#${i + 1}** \`[${m.id || 'N/A'}]\`: ${m.text}`).join("\n");
      embed.addFields({
        name: `🌐 Permanent — Universal Facts & Skills (${universalMemories.length})`,
        value: uLines.length > 1024 ? uLines.substring(0, 1020) + "..." : uLines,
        inline: false
      });
    }

    if (serverMemories.length > 0) {
      const sLines = serverMemories.map((m, i) => `**#${i + 1}** \`[${m.id || 'N/A'}]\`: ${m.text}`).join("\n");
      embed.addFields({
        name: `🏰 Permanent — Server Context & Lore (${serverMemories.length})`,
        value: sLines.length > 1024 ? sLines.substring(0, 1020) + "..." : sLines,
        inline: false
      });
    }

    if (channelTemp) {
      embed.addFields({
        name: `📝 Temp Memory — This Channel (#${channelTemp.channelName})`,
        value: channelTemp.summary.length > 1024 ? channelTemp.summary.substring(0, 1020) + "..." : channelTemp.summary,
        inline: false
      });
    }

    if (crossTemp.length > 0) {
      const cLines = crossTemp.map(t => `**#${t.channelName}** *(${t.ageLabel})*: ${t.summary}`).join("\n");
      embed.addFields({
        name: `🔀 Temp Memory — Other Channels (${crossTemp.length})`,
        value: cLines.length > 1024 ? cLines.substring(0, 1020) + "..." : cLines,
        inline: false
      });
    }

    const permCount = universalMemories.length + serverMemories.length;
    const tempCount = (channelTemp ? 1 : 0) + crossTemp.length;
    embed.setFooter({ text: `${permCount} permanent • ${tempCount} temp channel(s) • Scope: ${scope}` });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  const adminCommands = [
    "reset_memory", "pause_ai", "config", "config_check", "add_image", "logs", "log_config",
    "compare", "compare_add", "compare_remove", "compare_models", "set_models",
    "series_add", "series_remove", "series_move", "series_list",
    "model_add", "model_remove", "model_move",
    "disable_ai", "enable_ai",
    "schedule_add", "schedule_remove", "schedule_toggle", "schedule_list",
    "series_create", "series_delete", "category_create", "category_delete",
    "thinking_set", "thinking_mode", "thinking_check", "feedback"
  ];
  if (adminCommands.includes(interaction.commandName)) {
    const adminEnv = process.env.ADMINS || "";
    const admins = adminEnv.split(",").map(id => id.trim()).filter(id => id);

    if (admins.length === 0) return interaction.reply({ content: "❌ No admins are configured! Please add your User ID to the `ADMINS` variable in `.env` (comma separated).", flags: MessageFlags.Ephemeral });
    if (!admins.includes(interaction.user.id)) return interaction.reply({ content: "❌ You are not on the bot's admin whitelist.", flags: MessageFlags.Ephemeral });

    if (interaction.commandName === "reset_memory") {
      const scope = interaction.options.getString("scope") || "server";
      if (scope === "universal") {
        setUniversalMemories([]);
        return interaction.reply({ content: "🧠 All Permanent Universal AI memories (facts & skills) have been completely wiped by an admin." });
      } else if (scope === "temp") {
        clearTempMemory(interaction.channelId);
        return interaction.reply({ content: "📝 Temporary AI memory for this channel has been cleared by an admin." });
      } else if (scope === "temp_server") {
        if (interaction.guildId) clearGuildTempMemories(interaction.guildId);
        else clearTempMemory(interaction.channelId);
        return interaction.reply({ content: "📝 All Temporary AI memories for this server have been cleared by an admin." });
      } else if (scope === "all") {
        if (interaction.guildId) {
          setGuildMemories(interaction.guildId, []);
          clearGuildTempMemories(interaction.guildId);
        } else {
          clearTempMemory(interaction.channelId);
        }
        setUniversalMemories([]);
        clearAllTempMemories();
        return interaction.reply({ content: "🧠 All Permanent (Server & Universal) and Temporary AI memories have been completely wiped by an admin." });
      } else {
        if (interaction.guildId) setGuildMemories(interaction.guildId, []);
        return interaction.reply({ content: "🧠 All Permanent Server AI memories for this server have been completely wiped by an admin." });
      }
    }

    if (interaction.commandName === "pause_ai") {
      isAIPaused = !isAIPaused;
      return interaction.reply({ content: isAIPaused ? "⏸️ AI has been PAUSED globally." : "▶️ AI has been UNPAUSED." });
    }

    if (interaction.commandName === "config") {
      return await openConfigHub(interaction);
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
      const logCfg = loadLoggingConfig();
      const activeLevels = Object.entries(logCfg.levels).filter(([, v]) => v).map(([k]) => k[0].toUpperCase()).join("/") || "none";
      const activeCats = Object.values(logCfg.categories).filter(Boolean).length;
      const fields = [
        { name: "📝 Logging", value: `\`${currentConfig.logging !== false ? "ON" : "OFF"}\``, inline: true },
        { name: "📋 Log Details", value: `\`${activeLevels} • ${activeCats}/${LOG_CATEGORIES.length} cats\` (/log_config)`, inline: true },
        { name: "⚠️ Chat Errors", value: `\`${currentConfig.show_errors_in_chat ? "SHOW" : "HIDE"}\``, inline: true },
        { name: "📜 Max History", value: `\`${currentConfig.max_history ?? "N/A"}\``, inline: true },
        { name: "📥 History Fetch", value: `\`${currentConfig.history_fetch_limit ?? 20}\``, inline: true },
        { name: "📝 Temp Memory", value: `\`${currentConfig.temp_memory_enabled !== false ? `ON (${currentConfig.temp_memory_ttl_minutes ?? 240}m)` : "OFF"}\``, inline: true },
        { name: "🎯 Trigger Mode", value: `\`${currentConfig.response_mode || "smart"}\``, inline: true },
        { name: "🎲 Random Rate", value: `\`${currentConfig.random_appear_rate ?? "N/A"}\``, inline: true },
        { name: "🔇 Silence MS", value: `\`${currentConfig.silence_duration_ms ?? "N/A"}\``, inline: true },
        { name: "🎙️ Voice Name", value: `\`${currentConfig.voice_name ?? "N/A"}\``, inline: true },
        { name: "⚡ Model Mode", value: `\`${currentConfig.model_mode || "flash-lite"}\``, inline: true },
        { name: "⏸️ AI Paused", value: `\`${isAIPaused ? "YES" : "NO"}\``, inline: true },
      ];

      // Thinking effort info
      const te = currentConfig.thinking_effort || { mode: "global", global: "medium", local: {} };
      const localCount = Object.keys(te.local || {}).length;
      const teLabel = `${te.mode || "global"} • ${te.global || "medium"}${te.mode === "local" ? ` (${localCount} model overrides)` : ""}`;
      fields.push({ name: "🧠 Thinking Effort", value: `\`${teLabel}\``, inline: true });

      const greetStatus = currentConfig.greet_new_members !== false ? "✅ ON" : "❌ OFF";
      const greetChannel = currentConfig.greet_channel_id ? ` in <#${currentConfig.greet_channel_id}>` : " (system channel)";
      fields.push({ name: "👋 Member Greeting", value: `${greetStatus}${greetChannel}`, inline: true });

      const feedbackStatus = currentConfig.feedback_system !== false ? "✅ ON (⬆️/⬇️)" : "❌ OFF";
      fields.push({ name: "📊 Feedback Rating", value: feedbackStatus, inline: true });

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
          fields.push({ name: label, value: valueText, inline: false });
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
          fields.push({ name: `✨ Custom Task: [${catName}]`, value: valueText, inline: false });
        } else {
          fields.push({ name: `✨ Custom Task: [${catName}]`, value: "*(empty)*", inline: false });
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
        fields.push({ name: "📦 Custom Series Pools", value: seriesInfo, inline: false });
      }

      // Disabled channels
      const disabledChs = getDisabledChannels(currentConfig);
      const disabledChsVal = disabledChs.length > 0
        ? disabledChs.map(id => `<#${id}>`).join(", ")
        : "*None (AI active everywhere)*";
      fields.push({ name: "🔇 Disabled Channels", value: disabledChsVal, inline: false });

      // Scheduled tasks
      const schedTasks = getScheduledTasks(currentConfig);
      const activeSchedCount = schedTasks.filter(t => t.enabled).length;
      fields.push({
        name: "⏰ Scheduled Tasks",
        value: `${schedTasks.length} task(s) (${activeSchedCount} active) — Use \`/schedule_list\` to view`,
        inline: false
      });

      // Show comparison config
      const compare = currentConfig.model_compare || { enabled: false, models: [] };
      const compareStatus = compare.enabled ? "✅ ON" : "❌ OFF";
      const compareList = compare.models.length > 0 ? compare.models.map(m => `\`${m}\``).join(", ") : "*(none)*";
      fields.push({ name: "🔬 Model Compare", value: `**Status:** ${compareStatus}\n**Models:** ${compareList}`, inline: false });

      const donatedKeysList = getAllKeys();
      const keysValue = donatedKeysList.length > 0
        ? `\`${donatedKeysList.length}\` key(s) (${donatedKeysList.map(k => k.username || k.userId).join(", ")})`
        : "`0` keys";
      fields.push({ name: "🔑 Donated Keys", value: keysValue, inline: false });

      const safeFields = fields.map(f => ({
        name: String(f.name).substring(0, 256),
        value: String(f.value || "*(empty)*").substring(0, 1024),
        inline: !!f.inline,
      }));

      const embeds = [];
      for (let i = 0; i < safeFields.length; i += 25) {
        const embed = new EmbedBuilder().setColor(0x2F3136).addFields(safeFields.slice(i, i + 25));
        if (i === 0) embed.setTitle("⚙️ Current Bot Configuration");
        embeds.push(embed);
      }

      const imgCount = getSavedImagesList().length;
      embeds[embeds.length - 1].setFooter({ text: `Image library: ${imgCount} image(s) | Config loaded from config.json` });
      return interaction.reply({ embeds: embeds.slice(0, 10), flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "logs") {
      const lineCount = interaction.options.getInteger('lines') || 50;
      const levelFilter = interaction.options.getString('level');
      const categoryFilter = interaction.options.getString('category');
      const searchFilter = interaction.options.getString('search');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const logCfg = loadLoggingConfig();
        if (!fs.existsSync(logCfg.log_file)) {
          return interaction.editReply({ content: `📋 Log file \`${logCfg.log_file}\` does not exist yet.` });
        }
        const logContent = fs.readFileSync(logCfg.log_file, "utf-8");
        let lines = logContent.split("\n").filter(Boolean);
        const totalLines = lines.length;

        if (levelFilter) {
          lines = lines.filter(l => l.includes(`[${levelFilter}]`));
        }
        if (categoryFilter) {
          lines = lines.filter(l => l.includes(`[${categoryFilter}]`));
        }
        if (searchFilter) {
          const needle = searchFilter.toLowerCase();
          lines = lines.filter(l => l.toLowerCase().includes(needle));
        }

        if (lines.length === 0) {
          return interaction.editReply({ content: "📋 No matching log entries found." });
        }

        const tail = lines.slice(-lineCount).join("\n");
        const filterParts = [
          levelFilter ? `level=${levelFilter}` : null,
          categoryFilter ? `cat=${categoryFilter}` : null,
          searchFilter ? `search="${searchFilter}"` : null,
        ].filter(Boolean);
        const filterLabel = filterParts.length > 0 ? ` (${filterParts.join(", ")})` : "";

        if (tail.length <= 4000) {
          const embed = new EmbedBuilder()
            .setColor(0x2F3136)
            .setTitle(`📋 Last ${Math.min(lineCount, lines.length)} log lines${filterLabel}`)
            .setDescription(`\`\`\`\n${tail}\n\`\`\``)
            .setFooter({ text: `Matched ${lines.length} / ${totalLines} lines • File: ${logCfg.log_file}` });
          return interaction.editReply({ embeds: [embed] });
        } else {
          const buf = Buffer.from(tail, "utf-8");
          const attachment = new AttachmentBuilder(buf, { name: "bot_log_tail.txt" });
          return interaction.editReply({ content: `📋 Last ${Math.min(lineCount, lines.length)} log lines${filterLabel} (sent as file):`, files: [attachment] });
        }
      } catch (err) {
        return interaction.editReply({ content: `❌ Failed to read log file: ${err.message}` });
      }
    }

    if (interaction.commandName === "log_config") {
      const sub = interaction.options.getSubcommand();

      if (sub === "view") {
        const master = isLoggingMasterEnabled();
        const cfg = loadLoggingConfig();
        const levelLines = Object.entries(cfg.levels)
          .map(([k, v]) => `${v ? "✅" : "❌"} \`${k}\``)
          .join("  •  ");
        const catLines = Object.entries(cfg.categories)
          .map(([k, v]) => `${v ? "✅" : "❌"} \`${k}\``)
          .join("\n");

        const embed = new EmbedBuilder()
          .setColor(master ? 0x57F287 : 0xED4245)
          .setTitle("🪵 Logging Configuration")
          .addFields(
            { name: "🔌 Master Switch (config.json)", value: master ? "✅ **ENABLED**" : "❌ **DISABLED**", inline: true },
            { name: "📤 Outputs (logging.json)", value: `Console: ${cfg.console ? "✅" : "❌"} • File: ${cfg.file ? "✅" : "❌"} (\`${cfg.log_file}\`)`, inline: true },
            { name: "📏 Limits", value: `Max file: \`${cfg.max_file_size_mb} MB\` • Raw AI cap: \`${cfg.raw_max_chars || "unlimited"}\``, inline: false },
            { name: "📊 Levels", value: levelLines, inline: false },
            { name: "🗂️ Categories", value: catLines, inline: false },
          )
          .setFooter({ text: "Use /log_config level, category, options, preset, or master to customize" });

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      if (sub === "master") {
        const enabled = interaction.options.getBoolean("enabled");
        setLoggingMasterEnabled(enabled);
        return interaction.reply({
          content: `${enabled ? "✅" : "⏸️"} Master \`logging\` in \`config.json\` is now **${enabled ? "ON" : "OFF"}**.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "level") {
        const name = interaction.options.getString("name");
        const enabled = interaction.options.getBoolean("enabled");
        const cfg = loadLoggingConfig();
        cfg.levels[name] = enabled;
        saveLoggingConfig(cfg);
        return interaction.reply({
          content: `${enabled ? "✅" : "❌"} Log level \`${name}\` is now **${enabled ? "ENABLED" : "DISABLED"}** in \`logging.json\`.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "category") {
        const name = interaction.options.getString("name");
        const enabled = interaction.options.getBoolean("enabled");
        const cfg = loadLoggingConfig();
        if (name === "all") {
          for (const cat of LOG_CATEGORIES) cfg.categories[cat] = enabled;
        } else {
          cfg.categories[name] = enabled;
        }
        saveLoggingConfig(cfg);
        return interaction.reply({
          content: `${enabled ? "✅" : "❌"} Log categor${name === "all" ? "ies (all)" : `y \`${name}\``} **${enabled ? "ENABLED" : "DISABLED"}** in \`logging.json\`.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "options") {
        const cfg = loadLoggingConfig();
        const consoleOpt = interaction.options.getBoolean("console");
        const fileOpt = interaction.options.getBoolean("file");
        const maxSizeOpt = interaction.options.getInteger("max_file_size_mb");
        const rawCapOpt = interaction.options.getInteger("raw_max_chars");

        if (consoleOpt === null && fileOpt === null && maxSizeOpt === null && rawCapOpt === null) {
          return interaction.reply({ content: "⚠️ Provide at least one option to update.", flags: MessageFlags.Ephemeral });
        }

        if (consoleOpt !== null) cfg.console = consoleOpt;
        if (fileOpt !== null) cfg.file = fileOpt;
        if (maxSizeOpt !== null) cfg.max_file_size_mb = maxSizeOpt;
        if (rawCapOpt !== null) cfg.raw_max_chars = rawCapOpt;

        const saved = saveLoggingConfig(cfg);
        return interaction.reply({
          content: `✅ Updated \`logging.json\`: Console \`${saved.console}\` • File \`${saved.file}\` • Max Size \`${saved.max_file_size_mb}MB\` • Raw Cap \`${saved.raw_max_chars || "unlimited"}\`.`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "preset") {
        const mode = interaction.options.getString("mode");
        const preset = LOG_PRESETS[mode];
        if (!preset) {
          return interaction.reply({ content: "❌ Unknown preset.", flags: MessageFlags.Ephemeral });
        }
        setLoggingMasterEnabled(preset.master);
        if (preset.levels || preset.categories) {
          const cfg = loadLoggingConfig();
          if (preset.levels) cfg.levels = { ...cfg.levels, ...preset.levels };
          if (preset.categories) cfg.categories = { ...cfg.categories, ...preset.categories };
          saveLoggingConfig(cfg);
        }
        return interaction.reply({
          content: `✅ Applied logging preset **\`${mode}\`**: ${preset.description}`,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "reset") {
        setLoggingMasterEnabled(true);
        saveLoggingConfig(DEFAULT_LOGGING_CONFIG);
        return interaction.reply({
          content: "🔄 Reset `logging.json` to defaults and enabled master `logging` in `config.json`.",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (sub === "clear_file") {
        try {
          const file = logger.clearLogFile();
          return interaction.reply({ content: `🧹 Cleared log file \`${file}\`.`, flags: MessageFlags.Ephemeral });
        } catch (err) {
          return interaction.reply({ content: `❌ Failed to clear log file: ${err.message}`, flags: MessageFlags.Ephemeral });
        }
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

    // ── Thinking Effort Commands ──────────────────────────────────────────────
    if (interaction.commandName === "thinking_set") {
      const effort = interaction.options.getString('effort').toLowerCase();
      const modelName = interaction.options.getString('model')?.trim() || null;

      if (!["low", "medium", "high"].includes(effort)) {
        return interaction.reply({ content: '❌ Effort must be `low`, `medium`, or `high`.', flags: MessageFlags.Ephemeral });
      }

      const currentConfig = loadConfig();
      if (!currentConfig.thinking_effort) {
        currentConfig.thinking_effort = { mode: "global", global: "medium", local: {} };
      }
      if (!currentConfig.thinking_effort.local) currentConfig.thinking_effort.local = {};

      if (modelName) {
        currentConfig.thinking_effort.local[modelName] = effort;
        fs.writeFileSync("config.json", JSON.stringify(currentConfig, null, 2), "utf-8");
        const extraNote = currentConfig.thinking_effort.mode !== "local"
          ? "\n💡 *Note: Bot is currently in `global` mode. Switch to `local` mode with `/thinking_mode mode: local` for per-model settings to take effect.*"
          : "";
        return interaction.reply({ content: `✅ Thinking effort for model \`${modelName}\` set to \`${effort}\`.${extraNote}`, flags: MessageFlags.Ephemeral });
      } else {
        currentConfig.thinking_effort.global = effort;
        fs.writeFileSync("config.json", JSON.stringify(currentConfig, null, 2), "utf-8");
        return interaction.reply({ content: `✅ Global thinking effort set to \`${effort}\`.`, flags: MessageFlags.Ephemeral });
      }
    }

    if (interaction.commandName === "thinking_mode") {
      const mode = interaction.options.getString('mode').toLowerCase();
      const currentConfig = loadConfig();
      if (!currentConfig.thinking_effort) {
        currentConfig.thinking_effort = { mode: "global", global: "medium", local: {} };
      }
      currentConfig.thinking_effort.mode = mode;
      fs.writeFileSync("config.json", JSON.stringify(currentConfig, null, 2), "utf-8");
      const desc = mode === "global"
        ? `All models will use the global setting (\`${currentConfig.thinking_effort.global || "medium"}\`).`
        : `Each model will use its local setting (or fall back to \`${currentConfig.thinking_effort.global || "medium"}\`).`;
      return interaction.reply({ content: `✅ Thinking effort mode set to \`${mode}\`.\n${desc}`, flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "thinking_check") {
      const currentConfig = loadConfig();
      const te = currentConfig.thinking_effort || { mode: "global", global: "medium", local: {} };
      const embed = new EmbedBuilder()
        .setColor(0x2F3136)
        .setTitle("🧠 Thinking Effort Configuration")
        .addFields(
          { name: "Current Mode", value: `\`${te.mode || "global"}\``, inline: true },
          { name: "Global Setting", value: `\`${te.global || "medium"}\``, inline: true },
        );

      const localMap = te.local || {};
      const localEntries = Object.entries(localMap);
      if (localEntries.length > 0) {
        const localDisplay = localEntries.map(([m, eff]) => `• \`${m}\` → \`${eff}\``).join("\n");
        embed.addFields({ name: "Local Model Overrides", value: localDisplay, inline: false });
      } else {
        embed.addFields({ name: "Local Model Overrides", value: "*(none configured)*", inline: false });
      }

      embed.setFooter({
        text: (te.mode === "global")
          ? "Currently active: global setting for all models"
          : "Currently active: local overrides (unconfigured models use global)"
      });
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (interaction.commandName === "feedback") {
      const enabledOpt = interaction.options.getString('enabled');
      const currentConfig = loadConfig();
      if (enabledOpt) {
        const isEnabled = enabledOpt === "on";
        currentConfig.feedback_system = isEnabled;
        fs.writeFileSync("config.json", JSON.stringify(currentConfig, null, 2), "utf-8");
        return interaction.reply({
          content: `✅ Feedback system has been turned **${isEnabled ? "ON" : "OFF"}**. ${isEnabled ? "The bot will react with ⬆️ and ⬇️ to rate its responses." : "Rating reactions disabled."}`,
          flags: MessageFlags.Ephemeral
        });
      } else {
        const isEnabled = currentConfig.feedback_system !== false;
        const currentFb = getLatestFeedback(interaction.channelId);
        const fbInfo = currentFb
          ? `Latest response score in this channel: **${currentFb.score > 0 ? "+" + currentFb.score : currentFb.score}** (⬆️ +${currentFb.upvotes}, ⬇️ -${currentFb.downvotes})`
          : "No feedback recorded for this channel yet.";
        return interaction.reply({
          content: `📊 Feedback system status: **${isEnabled ? "ON" : "OFF"}**\n${fbInfo}`,
          flags: MessageFlags.Ephemeral
        });
      }
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
