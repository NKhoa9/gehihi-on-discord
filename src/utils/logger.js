import fs from "fs";

const CONFIG_FILE = "config.json";
const LOGGING_CONFIG_FILE = "logging.json";

export const LOG_LEVELS = ["debug", "info", "warn", "error"];

export const LOG_CATEGORIES = [
  "ai_raw_input",
  "ai_raw_output",
  "ai_system_prompt",
  "ai_routing",
  "triggers",
  "discord",
  "memory",
  "scheduler",
  "media",
  "voice",
  "system",
];

export const DEFAULT_LOGGING_CONFIG = {
  console: true,
  file: true,
  log_file: "bot.log",
  max_file_size_mb: 10,
  raw_max_chars: 0,
  levels: {
    debug: true,
    info: true,
    warn: true,
    error: true,
  },
  categories: {
    ai_raw_input: true,
    ai_raw_output: true,
    ai_system_prompt: true,
    ai_routing: true,
    triggers: true,
    discord: true,
    memory: true,
    scheduler: true,
    media: true,
    voice: true,
    system: true,
  },
};

export const LOG_PRESETS = {
  silent: {
    master: false,
    description: "Disables all logging via config.json (logging: false).",
  },
  minimal: {
    master: true,
    description: "Warnings & errors only across all categories.",
    levels: { debug: false, info: false, warn: true, error: true },
    categories: Object.fromEntries(LOG_CATEGORIES.map(c => [c, true])),
  },
  balanced: {
    master: true,
    description: "Info, warnings & errors; disables debug logs and bulky raw AI dumps.",
    levels: { debug: false, info: true, warn: true, error: true },
    categories: Object.fromEntries(
      LOG_CATEGORIES.map(c => [c, !["ai_raw_input", "ai_raw_output", "ai_system_prompt"].includes(c)])
    ),
  },
  verbose: {
    master: true,
    description: "All levels (including debug) and all categories enabled.",
    levels: { debug: true, info: true, warn: true, error: true },
    categories: Object.fromEntries(LOG_CATEGORIES.map(c => [c, true])),
  },
};

const TAG_CATEGORY_RULES = [
  { prefix: /^\[Raw AI Input\]/i, category: "ai_raw_input" },
  { prefix: /^\[Raw AI Response/i, category: "ai_raw_output" },
  { prefix: /^\[Raw AI System Instruction\]/i, category: "ai_system_prompt" },
  { prefix: /^\[(Classifier|Router|Compare|PromptReply|Models)\]/i, category: "ai_routing" },
  { prefix: /^\[(Trigger:random|SmartTrigger|Ignore|Process)\]/i, category: "triggers" },
  { prefix: /^\[(Startup|Command|Response|Greet|Reactions|Emojis|ChannelControl|Autocomplete)\]/i, category: "discord" },
  { prefix: /^\[(Memory|Feedback)\]/i, category: "memory" },
  { prefix: /^\[Scheduler\]/i, category: "scheduler" },
  { prefix: /^\[(ImageGen|VideoGen|SearchImg|SaveImg|Attachment|Cache|History)\]/i, category: "media" },
  { prefix: /^\[Voice\]/i, category: "voice" },
];

function mergeWithDefaults(raw = {}) {
  return {
    console: raw.console !== false,
    file: raw.file !== false,
    log_file: typeof raw.log_file === "string" && raw.log_file.trim() ? raw.log_file.trim() : DEFAULT_LOGGING_CONFIG.log_file,
    max_file_size_mb: Number.isFinite(Number(raw.max_file_size_mb)) && Number(raw.max_file_size_mb) >= 0
      ? Number(raw.max_file_size_mb)
      : DEFAULT_LOGGING_CONFIG.max_file_size_mb,
    raw_max_chars: Number.isFinite(Number(raw.raw_max_chars)) && Number(raw.raw_max_chars) >= 0
      ? Math.floor(Number(raw.raw_max_chars))
      : DEFAULT_LOGGING_CONFIG.raw_max_chars,
    levels: { ...DEFAULT_LOGGING_CONFIG.levels, ...(raw.levels || {}) },
    categories: { ...DEFAULT_LOGGING_CONFIG.categories, ...(raw.categories || {}) },
  };
}

/**
 * Reads the master `logging` switch from config.json.
 * @returns {boolean}
 */
export function isLoggingMasterEnabled() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return true;
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    return cfg.logging !== false;
  } catch {
    return true;
  }
}

/**
 * Updates the master `logging` switch in config.json.
 * @param {boolean} enabled
 */
export function setLoggingMasterEnabled(enabled) {
  let cfg = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  cfg.logging = !!enabled;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
  return cfg.logging;
}

/**
 * Loads logging options from logging.json, creating it with defaults if missing.
 * @returns {typeof DEFAULT_LOGGING_CONFIG}
 */
export function loadLoggingConfig() {
  try {
    if (fs.existsSync(LOGGING_CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(LOGGING_CONFIG_FILE, "utf-8"));
      return mergeWithDefaults(parsed);
    }
    const defaults = mergeWithDefaults();
    fs.writeFileSync(LOGGING_CONFIG_FILE, JSON.stringify(defaults, null, 2), "utf-8");
    return defaults;
  } catch {
    return mergeWithDefaults();
  }
}

/**
 * Saves logging options to logging.json.
 * @param {object} nextConfig
 * @returns {typeof DEFAULT_LOGGING_CONFIG}
 */
export function saveLoggingConfig(nextConfig) {
  const merged = mergeWithDefaults(nextConfig);
  fs.writeFileSync(LOGGING_CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

/**
 * Detects a log category from the formatted message text's leading [Tag].
 * @param {string} message
 * @returns {string}
 */
export function detectCategory(message) {
  const trimmed = (message || "").trimStart();
  for (const rule of TAG_CATEGORY_RULES) {
    if (rule.prefix.test(trimmed)) return rule.category;
  }
  return "system";
}

function formatArgs(args) {
  return args
    .map(a => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === "object" && a !== null) {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(" ");
}

function rotateLogFileIfNeeded(logFile, maxMb) {
  if (!maxMb || maxMb <= 0) return;
  try {
    if (!fs.existsSync(logFile)) return;
    const stats = fs.statSync(logFile);
    if (stats.size >= maxMb * 1024 * 1024) {
      const backupFile = `${logFile}.old`;
      if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
      fs.renameSync(logFile, backupFile);
    }
  } catch {}
}

function shouldEmit(level, category, logCfg) {
  if (!isLoggingMasterEnabled()) return false;
  if (logCfg.levels?.[level] === false) return false;
  if (category && logCfg.categories?.[category] === false) return false;
  return true;
}

function writeEntry(level, categoryOverride, args) {
  const logCfg = loadLoggingConfig();
  const body = formatArgs(args);
  const category = categoryOverride || detectCategory(body);

  if (!shouldEmit(level, category, logCfg)) return;
  if (!logCfg.console && !logCfg.file) return;

  const levelTag = level.toUpperCase();
  const formatted = `[${new Date().toISOString()}] [${levelTag}] [${category}] ${body}`;

  if (logCfg.console) {
    if (level === "error") console.error(formatted);
    else if (level === "warn") console.warn(formatted);
    else console.log(formatted);
  }

  if (logCfg.file) {
    try {
      rotateLogFileIfNeeded(logCfg.log_file, logCfg.max_file_size_mb);
      fs.appendFileSync(logCfg.log_file, formatted + "\n");
    } catch {}
  }
}

export const logger = {
  debug: (...args) => writeEntry("debug", null, args),
  log: (...args) => writeEntry("info", null, args),
  info: (...args) => writeEntry("info", null, args),
  warn: (...args) => writeEntry("warn", null, args),
  error: (...args) => writeEntry("error", null, args),

  /**
   * Logs under an explicit category ("ai_routing", "triggers", "discord", etc.).
   */
  cat: (category, level = "info", ...args) => {
    const normalized = level === "log" ? "info" : level;
    writeEntry(LOG_LEVELS.includes(normalized) ? normalized : "info", category, args);
  },

  /**
   * Unified helper for raw AI input/output/system prompt logging with optional character cap.
   * @param {"input"|"output"|"system"} kind
   * @param {string} label
   * @param {string} body
   */
  rawAI: (kind, label, body) => {
    const map = {
      input: { category: "ai_raw_input", level: "info" },
      output: { category: "ai_raw_output", level: "info" },
      system: { category: "ai_system_prompt", level: "debug" },
    };
    const meta = map[kind];
    if (!meta) return;

    const logCfg = loadLoggingConfig();
    if (!shouldEmit(meta.level, meta.category, logCfg)) return;

    let text = String(body || "");
    if (logCfg.raw_max_chars > 0 && text.length > logCfg.raw_max_chars) {
      text = `${text.substring(0, logCfg.raw_max_chars)}... [truncated ${text.length - logCfg.raw_max_chars} chars]`;
    }
    writeEntry(meta.level, meta.category, [`\n[${label}]:\n${text}\n--------------------------`]);
  },

  /**
   * Clears (or truncates) the active log file.
   */
  clearLogFile: () => {
    const logCfg = loadLoggingConfig();
    fs.writeFileSync(logCfg.log_file, "", "utf-8");
    return logCfg.log_file;
  },
};
