import { loadConfig, saveConfig } from "../utils/config.js";

export function resolveShowThinkingMode(cfg) {
  const val = cfg?.show_thinking;
  if (val === true) return "spoiler";
  if (!val || val === false) return "off";
  const lower = String(val).toLowerCase();
  return ["off", "spoiler", "visible", "embed"].includes(lower) ? lower : "off";
}

export function getAdminIds() {
  const adminEnv = process.env.ADMINS || "";
  return adminEnv.split(",").map(id => id.trim()).filter(Boolean);
}

export function isAdminUser(userId) {
  return getAdminIds().includes(String(userId));
}

export function parseBoolInput(raw, fieldName, errors) {
  if (typeof raw === "boolean") return raw;
  const lower = String(raw).trim().toLowerCase();
  if (["true", "on", "1", "yes"].includes(lower)) return true;
  if (["false", "off", "0", "no"].includes(lower)) return false;
  errors.push(`**${fieldName}**: must be \`true\`/\`on\` or \`false\`/\`off\` (got \`${raw}\`).`);
  return null;
}

export function parseIntInput(raw, fieldName, errors, { min = -Infinity, max = Infinity } = {}) {
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

export function parseFloatInput(raw, fieldName, errors, { min = -Infinity, max = Infinity } = {}) {
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

export const SECTIONS = {
  core: {
    label: "Core & Chat",
    description: "response_mode, random_appear_rate, history limits, max_continuation",
    emoji: "💬",
    title: "Edit Core & Chat Settings",
    buildFields: (cfg) => [
      {
        id: "response_mode",
        label: "response_mode (smart | random)",
        value: String(cfg.response_mode || "smart"),
        type: "select",
        options: ["smart", "random"],
        help: "smart uses the classifier AI; random replies at random_appear_rate.",
      },
      {
        id: "random_appear_rate",
        label: "random_appear_rate (0.0 - 1.0)",
        value: String(cfg.random_appear_rate ?? 0.2),
        type: "number",
        min: 0,
        max: 1,
        step: 0.05,
        help: "Probability of replying in random mode (0.0 to 1.0).",
      },
      {
        id: "max_history",
        label: "max_history (>= 1)",
        value: String(cfg.max_history ?? 30),
        type: "integer",
        min: 1,
        step: 1,
        help: "Maximum messages kept per channel context.",
      },
      {
        id: "history_fetch_limit",
        label: "history_fetch_limit (0 - 100)",
        value: String(cfg.history_fetch_limit ?? 20),
        type: "integer",
        min: 0,
        max: 100,
        step: 1,
        help: "Recent Discord messages fetched on startup/empty cache.",
      },
      {
        id: "max_continuation",
        label: "max_continuation (0 - 10)",
        value: String(cfg.max_continuation ?? 3),
        type: "integer",
        min: 0,
        max: 10,
        step: 1,
        help: "Max chained follow-up turns for multi-part responses.",
      },
    ],
    validate: (raw, nextCfg, errors) => {
      const mode = String(raw.response_mode ?? "").trim().toLowerCase();
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
      {
        id: "temp_memory_enabled",
        label: "temp_memory_enabled (true | false)",
        value: String(cfg.temp_memory_enabled !== false),
        type: "boolean",
        help: "Enable short-term channel memory summaries.",
      },
      {
        id: "temp_memory_ttl_minutes",
        label: "temp_memory_ttl_minutes (>= 1)",
        value: String(cfg.temp_memory_ttl_minutes ?? 240),
        type: "integer",
        min: 1,
        step: 1,
        help: "Minutes before temporary channel memory expires.",
      },
      {
        id: "silence_duration_ms",
        label: "silence_duration_ms (>= 0)",
        value: String(cfg.silence_duration_ms ?? 200),
        type: "integer",
        min: 0,
        step: 50,
        help: "Silence window (ms) for voice/audio detection.",
      },
      {
        id: "greet_new_members",
        label: "greet_new_members (true | false)",
        value: String(cfg.greet_new_members !== false),
        type: "boolean",
        help: "Send an AI greeting when new members join.",
      },
      {
        id: "greet_channel_id",
        label: "greet_channel_id (channel ID or none)",
        value: cfg.greet_channel_id ? String(cfg.greet_channel_id) : "none",
        type: "text",
        required: false,
        nullable: true,
        help: "Discord channel ID for greetings, or 'none' to use system channel.",
      },
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

      const chRaw = String(raw.greet_channel_id ?? "").trim();
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
        {
          id: "model_mode",
          label: "model_mode (flash | flash-lite)",
          value: String(cfg.model_mode || "flash-lite"),
          type: "select",
          options: ["flash-lite", "flash"],
          help: "Default model tier for normal replies.",
        },
        {
          id: "thinking_mode",
          label: "thinking_effort.mode (global | local)",
          value: String(te.mode || "global"),
          type: "select",
          options: ["global", "local"],
          help: "Use global effort for all models or per-model local overrides.",
        },
        {
          id: "thinking_global",
          label: "thinking_effort.global (low|medium|high)",
          value: String(te.global || "medium"),
          type: "select",
          options: ["low", "medium", "high"],
          help: "Default reasoning effort level.",
        },
        {
          id: "thinking_window",
          label: "thinking_window (true | false)",
          value: String(cfg.thinking_window !== false),
          type: "boolean",
          help: "Enable thinking window for supported non-Gemini models.",
        },
        {
          id: "show_thinking",
          label: "show_thinking (off|spoiler|visible|embed)",
          value: resolveShowThinkingMode(cfg),
          type: "select",
          options: ["off", "spoiler", "visible", "embed"],
          help: "How AI reasoning traces are displayed in Discord.",
        },
      ];
    },
    validate: (raw, nextCfg, errors) => {
      const mm = String(raw.model_mode ?? "").trim().toLowerCase();
      if (mm !== "flash" && mm !== "flash-lite") {
        errors.push(`**model_mode**: must be \`flash\` or \`flash-lite\` (got \`${raw.model_mode}\`).`);
      } else {
        nextCfg.model_mode = mm;
      }

      if (!nextCfg.thinking_effort) nextCfg.thinking_effort = { mode: "global", global: "medium", local: {} };
      const tm = String(raw.thinking_mode ?? "").trim().toLowerCase();
      if (tm !== "global" && tm !== "local") {
        errors.push(`**thinking_effort.mode**: must be \`global\` or \`local\` (got \`${raw.thinking_mode}\`).`);
      } else {
        nextCfg.thinking_effort.mode = tm;
      }

      const tg = String(raw.thinking_global ?? "").trim().toLowerCase();
      if (!["low", "medium", "high"].includes(tg)) {
        errors.push(`**thinking_effort.global**: must be \`low\`, \`medium\`, or \`high\` (got \`${raw.thinking_global}\`).`);
      } else {
        nextCfg.thinking_effort.global = tg;
      }

      const tw = parseBoolInput(raw.thinking_window, "thinking_window", errors);
      if (tw !== null) nextCfg.thinking_window = tw;

      const stLower = String(raw.show_thinking ?? "").trim().toLowerCase();
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
      {
        id: "feedback_system",
        label: "feedback_system (true | false)",
        value: String(cfg.feedback_system !== false),
        type: "boolean",
        help: "React with ⬆️/⬇️ on bot messages for feedback rating.",
      },
      {
        id: "logging",
        label: "logging (true | false)",
        value: String(cfg.logging !== false),
        type: "boolean",
        help: "Master logging switch in config.json.",
      },
      {
        id: "show_errors_in_chat",
        label: "show_errors_in_chat (true | false)",
        value: String(cfg.show_errors_in_chat === true),
        type: "boolean",
        help: "Post AI/API errors directly into Discord chat.",
      },
      {
        id: "voice_name",
        label: "voice_name (e.g. Aoede, Puck, Kore)",
        value: String(cfg.voice_name || "Aoede"),
        type: "text",
        help: "Voice persona used for live voice sessions.",
      },
    ],
    validate: (raw, nextCfg, errors) => {
      const fb = parseBoolInput(raw.feedback_system, "feedback_system", errors);
      if (fb !== null) nextCfg.feedback_system = fb;
      const log = parseBoolInput(raw.logging, "logging", errors);
      if (log !== null) nextCfg.logging = log;
      const errChat = parseBoolInput(raw.show_errors_in_chat, "show_errors_in_chat", errors);
      if (errChat !== null) nextCfg.show_errors_in_chat = errChat;

      const voice = String(raw.voice_name ?? "").trim();
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
          value: jsonStr,
          type: "json",
          help: "Edit the full config.json document directly.",
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
      if (parsed.random_appear_rate !== undefined && (typeof parsed.random_appear_rate !== "number" || !Number.isFinite(parsed.random_appear_rate) || parsed.random_appear_rate < 0 || parsed.random_appear_rate > 1)) {
        errors.push(`**random_appear_rate**: must be a number between 0 and 1.`);
      }
      if (parsed.max_history !== undefined && (!Number.isInteger(parsed.max_history) || parsed.max_history < 1)) {
        errors.push(`**max_history**: must be an integer >= 1.`);
      }
      if (parsed.history_fetch_limit !== undefined && (!Number.isInteger(parsed.history_fetch_limit) || parsed.history_fetch_limit < 0 || parsed.history_fetch_limit > 100)) {
        errors.push(`**history_fetch_limit**: must be an integer between 0 and 100.`);
      }
      if (parsed.max_continuation !== undefined && (!Number.isInteger(parsed.max_continuation) || parsed.max_continuation < 0 || parsed.max_continuation > 10)) {
        errors.push(`**max_continuation**: must be an integer between 0 and 10.`);
      }
      if (parsed.temp_memory_ttl_minutes !== undefined && (!Number.isInteger(parsed.temp_memory_ttl_minutes) || parsed.temp_memory_ttl_minutes < 1)) {
        errors.push(`**temp_memory_ttl_minutes**: must be an integer >= 1.`);
      }
      if (parsed.silence_duration_ms !== undefined && (!Number.isInteger(parsed.silence_duration_ms) || parsed.silence_duration_ms < 0)) {
        errors.push(`**silence_duration_ms**: must be an integer >= 0.`);
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

export function computeConfigDiff(oldObj, newObj, prefix = "") {
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
        oldValue: oldVal,
        newValue: newVal,
        oldStr: JSON.stringify(oldVal),
        newStr: JSON.stringify(newVal),
      });
    }
  }
  return diffs;
}

export function validateSectionInput(sectionKey, rawValues, currentCfg = loadConfig()) {
  const section = SECTIONS[sectionKey];
  if (!section) {
    return { valid: false, errors: [`Unknown config section: ${sectionKey}`], nextConfig: null, diffs: [] };
  }

  const errors = [];
  let nextCfg = structuredClone(currentCfg);
  const overrideRoot = section.validate(rawValues || {}, nextCfg, errors);
  if (overrideRoot && typeof overrideRoot === "object") {
    nextCfg = overrideRoot;
  }

  if (errors.length > 0) {
    return { valid: false, errors, nextConfig: null, diffs: [] };
  }

  const diffs = computeConfigDiff(currentCfg, nextCfg);
  return { valid: true, errors: [], nextConfig: nextCfg, diffs };
}

export function applySectionUpdate(sectionKey, rawValues) {
  const currentCfg = loadConfig();
  const result = validateSectionInput(sectionKey, rawValues, currentCfg);
  if (!result.valid) return { ...result, saved: false };
  if (result.diffs.length === 0) return { ...result, saved: false, unchanged: true };

  saveConfig(result.nextConfig);
  return { ...result, saved: true, unchanged: false };
}

export function getWebSectionsSchema(cfg = loadConfig()) {
  return Object.entries(SECTIONS).map(([key, sec]) => ({
    key,
    label: sec.label,
    description: sec.description,
    emoji: sec.emoji,
    title: sec.title,
    fields: sec.buildFields(cfg).map(f => ({
      id: f.id,
      label: f.label,
      value: f.value,
      type: f.type || "text",
      options: f.options || null,
      min: f.min ?? null,
      max: f.max ?? null,
      step: f.step ?? null,
      required: f.required !== false,
      nullable: Boolean(f.nullable),
      help: f.help || "",
    })),
  }));
}
