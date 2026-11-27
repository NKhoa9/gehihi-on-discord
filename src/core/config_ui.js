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
import {
  SECTIONS,
  resolveShowThinkingMode,
  isAdminUser,
  validateSectionInput,
} from "./config_schema.js";

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

    const style = f.type === "json" ? TextInputStyle.Paragraph : TextInputStyle.Short;

    const input = new TextInputBuilder()
      .setCustomId(f.id)
      .setLabel(f.label.substring(0, 45))
      .setStyle(style)
      .setRequired(f.required !== false)
      .setValue(val.substring(0, 4000));

    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }

  return modal;
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

    const validation = validateSectionInput(sectionKey, rawValues, currentCfg);

    if (!validation.valid) {
      const draftId = crypto.randomBytes(6).toString("hex");
      pendingDrafts.set(`${interaction.user.id}:${draftId}`, {
        sectionKey,
        rawValues,
        createdAt: Date.now(),
      });

      const errEmbed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle(`❌ Validation Failed (${section.label})`)
        .setDescription(`Nothing was saved. Please fix the following issue(s):\n\n${validation.errors.map(e => `• ${e}`).join("\n")}`);

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

    if (validation.diffs.length === 0) {
      await interaction.reply({ content: "ℹ️ No changes detected. Nothing was modified.", flags: MessageFlags.Ephemeral });
      return true;
    }

    const diffText = validation.diffs
      .map(d => `• \`${d.key}\`: ${d.oldStr} → **${d.newStr}**`)
      .join("\n")
      .substring(0, 4000);

    const confirmId = crypto.randomBytes(6).toString("hex");
    pendingConfirms.set(`${interaction.user.id}:${confirmId}`, {
      nextConfig: validation.nextConfig,
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
