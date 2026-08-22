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
import { generateImage, generateVideo, generateReply } from "./src/ai/router.js";

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
          { name: 'logging', value: 'logging' },
          { name: 'debug_logging', value: 'debug_logging' },
          { name: 'show_errors_in_chat', value: 'show_errors_in_chat' }
        ))
    .addStringOption(option => option.setName('value').setDescription('The new value').setRequired(true)),
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

    const reply = await generateReply(
      message.channel.id,
      userText,
      message.guildId
    );

    let finalReply = reply.trim();
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
            if (embedObj.footer?.text) embed.setFooter({ text: String(embedObj.footer.text).substring(0, 2048) });
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
            const opts = i === 0 ? { ...replyOpts, embeds: [embed] } : { embeds: [embed], allowedMentions: replyOpts.allowedMentions };
            await message.reply(opts);
          }
        } else {
          const embed = new EmbedBuilder().setColor(0x4285F4).setDescription(finalReply);
          await message.reply({ ...replyOpts, embeds: [embed] });
        }
      }
    } else {
      if (!finalReply && attachments.length > 0) {
        await message.reply(replyOpts);
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

  const adminCommands = ["reset_memory", "pause_ai", "config", "config_check", "add_image", "logs"];
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
      } else if (setting === "logging" || setting === "debug_logging" || setting === "show_errors_in_chat") {
        const lower = valueStr.toLowerCase();
        if (lower === "true" || lower === "on" || lower === "1") newValue = true;
        else if (lower === "false" || lower === "off" || lower === "0") newValue = false;
        else return interaction.reply({ content: "❌ Value must be `true`/`on` or `false`/`off`.", flags: MessageFlags.Ephemeral });
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
          { name: "⏸️ AI Paused", value: `\`${isAIPaused ? "YES" : "NO"}\``, inline: true },
        );

      const models = currentConfig.models || {};
      const modelSections = [
        ["🤖 Default Models", models.default],
        ["🔍 Search Models", models.search],
        ["🧠 Thinking Models", models.thinking],
        ["🎤 Live Models", models.live],
        ["🖼️ Image Gen Models", models.image_gen],
        ["🎬 Video Gen Models", models.video_gen],
      ];
      for (const [label, list] of modelSections) {
        if (Array.isArray(list) && list.length > 0) embed.addFields({ name: label, value: list.map(m => `\`${m}\``).join("\n"), inline: false });
      }

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
