import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  logger,
  LOG_CATEGORIES,
  LOG_LEVELS,
  LOG_PRESETS,
  DEFAULT_LOGGING_CONFIG,
  isLoggingMasterEnabled,
  setLoggingMasterEnabled,
  loadLoggingConfig,
  saveLoggingConfig,
} from "../utils/logger.js";
import { loadConfig, saveConfig } from "../utils/config.js";
import {
  getWebSectionsSchema,
  validateSectionInput,
  applySectionUpdate,
  resolveShowThinkingMode,
} from "../core/config_schema.js";
import {
  disableChannel,
  enableChannel,
} from "../core/channel_control.js";
import {
  getScheduledTasks,
  addScheduledTask,
  removeScheduledTask,
  toggleScheduledTask,
} from "../core/scheduler.js";
import {
  loadModelRegistry,
  createCustomSeries,
  deleteCustomSeries,
  createTaskCategory,
  deleteTaskCategory,
  addModelToSeries,
  removeModelFromSeries,
  moveModelInSeries,
  addModelToTask,
  removeModelFromTask,
  moveModelInTask,
} from "../ai/models.js";
import {
  initWebAuth,
  getAuthenticatedUser,
  verifyPasswordLogin,
  setSessionCookie,
  clearSessionCookie,
  getAuthCapabilities,
  beginDiscordOAuth,
  handleDiscordOAuthCallback,
} from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON request body."));
      }
    });
    req.on("error", reject);
  });
}

function getDiscordContext(client) {
  if (!client?.isReady?.()) {
    return { ready: false, tag: null, guildCount: 0, guilds: [], channels: [] };
  }
  const guilds = [];
  const channels = [];
  for (const guild of client.guilds.cache.values()) {
    guilds.push({ id: guild.id, name: guild.name });
    for (const ch of guild.channels.cache.values()) {
      if (ch.isTextBased?.() && !ch.isThread?.()) {
        channels.push({
          id: ch.id,
          name: ch.name,
          guildId: guild.id,
          guildName: guild.name,
        });
      }
    }
  }
  channels.sort((a, b) => a.guildName.localeCompare(b.guildName) || a.name.localeCompare(b.name));
  return {
    ready: true,
    tag: client.user?.tag || null,
    guildCount: guilds.length,
    guilds,
    channels,
  };
}

function tailLogLines({ lines = 100, level = "all", category = "all" } = {}) {
  const logCfg = loadLoggingConfig();
  const logFile = logCfg.log_file || "bot.log";
  if (!fs.existsSync(logFile)) {
    return { logFile, totalMatched: 0, lines: [] };
  }

  const stat = fs.statSync(logFile);
  const maxBytes = 256 * 1024;
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(logFile, "r");
  const buffer = Buffer.alloc(stat.size - start);
  fs.readSync(fd, buffer, 0, buffer.length, start);
  fs.closeSync(fd);

  let rawLines = buffer.toString("utf-8").split(/\r?\n/).filter(Boolean);
  if (start > 0 && rawLines.length > 0) {
    rawLines.shift(); // drop partial first line
  }

  if (level && level !== "all") {
    const tag = `[${level.toUpperCase()}]`;
    rawLines = rawLines.filter(line => line.includes(tag));
  }
  if (category && category !== "all") {
    const catTag = `[${category}]`;
    rawLines = rawLines.filter(line => line.includes(catTag));
  }

  const capped = Math.max(1, Math.min(500, Number(lines) || 100));
  return {
    logFile,
    totalMatched: rawLines.length,
    lines: rawLines.slice(-capped),
  };
}

function buildStatePayload(client, port, getAIPaused) {
  const cfg = loadConfig();
  const discord = getDiscordContext(client);
  return {
    bot: {
      ...discord,
      paused: Boolean(getAIPaused?.()),
      port,
    },
    config: cfg,
    sections: getWebSectionsSchema(cfg),
    models: loadModelRegistry(),
    logging: {
      master: isLoggingMasterEnabled(),
      config: loadLoggingConfig(),
      levels: LOG_LEVELS,
      categories: LOG_CATEGORIES,
      presets: Object.entries(LOG_PRESETS).map(([name, val]) => ({
        name,
        description: val.description,
      })),
    },
    scheduledTasks: getScheduledTasks(cfg),
  };
}

function serveStaticFile(reqPath, res) {
  const cleanPath = reqPath === "/" ? "/index.html" : reqPath;
  const normalized = path.normalize(cleanPath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(PUBLIC_DIR, normalized);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const target = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()
    ? fullPath
    : path.join(PUBLIC_DIR, "index.html");

  const ext = path.extname(target).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const content = fs.readFileSync(target);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300",
  });
  res.end(content);
}

function resolvePort() {
  const raw = process.env.WEB_PORT || process.env.PORT || process.env.SERVER_PORT || "3000";
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3000;
}

export function startWebServer({ client, getAIPaused, setAIPaused, onScheduleTaskStart } = {}) {
  if (process.env.WEB_ENABLED === "false") {
    logger.log("[WebUI] Disabled via WEB_ENABLED=false");
    return null;
  }

  initWebAuth();
  const port = resolvePort();
  const host = process.env.WEB_HOST || "0.0.0.0";

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = url.pathname;

      // Health endpoint (public)
      if (req.method === "GET" && pathname === "/api/health") {
        return sendJson(res, 200, {
          ok: true,
          discordReady: Boolean(client?.isReady?.()),
          botTag: client?.user?.tag || null,
        });
      }

      // Auth endpoints (public)
      if (req.method === "GET" && pathname === "/api/auth/status") {
        const user = getAuthenticatedUser(req);
        return sendJson(res, 200, {
          authenticated: Boolean(user),
          user,
          authMethods: getAuthCapabilities(),
        });
      }

      if (req.method === "POST" && pathname === "/api/auth/login") {
        const body = await readJsonBody(req);
        if (!verifyPasswordLogin(body.password)) {
          return sendJson(res, 401, { error: "Invalid password or token." });
        }
        const user = { id: "web-admin", username: "Admin", method: "password" };
        setSessionCookie(res, req, user);
        return sendJson(res, 200, { ok: true, user });
      }

      if (req.method === "POST" && pathname === "/api/auth/logout") {
        clearSessionCookie(res, req);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "GET" && pathname === "/api/auth/discord") {
        return beginDiscordOAuth(req, res);
      }

      if (req.method === "GET" && pathname === "/api/auth/discord/callback") {
        return await handleDiscordOAuthCallback(req, res, url.searchParams);
      }

      // Protected /api/* routes
      if (pathname.startsWith("/api/")) {
        const user = getAuthenticatedUser(req);
        if (!user) {
          return sendJson(res, 401, { error: "Authentication required." });
        }

        if (req.method === "GET" && pathname === "/api/state") {
          return sendJson(res, 200, buildStatePayload(client, port, getAIPaused));
        }

        if (req.method === "POST" && pathname === "/api/config/validate") {
          const body = await readJsonBody(req);
          const result = validateSectionInput(body.section, body.values, loadConfig());
          return sendJson(res, result.valid ? 200 : 400, {
            valid: result.valid,
            errors: result.errors,
            diffs: result.diffs,
          });
        }

        if (req.method === "PUT" && pathname === "/api/config/section") {
          const body = await readJsonBody(req);
          const result = applySectionUpdate(body.section, body.values);
          if (!result.valid) {
            return sendJson(res, 400, { valid: false, errors: result.errors });
          }
          return sendJson(res, 200, {
            valid: true,
            saved: result.saved,
            unchanged: Boolean(result.unchanged),
            diffs: result.diffs,
            state: buildStatePayload(client, port, getAIPaused),
          });
        }

        if (req.method === "POST" && pathname === "/api/bot/pause") {
          const body = await readJsonBody(req);
          const nextPaused = typeof body.paused === "boolean" ? body.paused : !Boolean(getAIPaused?.());
          setAIPaused?.(nextPaused);
          logger.log(`[WebUI] AI pause state set to ${nextPaused} by ${user.username}`);
          return sendJson(res, 200, { paused: Boolean(getAIPaused?.()) });
        }

        if (req.method === "POST" && pathname === "/api/channels/disable") {
          const body = await readJsonBody(req);
          const channelId = String(body.channelId || "").replace(/[<#>]/g, "").trim();
          if (!/^\d{15,22}$/.test(channelId)) {
            return sendJson(res, 400, { error: "Provide a valid Discord channel ID." });
          }
          const result = disableChannel(channelId);
          return sendJson(res, 200, { ...result, disabled_channels: result.list });
        }

        if (req.method === "POST" && pathname === "/api/channels/enable") {
          const body = await readJsonBody(req);
          const channelId = String(body.channelId || "").trim();
          if (!channelId) {
            return sendJson(res, 400, { error: "Channel ID is required." });
          }
          const result = enableChannel(channelId);
          return sendJson(res, 200, { ...result, disabled_channels: result.list });
        }

        if (req.method === "PUT" && pathname === "/api/thinking") {
          const body = await readJsonBody(req);
          const cfg = loadConfig();
          if (!cfg.thinking_effort) {
            cfg.thinking_effort = { mode: "global", global: "medium", local: {} };
          }
          if (!cfg.thinking_effort.local) cfg.thinking_effort.local = {};

          if (body.mode !== undefined) {
            const m = String(body.mode).toLowerCase();
            if (!["global", "local"].includes(m)) {
              return sendJson(res, 400, { error: "thinking_effort.mode must be 'global' or 'local'." });
            }
            cfg.thinking_effort.mode = m;
          }
          if (body.global !== undefined) {
            const g = String(body.global).toLowerCase();
            if (!["low", "medium", "high"].includes(g)) {
              return sendJson(res, 400, { error: "thinking_effort.global must be low, medium, or high." });
            }
            cfg.thinking_effort.global = g;
          }
          if (body.thinking_window !== undefined) {
            cfg.thinking_window = Boolean(body.thinking_window);
          }
          if (body.show_thinking !== undefined) {
            const st = String(body.show_thinking).toLowerCase();
            if (!["off", "spoiler", "visible", "embed"].includes(st)) {
              return sendJson(res, 400, { error: "show_thinking must be off, spoiler, visible, or embed." });
            }
            cfg.show_thinking = st;
          }
          if (body.setLocal && typeof body.setLocal === "object") {
            const modelName = String(body.setLocal.model || "").trim();
            const effort = String(body.setLocal.effort || "").toLowerCase();
            if (!modelName) return sendJson(res, 400, { error: "Model name is required." });
            if (!["low", "medium", "high"].includes(effort)) {
              return sendJson(res, 400, { error: "Effort must be low, medium, or high." });
            }
            cfg.thinking_effort.local[modelName] = effort;
          }
          if (body.removeLocal) {
            delete cfg.thinking_effort.local[String(body.removeLocal)];
          }

          saveConfig(cfg);
          return sendJson(res, 200, {
            thinking_effort: cfg.thinking_effort,
            thinking_window: cfg.thinking_window !== false,
            show_thinking: resolveShowThinkingMode(cfg),
          });
        }

        if (req.method === "POST" && pathname === "/api/models/series") {
          const body = await readJsonBody(req);
          const { action, series, model, direction, position, initialModels } = body;
          let result;
          if (action === "create") {
            result = createCustomSeries(series, initialModels || []);
          } else if (action === "delete") {
            result = deleteCustomSeries(series);
          } else if (action === "add_model") {
            if (!String(model || "").trim()) return sendJson(res, 400, { error: "Model name is required." });
            result = addModelToSeries(series, String(model).trim(), position ?? null);
          } else if (action === "remove_model") {
            result = removeModelFromSeries(series, model);
          } else if (action === "move_model") {
            result = moveModelInSeries(series, model, { direction, position });
          } else {
            return sendJson(res, 400, { error: "Unknown series action." });
          }
          if (!result.success) {
            return sendJson(res, 400, { error: result.error || "Operation failed.", result });
          }
          return sendJson(res, 200, { result, models: loadModelRegistry() });
        }

        if (req.method === "POST" && pathname === "/api/models/task") {
          const body = await readJsonBody(req);
          const { action, category, item, direction, position, initialItems } = body;
          let result;
          if (action === "create") {
            result = createTaskCategory(category, initialItems || []);
          } else if (action === "delete") {
            result = deleteTaskCategory(category);
          } else if (action === "add_item") {
            if (!String(item || "").trim()) return sendJson(res, 400, { error: "Item name is required." });
            result = addModelToTask(category, String(item).trim(), position ?? null);
          } else if (action === "remove_item") {
            result = removeModelFromTask(category, item);
          } else if (action === "move_item") {
            result = moveModelInTask(category, item, { direction, position });
          } else {
            return sendJson(res, 400, { error: "Unknown task category action." });
          }
          if (!result.success) {
            return sendJson(res, 400, { error: result.error || "Operation failed.", result });
          }
          return sendJson(res, 200, { result, config: loadConfig() });
        }

        if (req.method === "PUT" && pathname === "/api/models/compare") {
          const body = await readJsonBody(req);
          const cfg = loadConfig();
          const current = cfg.model_compare || { enabled: false, models: [] };
          if (typeof body.enabled === "boolean") current.enabled = body.enabled;
          if (Array.isArray(body.models)) {
            current.models = [...new Set(body.models.map(m => String(m).trim()).filter(Boolean))];
          }
          cfg.model_compare = current;
          saveConfig(cfg);
          return sendJson(res, 200, { model_compare: cfg.model_compare });
        }

        if (req.method === "PUT" && pathname === "/api/logging") {
          const body = await readJsonBody(req);
          if (body.action === "clear_file") {
            const file = logger.clearLogFile();
            return sendJson(res, 200, { cleared: file });
          }
          if (body.action === "reset") {
            setLoggingMasterEnabled(true);
            const saved = saveLoggingConfig(DEFAULT_LOGGING_CONFIG);
            return sendJson(res, 200, { master: true, config: saved });
          }
          if (body.preset) {
            const preset = LOG_PRESETS[body.preset];
            if (!preset) return sendJson(res, 400, { error: "Unknown logging preset." });
            setLoggingMasterEnabled(preset.master);
            const logCfg = loadLoggingConfig();
            if (preset.levels) logCfg.levels = { ...logCfg.levels, ...preset.levels };
            if (preset.categories) logCfg.categories = { ...logCfg.categories, ...preset.categories };
            const saved = saveLoggingConfig(logCfg);
            return sendJson(res, 200, { master: isLoggingMasterEnabled(), config: saved });
          }

          if (typeof body.master === "boolean") {
            setLoggingMasterEnabled(body.master);
          }

          const logCfg = loadLoggingConfig();
          if (typeof body.console === "boolean") logCfg.console = body.console;
          if (typeof body.file === "boolean") logCfg.file = body.file;
          if (body.max_file_size_mb !== undefined) {
            const n = Number(body.max_file_size_mb);
            if (!Number.isInteger(n) || n < 1) return sendJson(res, 400, { error: "max_file_size_mb must be an integer >= 1." });
            logCfg.max_file_size_mb = n;
          }
          if (body.raw_max_chars !== undefined) {
            const n = Number(body.raw_max_chars);
            if (!Number.isInteger(n) || n < 0) return sendJson(res, 400, { error: "raw_max_chars must be an integer >= 0." });
            logCfg.raw_max_chars = n;
          }
          if (body.levels && typeof body.levels === "object") {
            for (const lvl of LOG_LEVELS) {
              if (typeof body.levels[lvl] === "boolean") logCfg.levels[lvl] = body.levels[lvl];
            }
          }
          if (body.categories && typeof body.categories === "object") {
            for (const cat of LOG_CATEGORIES) {
              if (typeof body.categories[cat] === "boolean") logCfg.categories[cat] = body.categories[cat];
            }
          }

          const saved = saveLoggingConfig(logCfg);
          return sendJson(res, 200, { master: isLoggingMasterEnabled(), config: saved });
        }

        if (req.method === "GET" && pathname === "/api/logs") {
          const lines = url.searchParams.get("lines") || "100";
          const level = url.searchParams.get("level") || "all";
          const category = url.searchParams.get("category") || "all";
          return sendJson(res, 200, tailLogLines({ lines, level, category }));
        }

        if (req.method === "POST" && pathname === "/api/schedule") {
          const body = await readJsonBody(req);
          const { action } = body;
          if (action === "add") {
            const channelId = String(body.channelId || "").replace(/[<#>]/g, "").trim();
            if (!/^\d{15,22}$/.test(channelId)) {
              return sendJson(res, 400, { error: "Provide a valid Discord channel ID." });
            }
            const type = body.type === "daily" ? "daily" : "random";
            const intervalMin = Number(body.intervalMin ?? 60);
            const intervalMax = Number(body.intervalMax ?? 480);
            const fixedHour = body.hour !== undefined && body.hour !== null && body.hour !== "" ? Number(body.hour) : null;
            const fixedMinute = Number(body.minute ?? 0);

            if (type === "daily" && (!Number.isInteger(fixedHour) || fixedHour < 0 || fixedHour > 23)) {
              return sendJson(res, 400, { error: "Daily schedule requires hour between 0 and 23 (UTC)." });
            }
            if (type === "daily" && (!Number.isInteger(fixedMinute) || fixedMinute < 0 || fixedMinute > 59)) {
              return sendJson(res, 400, { error: "Minute must be between 0 and 59." });
            }
            if (type === "random" && (!Number.isFinite(intervalMin) || !Number.isFinite(intervalMax) || intervalMin < 1 || intervalMin >= intervalMax)) {
              return sendJson(res, 400, { error: "intervalMin must be >= 1 and less than intervalMax." });
            }

            const guildId = client?.channels?.cache?.get(channelId)?.guildId || body.guildId || null;
            const task = addScheduledTask({
              channelId,
              guildId,
              prompt: String(body.prompt || "").trim() || "Send something fun or interesting to the chat",
              type,
              intervalMin,
              intervalMax,
              fixedHour,
              fixedMinute,
              createdBy: user.id,
            });
            onScheduleTaskStart?.(task);
            return sendJson(res, 200, { task, scheduledTasks: getScheduledTasks() });
          }

          if (action === "remove") {
            const resRemove = removeScheduledTask(body.id);
            if (!resRemove.success) return sendJson(res, 404, { error: "Task not found." });
            return sendJson(res, 200, { scheduledTasks: getScheduledTasks() });
          }

          if (action === "toggle") {
            const resToggle = toggleScheduledTask(body.id);
            if (!resToggle.success) return sendJson(res, 404, { error: "Task not found." });
            if (resToggle.task.enabled) {
              onScheduleTaskStart?.(resToggle.task);
            }
            return sendJson(res, 200, { task: resToggle.task, scheduledTasks: getScheduledTasks() });
          }

          return sendJson(res, 400, { error: "Unknown schedule action." });
        }

        return sendJson(res, 404, { error: "API endpoint not found." });
      }

      // Static frontend
      if (req.method === "GET") {
        return serveStaticFile(pathname, res);
      }

      res.writeHead(405);
      res.end("Method Not Allowed");
    } catch (err) {
      logger.error("[WebUI] Request error:", err.message);
      if (!res.headersSent) {
        sendJson(res, 500, { error: err.message || "Internal server error" });
      }
    }
  });

  server.on("error", (err) => {
    logger.error(`[WebUI] Failed to listen on ${host}:${port}:`, err.message);
  });

  server.listen(port, host, () => {
    logger.log(`[WebUI] Config dashboard listening on http://${host}:${port}`);
  });

  return server;
}
