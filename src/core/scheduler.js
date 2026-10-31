import fs from "fs";
import { loadConfig, saveConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";

/**
 * Scheduled Tasks Module
 * 
 * Tasks are stored in config.json under "scheduled_tasks" as an array:
 * [
 *   {
 *     "id": "abc123",
 *     "channel_id": "123456789",
 *     "guild_id": "987654321",
 *     "prompt": "Send a motivational message",
 *     "cron": "random",          // "random" or cron-like schedule spec
 *     "interval_min": 60,        // min minutes between messages (for random)
 *     "interval_max": 480,       // max minutes between messages (for random)
 *     "fixed_hour": null,        // for daily at specific hour (0-23, UTC)
 *     "fixed_minute": null,      // for daily at specific minute (0-59)
 *     "enabled": true,
 *     "created_by": "user_id",
 *     "created_at": "ISO string"
 *   }
 * ]
 */

const activeTimers = new Map(); // task.id -> timeout handle

/**
 * Load all scheduled tasks from config.
 */
export function getScheduledTasks(cfg = loadConfig()) {
  return cfg.scheduled_tasks || [];
}

/**
 * Add a new scheduled task.
 */
export function addScheduledTask({ channelId, guildId, prompt, type = "random", intervalMin = 60, intervalMax = 480, fixedHour = null, fixedMinute = null, createdBy }) {
  const cfg = loadConfig();
  if (!Array.isArray(cfg.scheduled_tasks)) {
    cfg.scheduled_tasks = [];
  }

  const id = Math.random().toString(36).substring(2, 8);
  const task = {
    id,
    channel_id: channelId,
    guild_id: guildId,
    prompt: prompt || "Send something fun or interesting to the chat",
    type, // "random" or "daily"
    interval_min: intervalMin,
    interval_max: intervalMax,
    fixed_hour: fixedHour,
    fixed_minute: fixedMinute,
    enabled: true,
    created_by: createdBy,
    created_at: new Date().toISOString(),
  };

  cfg.scheduled_tasks.push(task);
  saveConfig(cfg);
  logger.log(`[Scheduler] Created task ${id} for channel ${channelId} (${type})`);
  return task;
}

/**
 * Remove a scheduled task by ID.
 */
export function removeScheduledTask(taskId) {
  const cfg = loadConfig();
  if (!Array.isArray(cfg.scheduled_tasks)) return { success: false, error: "no_tasks" };

  const idx = cfg.scheduled_tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return { success: false, error: "not_found" };

  const removed = cfg.scheduled_tasks.splice(idx, 1)[0];
  saveConfig(cfg);

  // Clear any active timer
  if (activeTimers.has(taskId)) {
    clearTimeout(activeTimers.get(taskId));
    activeTimers.delete(taskId);
  }

  logger.log(`[Scheduler] Removed task ${taskId}`);
  return { success: true, task: removed };
}

/**
 * Toggle a scheduled task enabled/disabled.
 */
export function toggleScheduledTask(taskId) {
  const cfg = loadConfig();
  if (!Array.isArray(cfg.scheduled_tasks)) return { success: false, error: "no_tasks" };

  const task = cfg.scheduled_tasks.find(t => t.id === taskId);
  if (!task) return { success: false, error: "not_found" };

  task.enabled = !task.enabled;
  saveConfig(cfg);

  if (!task.enabled && activeTimers.has(taskId)) {
    clearTimeout(activeTimers.get(taskId));
    activeTimers.delete(taskId);
  }

  logger.log(`[Scheduler] Task ${taskId} is now ${task.enabled ? "enabled" : "disabled"}`);
  return { success: true, task };
}

/**
 * Schedule a random-interval message for a task.
 * @param {object} task - The task object
 * @param {Function} sendFn - async (channelId, guildId, prompt) => void
 */
export function scheduleRandomTask(task, sendFn) {
  if (!task.enabled) return;

  // Clear existing timer if any
  if (activeTimers.has(task.id)) {
    clearTimeout(activeTimers.get(task.id));
  }

  const minMs = (task.interval_min || 60) * 60 * 1000;
  const maxMs = (task.interval_max || 480) * 60 * 1000;
  const delayMs = Math.floor(Math.random() * (maxMs - minMs)) + minMs;

  logger.debug(`[Scheduler] Task ${task.id} next fire in ${Math.round(delayMs / 60000)} min`);

  const handle = setTimeout(async () => {
    activeTimers.delete(task.id);
    try {
      // Re-check if still enabled
      const freshTasks = getScheduledTasks();
      const freshTask = freshTasks.find(t => t.id === task.id);
      if (!freshTask || !freshTask.enabled) return;

      await sendFn(freshTask.channel_id, freshTask.guild_id, freshTask.prompt);
      // Schedule the next one
      scheduleRandomTask(freshTask, sendFn);
    } catch (err) {
      logger.error(`[Scheduler] Task ${task.id} failed:`, err.message);
      // Retry scheduling even on failure
      scheduleRandomTask(task, sendFn);
    }
  }, delayMs);

  activeTimers.set(task.id, handle);
}

/**
 * Schedule a daily fixed-time message for a task.
 * @param {object} task - The task object
 * @param {Function} sendFn - async (channelId, guildId, prompt) => void
 */
export function scheduleDailyTask(task, sendFn) {
  if (!task.enabled) return;

  if (activeTimers.has(task.id)) {
    clearTimeout(activeTimers.get(task.id));
  }

  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(task.fixed_hour ?? 9, task.fixed_minute ?? 0, 0, 0);

  // If target time already passed today, schedule for tomorrow
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }

  const delayMs = target.getTime() - now.getTime();
  logger.debug(`[Scheduler] Daily task ${task.id} next fire in ${Math.round(delayMs / 60000)} min (at ${target.toISOString()})`);

  const handle = setTimeout(async () => {
    activeTimers.delete(task.id);
    try {
      const freshTasks = getScheduledTasks();
      const freshTask = freshTasks.find(t => t.id === task.id);
      if (!freshTask || !freshTask.enabled) return;

      await sendFn(freshTask.channel_id, freshTask.guild_id, freshTask.prompt);
      scheduleDailyTask(freshTask, sendFn);
    } catch (err) {
      logger.error(`[Scheduler] Daily task ${task.id} failed:`, err.message);
      scheduleDailyTask(task, sendFn);
    }
  }, delayMs);

  activeTimers.set(task.id, handle);
}

/**
 * Start all enabled scheduled tasks.
 * Call this on bot ready.
 */
export function startAllScheduledTasks(sendFn) {
  const tasks = getScheduledTasks();
  let started = 0;

  for (const task of tasks) {
    if (!task.enabled) continue;

    if (task.type === "daily" && task.fixed_hour != null) {
      scheduleDailyTask(task, sendFn);
    } else {
      scheduleRandomTask(task, sendFn);
    }
    started++;
  }

  if (started > 0) {
    logger.log(`[Scheduler] Started ${started} scheduled task(s)`);
  }
  return started;
}

/**
 * Stop all active scheduled task timers.
 */
export function stopAllScheduledTasks() {
  for (const [id, handle] of activeTimers) {
    clearTimeout(handle);
  }
  activeTimers.clear();
  logger.log("[Scheduler] All scheduled tasks stopped");
}
