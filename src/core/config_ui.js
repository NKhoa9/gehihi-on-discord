import fs from "fs";
import crypto from "crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { loadConfig } from "../utils/config.js";

function resolveShowThinkingMode(cfg) {
  const val = cfg?.show_thinking;
  if (val === true) return "spoiler";
  if (!val || val === false) return "off";
  const lower = String(val).toLowerCase();
  return ["off", "spoiler", "visible", "embed"].includes(lower) ? lower : "off";
}

const DRAFT_TTL_MS = 10 * 60 * 1000;
const pendingDrafts = new Map();
const pendingConfirms = new Map();

function cleanupExpired(map) {
  const now = Date.now();
  for (const [k, v] of map.entries()) {
    if (now - v.createdAt > DRAFT_TTL_MS) {
      map.delete(k);
    }
  }
}

function isAdminUser(userId) {
  const adminEnv = process.env.ADMINS || "";
  const admins = adminEnv.split(",").map(id => id.trim()).filter(Boolean);
  return admins.includes(userId);
}

function parseBoolInput(raw, fieldName, errors) {
  const lower = String(raw).trim().toLowerCase();
  if (["true", "on", "1", "yes"].includes(lower)) return true;
  if (["false", "off", "0", "no"].includes(lower)) return false;
  errors.push(`**${fieldName}**: must be \`true\`/\`on\` or \`false\`/\`off\` (got \`${raw}\`).`);
  return null;
}

function parseIntInput(raw, fieldName, errors, { min = -Infinity, max = Infinity } = {}) {
  const trimmed = String(raw).trim();
  if (!/^-?\d+$/.test(trimmed)) {
    errors.push(`**${fieldName}**: must be a whole number (got \`${raw}\`).`);
    return null;
  }
  const n = parseInt(trimmed, 10);
  if (n < min || n > max) {
    const rangeStr = max === Infinity ? `>= ${min}` : `${min}–${max}`;
    errors.push(`**${fieldName}**: must be ${rangeStr} (got \`${n}\`).`);
    return null;
  }
  return n;
}

function parseFloatInput(raw, fieldName, errors, { min = -Infinity, max = Infinity } = {}) {
  const trimmed = String(raw).trim();
  const n = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(n)) {
    errors.push(`**${fieldName}**: must be a valid number (got \`${raw}\`).`);
    return null;
  }
  if (n < min || n > max) {
    errors.push(`**${fieldName}**: must be between ${min} and ${max} (got \`${n}\`).`);
    return null;
  }
  return n;
}

const SECTIONS = {
  core: {
    label: "Core & Chat",
    description: "response_mode, random_appear_rate, history limits, max_continuation",
    emoji: "💬",
    title: "Edit Core & Chat Settings",
    buildFields: (cfg) => [
      { id: "response_mode", label: "response_mode (smart | random)", value: String(cfg.response_mode || "smart"), style: TextInputStyle.Short },
      { id: "random_appear_rate", label: "random_appear_rate (0.0 - 1.0)", value: String(cfg.random_appear_rate ?? 0.2), style: TextInputStyle.Short },
      { id: "max_history", label: "max_history (>= 1)", value: String(cfg.max_history ?? 30), style: TextInputStyle.Short },
      { id: "history_fetch_limit", label: "history_fetch_limit (0 - 100)", value: String(cfg.history_fetch_limit ?? 20), style: TextInputStyle.Short },
      { id: "max_continuation", label: "max_continuation (0 - 10)", value: String(cfg.max_continuation ?? 3), style: TextInputStyle.Short },
    ],
    validate: (raw, nextCfg, errors) => {
      const mode = raw.response_mode.trim().toLowerCase();
      if (mode !== "smart" && mode !== "random") {
        errors.push(`**response_mode**: must be \`smart\` or \`random\` (got \`${raw.response_mode}\`).`);
      } else {
        nextCfg.response_mode = mode;
      }
      const rate = parseFloatInput(raw.random_appear_rate, "random_appear_rate", errors, { min: 0, max: 1 });
      if (rate !== null) nextCfg.random_appear_rate = rate;
      const maxHist = parseIntInput(raw.max_history, "max_history", errors, { min: 1 });
      if (maxHist !== null) nextCfg.max_history = maxHist;
      const fetchLim = parseIntInput(raw.history_fetch_limit, "history_fetch_limit", errors, { min: 0, max: 100 });
      if (fetchLim !== null) nextCfg.history_fetch_limit = fetchLim;
      const maxCont = parseIntInput(raw.max_continuation, "max_continuation", errors, { min: 0, max: 10 });
      if (maxCont !== null) nextCfg.max_continuation = maxCont;
    },
  },
  memory_timing: {
    label: "Memory & Timing",
    description: "temp_memory, TTL, silence_duration_ms, greet_new_members",
    emoji: "🧠",
    title: "Edit Memory & Timing Settings",
    buildFields: (cfg) => [
      { id: "temp_memory_enabled", label: "temp_memory_enabled (true | false)", value: String(cfg.temp_memory_enabled !== false), style: TextInputStyle.Short },
      { id: "temp_memory_ttl_minutes", label: "temp_memory_ttl_minutes (>= 1)", value: String(cfg.temp_memory_ttl_minutes ?? 240), style: TextInputStyle.Short },
      { id: "silence_duration_ms", label: "silence_duration_ms (>= 0)", value: String(cfg.silence_duration_ms ?? 200), style: TextInputStyle.Short },
      { id: "greet_new_members", label: "greet_new_members (true | false)", value: String(cfg.greet_new_members !== false), style: TextInputStyle.Short },
      { id: "greet_channel_id", label: "greet_channel_id (channel ID or none)", value: cfg.greet_channel_id ? String(cfg.greet_channel_id) : "none", style: TextInputStyle.Short, required: false },
    ],
    validate: (raw, nextCfg, errors) => {
      const tempEn = parseBoolInput(raw.temp_memory_enabled, "temp_memory_enabled", errors);
      if (tempEn !== null) nextCfg.temp_memory_enabled = tempEn;
      const ttl = parseIntInput(raw.temp_memory_ttl_minutes, "temp_memory_ttl_minutes", errors, { min: 1 });
      if (ttl !== null) nextCfg.temp_memory_ttl_minutes = ttl;
      const silence = parseIntInput(raw.silence_duration_ms, "silence_duration_ms", errors, { min: 0 });
      if (silence !== null) nextCfg.silence_duration_ms = silence;
      const greet = parseBoolInput(raw.greet_new_members, "greet_new_members", errors);
      if (greet !== null) nextCfg.greet_new_members = greet;

      const chRaw = (raw.greet_channel_id || "").trim();
      if (!chRaw || chRaw.toLowerCase() === "none" || chRaw.toLowerCase() === "clear") {
        nextCfg.greet_channel_id = null;
      } else {
        const cleaned = chRaw.replace(/[<#>]/g, "").trim();
        if (!/^\d{15,22}$/.test(cleaned)) {
          errors.push(`**greet_channel_id**: must be a Discord channel ID or \`none\` (got \`${chRaw}\`).`);
        } else {
          nextCfg.greet_channel_id = cleaned;
        }
      }
    },
  },
  ai_thinking: {
    label: "AI & Thinking",
    description: "model_mode, thinking_effort, thinking_window, show_thinking",
    emoji: "💭",
    title: "Edit AI & Thinking Settings",
    buildFields: (cfg) => {
      const te = cfg.thinking_effort || { mode: "global", global: "medium", local: {} };
      return [
        { id: "model_mode", label: "model_mode (flash | flash-lite)", value: String(cfg.model_mode || "flash-lite"), style: TextInputStyle.Short },
        { id: "thinking_mode", label: "thinking_effort.mode (global | local)", value: String(te.mode || "global"), style: TextInputStyle.Short },
        { id: "thinking_global", label: "thinking_effort.global (low|medium|high)", value: String(te.global || "medium"), style: TextInputStyle.Short },
        { id: "thinking_window", label: "thinking_window (true | false)", value: String(cfg.thinking_window !== false), style: TextInputStyle.Short },
        { id: "show_thinking", label: "show_thinking (off|spoiler|visible|embed)", value: resolveShowThinkingMode(cfg), style: TextInputStyle.Short },
      ];
    },
    validate: (raw, nextCfg, errors) => {
      const mm = raw.model_mode.trim().toLowerCase();
      if (mm !== "flash" && mm !== "flash-lite") {
        errors.push(`**model_mode**: must be \`flash\` or \`flash-lite\` (got \`${raw.model_mode}\`).`);
      } else {
        nextCfg.model_mode = mm;
      }

      if (!nextCfg.thinking_effort) nextCfg.thinking_effort = { mode: "global", global: "medium", local: {} };
      const tm = raw.thinking_mode.trim().toLowerCase();
      if (tm !== "global" && tm !== "local") {
        errors.push(`**thinking_effort.mode**: must be \`global\` or \`local\` (got \`${raw.thinking_mode}\`).`);
      } else {
        nextCfg.thinking_effort.mode = tm;
      }

      const tg = raw.thinking_global.trim().toLowerCase();
      if (!["low", "medium", "high"].includes(tg)) {
        errors.push(`**thinking_effort.global**: must be \`low\`, \`medium\`, or \`high\` (got \`${raw.thinking_global}\`).`);
      } else {
        nextCfg.thinking_effort.global = tg;
      }

      const tw = parseBoolInput(raw.thinking_window, "thinking_window", errors);
      if (tw !== null) nextCfg.thinking_window = tw;

      const stLower = raw.show_thinking.trim().toLowerCase();
      const stMapped = stLower === "true" || stLower === "on" ? "spoiler" : (stLower === "false" ? "off" : stLower);
      if (!["off", "spoiler", "visible", "embed"].includes(stMapped)) {
        errors.push(`**show_thinking**: must be \`off\`, \`spoiler\`, \`visible\`, or \`embed\` (got \`${raw.show_thinking}\`).`);
      } else {
        nextCfg.show_thinking = stMapped;
      }
    },
  },
  feedback_logs: {
    label: "Feedback, Logging & Voice",
    description: "feedback_system, logging, show_errors_in_chat, voice_name",
    emoji: "🔧",
    title: "Edit Feedback, Logging & Voice",
    buildFields: (cfg) => [
      { id: "feedback_system", label: "feedback_system (true | false)", value: String(cfg.feedback_system !== false), style: TextInputStyle.Short },
      { id: "logging", label: "logging (true | false)", value: String(cfg.logging !== false), style: TextInputStyle.Short },
      { id: "show_errors_in_chat", label: "show_errors_in_chat (true | false)", value: String(cfg.show_errors_in_chat === true), style: TextInputStyle.Short },
      { id: "voice_name", label: "voice_name (e.g. Aoede, Puck, Kore)", value: String(cfg.voice_name || "Aoede"), style: TextInputStyle.Short },
    ],
    validate: (raw, nextCfg, errors) => {
      const fb = parseBoolInput(raw.feedback_system, "feedback_system", errors);
      if (fb !== null) nextCfg.feedback_system = fb;
      const log = parseBoolInput(raw.logging, "logging", errors);
      if (log !== null) nextCfg.logging = log;
      const errChat = parseBoolInput(raw.show_errors_in_chat, "show_errors_in_chat", errors);
      if (errChat !== null) nextCfg.show_errors_in_chat = errChat;

      const voice = raw.voice_name.trim();
      if (!voice) {
        errors.push(`**voice_name**: cannot be empty.`);
      } else {
        nextCfg.voice_name = voice;
      }
    },
  },
  raw_json: {
    label: "Raw config.json",
    description: "Edit the full config.json directly with syntax validation",
    emoji: "📝",
    title: "Edit Raw config.json",
    buildFields: (cfg) => {
      let jsonStr = JSON.stringify(cfg, null, 2);
      if (jsonStr.length > 3950) {
        jsonStr = JSON.stringify(cfg);
      }
      return [
        {
          id: "raw_json",
          label: "config.json (valid JSON object)",
          value: jsonStr.substring(0, 4000),
          style: TextInputStyle.Paragraph,
        },
      ];
    },
    validate: (raw, _nextCfg, errors) => {
      let parsed;
      try {
        parsed = JSON.parse(raw.raw_json);
      } catch (err) {
        errors.push(`**JSON Syntax Error**: ${err.message}`);
        return null;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.push(`**JSON Root**: must be a JSON object \`{ ... }\`.`);
        return null;
      }
      if (parsed.response_mode !== undefined && !["smart", "random"].includes(parsed.response_mode)) {
        errors.push(`**response_mode**: must be \`smart\` or \`random\`.`);
      }
      if (parsed.history_fetch_limit !== undefined && (!Number.isInteger(parsed.history_fetch_limit) || parsed.history_fetch_limit < 0 || parsed.history_fetch_limit > 100)) {
        errors.push(`**history_fetch_limit**: must be an integer between 0 and 100.`);
      }
      if (parsed.temp_memory_ttl_minutes !== undefined && (!Number.isInteger(parsed.temp_memory_ttl_minutes) || parsed.temp_memory_ttl_minutes < 1)) {
        errors.push(`**temp_memory_ttl_minutes**: must be an integer >= 1.`);
      }
      if (parsed.model_mode !== undefined && !["flash", "flash-lite"].includes(parsed.model_mode)) {
        errors.push(`**model_mode**: must be \`flash\` or \`flash-lite\`.`);
      }
      if (parsed.show_thinking !== undefined && !["off", "spoiler", "visible", "embed", true, false].includes(parsed.show_thinking)) {
        errors.push(`**show_thinking**: must be \`off\`, \`spoiler\`, \`visible\`, or \`embed\`.`);
      }
      return parsed;
    },
  },
};

function buildConfigHubPayload() {
  const cfg = loadConfig();
  const te = cfg.thinking_effort || { mode: "global", global: "medium" };

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("⚙️ Interactive Configuration")
    .setDescription("Select a category below to open a **pre-filled form** with your current settings.\nAll changes are syntax-checked and previewed for **Confirm / Cancel** before saving.")
    .addFields(
      {
        name: "💬 Core & Chat",
        value: `Mode: \`${cfg.response_mode || "smart"}\` • Rate: \`${cfg.random_appear_rate ?? 0.2}\`\nHistory: \`${cfg.max_history ?? 30}\` (fetch \`${cfg.history_fetch_limit ?? 20}\`) • Max Cont: \`${cfg.max_continuation ?? 3}\``,
        inline: true,
      },
      {
        name: "🧠 Memory & Timing",
        value: `Temp Mem: \`${cfg.temp_memory_enabled !== false ? "ON" : "OFF"}\` (\`${cfg.temp_memory_ttl_minutes ?? 240}m\`)\nSilence: \`${cfg.silence_duration_ms ?? 200}ms\` • Greet: \`${cfg.greet_new_members !== false ? "ON" : "OFF"}\``,
        inline: true,
      },
      {
        name: "💭 AI & Thinking",
        value: `Model Mode: \`${cfg.model_mode || "flash-lite"}\`\nEffort: \`${te.mode || "global"} • ${te.global || "medium"}\`\nWindow: \`${cfg.thinking_window !== false ? "ON" : "OFF"}\` • Show: \`${resolveShowThinkingMode(cfg)}\``,
        inline: true,
      },
      {
        name: "🔧 Feedback, Logging & Voice",
        value: `Feedback: \`${cfg.feedback_system !== false ? "ON" : "OFF"}\` • Logging: \`${cfg.logging !== false ? "ON" : "OFF"}\`\nChat Errors: \`${cfg.show_errors_in_chat ? "SHOW" : "HIDE"}\` • Voice: \`${cfg.voice_name || "Aoede"}\``,
        inline: true,
      }
    )
    .setFooter({ text: "Changes require confirmation before writing to config.json" });

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("cfg_ui:section")
    .setPlaceholder("Choose a config section to edit...")
    .addOptions(
      Object.entries(SECTIONS).map(([key, sec]) => ({
        label: sec.label,
        description: sec.description.substring(0, 100),
        value: key,
        emoji: sec.emoji,
      }))
    );

  const row1 = new ActionRowBuilder().addComponents(selectMenu);
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("cfg_ui:refresh").setLabel("Refresh").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("cfg_ui:raw_json").setLabel("Edit Raw JSON").setEmoji("📝").setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

function buildSectionModal(sectionKey, overrideValues = null) {
  const section = SECTIONS[sectionKey];
  if (!section) return null;

  const cfg = loadConfig();
  const fields = section.buildFields(cfg);

  const modal = new ModalBuilder()
    .setCustomId(`cfg_ui:modal:${sectionKey}`)
    .setTitle(section.title);

  for (const f of fields) {
    const val = overrideValues && overrideValues[f.id] !== undefined
      ? String(overrideValues[f.id])
      : f.value;

    const input = new TextInputBuilder()
      .setCustomId(f.id)
      .setLabel(f.label.substring(0, 45))
      .setStyle(f.style)
      .setRequired(f.required !== false)
      .setValue(val.substring(0, 4000));

    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }

  return modal;
}

function computeConfigDiff(oldObj, newObj, prefix = "") {
  const diffs = [];
  const keys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
  for (const key of keys) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const oldVal = oldObj?.[key];
    const newVal = newObj?.[key];
    const bothObjects = oldVal && newVal && typeof oldVal === "object" && typeof newVal === "object" && !Array.isArray(oldVal) && !Array.isArray(newVal);
    if (bothObjects) {
      diffs.push(...computeConfigDiff(oldVal, newVal, fullKey));
    } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      diffs.push({
        key: fullKey,
        oldStr: JSON.stringify(oldVal),
        newStr: JSON.stringify(newVal),
      });
    }
  }
  return diffs;
}

export async function openConfigHub(interaction) {
  const payload = buildConfigHubPayload();
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

export async function handleConfigUIInteraction(interaction) {
  const customId = interaction.customId || "";
  if (!customId.startsWith("cfg_ui:")) return false;

  if (!isAdminUser(interaction.user.id)) {
    await interaction.reply({ content: "❌ You are not on the bot's admin whitelist.", flags: MessageFlags.Ephemeral });
    return true;
  }

  cleanupExpired(pendingDrafts);
  cleanupExpired(pendingConfirms);

  // Select menu -> open section modal
  if (interaction.isStringSelectMenu() && customId === "cfg_ui:section") {
    const sectionKey = interaction.values[0];
    const modal = buildSectionModal(sectionKey);
    if (!modal) {
      await interaction.reply({ content: "❌ Unknown config section.", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.showModal(modal);
    return true;
  }

  // Buttons
  if (interaction.isButton()) {
    if (customId === "cfg_ui:refresh") {
      await interaction.update(buildConfigHubPayload());
      return true;
    }

    if (customId === "cfg_ui:raw_json") {
      const modal = buildSectionModal("raw_json");
      await interaction.showModal(modal);
      return true;
    }

    if (customId.startsWith("cfg_ui:retry:")) {
      const draftId = customId.slice("cfg_ui:retry:".length);
      const draft = pendingDrafts.get(`${interaction.user.id}:${draftId}`);
      if (!draft) {
        await interaction.reply({ content: "⚠️ That form draft expired. Please select the section again in `/config`.", flags: MessageFlags.Ephemeral });
        return true;
      }
      const modal = buildSectionModal(draft.sectionKey, draft.rawValues);
      await interaction.showModal(modal);
      return true;
    }

    if (customId.startsWith("cfg_ui:confirm:")) {
      const confirmId = customId.slice("cfg_ui:confirm:".length);
      const key = `${interaction.user.id}:${confirmId}`;
      const pending = pendingConfirms.get(key);
      if (!pending) {
        await interaction.update({ content: "⚠️ Pending changes expired. Please submit the form again.", embeds: [], components: [] });
        return true;
      }
      pendingConfirms.delete(key);
      try {
        fs.writeFileSync("config.json", JSON.stringify(pending.nextConfig, null, 2), "utf-8");
        const embed = new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle("✅ Configuration Saved")
          .setDescription(pending.diffText);
        await interaction.update({ embeds: [embed], components: [] });
      } catch (err) {
        await interaction.update({ content: `❌ Failed to save \`config.json\`: ${err.message}`, embeds: [], components: [] });
      }
      return true;
    }

    if (customId.startsWith("cfg_ui:cancel:")) {
      const confirmId = customId.slice("cfg_ui:cancel:".length);
      pendingConfirms.delete(`${interaction.user.id}:${confirmId}`);
      await interaction.update({ content: "❌ Changes cancelled. Nothing was saved.", embeds: [], components: [] });
      return true;
    }
  }

  // Modal Submit -> validate & prompt to correct OR confirm/cancel
  if (interaction.isModalSubmit() && customId.startsWith("cfg_ui:modal:")) {
    const sectionKey = customId.slice("cfg_ui:modal:".length);
    const section = SECTIONS[sectionKey];
    if (!section) {
      await interaction.reply({ content: "❌ Unknown config section.", flags: MessageFlags.Ephemeral });
      return true;
    }

    const currentCfg = loadConfig();
    const fields = section.buildFields(currentCfg);
    const rawValues = {};
    for (const f of fields) {
      rawValues[f.id] = interaction.fields.getTextInputValue(f.id);
    }

    const errors = [];
    let nextCfg = structuredClone(currentCfg);
    const overrideRoot = section.validate(rawValues, nextCfg, errors);
    if (overrideRoot && typeof overrideRoot === "object") {
      nextCfg = overrideRoot;
    }

    if (errors.length > 0) {
      const draftId = crypto.randomBytes(6).toString("hex");
      pendingDrafts.set(`${interaction.user.id}:${draftId}`, {
        sectionKey,
        rawValues,
        createdAt: Date.now(),
      });

      const errEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle(`❌ Validation Failed (${section.label})`)
        .setDescription(`Nothing was saved. Please fix the following issue(s):\n\n${errors.map(e => `• ${e}`).join("\n")}`);

      const retryRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`cfg_ui:retry:${draftId}`)
          .setLabel("Fix & Re-open Form")
          .setEmoji("✏️")
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.reply({ embeds: [errEmbed], components: [retryRow], flags: MessageFlags.Ephemeral });
      return true;
    }

    const diffs = computeConfigDiff(currentCfg, nextCfg);
    if (diffs.length === 0) {
      await interaction.reply({ content: "ℹ️ No changes detected. Nothing was modified.", flags: MessageFlags.Ephemeral });
      return true;
    }

    const diffText = diffs
      .map(d => `• \`${d.key}\`: ${d.oldStr} → **${d.newStr}**`)
      .join("\n")
      .substring(0, 4000);

    const confirmId = crypto.randomBytes(6).toString("hex");
    pendingConfirms.set(`${interaction.user.id}:${confirmId}`, {
      nextConfig: nextCfg,
      diffText,
      createdAt: Date.now(),
    });

    const confirmEmbed = new EmbedBuilder()
      .setColor(0xFEE75C)
      .setTitle(`📝 Confirm Changes (${section.label})`)
      .setDescription(`Review the changes below before saving to \`config.json\`:\n\n${diffText}`);

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cfg_ui:confirm:${confirmId}`).setLabel("Confirm & Save").setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cfg_ui:cancel:${confirmId}`).setLabel("Cancel").setEmoji("❌").setStyle(ButtonStyle.Danger)
    );

    await interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], flags: MessageFlags.Ephemeral });
    return true;
  }

  return false;
}
