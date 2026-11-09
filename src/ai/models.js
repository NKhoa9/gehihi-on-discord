import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import { loadConfig } from "../utils/config.js";

const MODELS_FILE = path.resolve("models.json");

export const DEFAULT_MODEL_REGISTRY = {
  "flash-lite-series": [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite"
  ],
  "flash-series": [
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3-flash-preview",
    "gemini-2.5-flash"
  ],
  "gemma-series": [
    "gemma-4-31b"
  ],
  "live-series": [
    "gemini-3.8-live",
    "gemini-3.1-flash-live-preview"
  ],
  "image-gen-series": [],
  "video-gen-series": []
};

/**
 * Saves the model registry to models.json.
 */
export function saveModelRegistry(registry) {
  fs.writeFileSync(MODELS_FILE, JSON.stringify(registry, null, 2), "utf-8");
}

/**
 * Reorders an item in an array using either direction ('up', 'down', 'top', 'bottom') or a 1-based position.
 */
export function moveItemInArray(arr, item, { direction, position } = {}) {
  const index = arr.indexOf(item);
  if (index === -1) return { success: false, reason: "not_found" };

  let targetIndex = index;

  if (typeof position === "number" && !isNaN(position)) {
    targetIndex = Math.max(0, Math.min(arr.length - 1, position - 1));
  } else if (direction === "up") {
    targetIndex = Math.max(0, index - 1);
  } else if (direction === "down") {
    targetIndex = Math.min(arr.length - 1, index + 1);
  } else if (direction === "top") {
    targetIndex = 0;
  } else if (direction === "bottom") {
    targetIndex = arr.length - 1;
  }

  if (targetIndex === index) {
    return { success: true, unchanged: true, oldIndex: index, newIndex: index };
  }

  arr.splice(index, 1);
  arr.splice(targetIndex, 0, item);

  return { success: true, unchanged: false, oldIndex: index, newIndex: targetIndex };
}

/**
 * Creates a new custom model series pool in models.json.
 */
export function createCustomSeries(seriesName, initialModels = []) {
  const cleanName = (seriesName || "").trim().toLowerCase().replace(/\s+/g, "-");
  if (!cleanName) return { success: false, error: "invalid_name" };

  const registry = loadModelRegistry();
  if (registry[cleanName]) {
    return { success: false, error: "already_exists", list: registry[cleanName] };
  }

  const modelArray = Array.isArray(initialModels)
    ? initialModels.map(m => m.trim()).filter(Boolean)
    : [];

  registry[cleanName] = modelArray;
  saveModelRegistry(registry);
  logger.log(`[Models] Created custom series "${cleanName}" with ${modelArray.length} model(s)`);
  return { success: true, name: cleanName, list: registry[cleanName] };
}

/**
 * Deletes a custom model series pool from models.json.
 */
export function deleteCustomSeries(seriesName) {
  const cleanName = (seriesName || "").trim().toLowerCase();
  const registry = loadModelRegistry();
  if (!registry[cleanName]) {
    return { success: false, error: "not_found" };
  }

  delete registry[cleanName];
  saveModelRegistry(registry);
  logger.log(`[Models] Deleted custom series "${cleanName}"`);
  return { success: true, name: cleanName };
}

/**
 * Creates a new custom task category in config.json.
 */
export function createTaskCategory(categoryName, initialItems = []) {
  const cleanName = (categoryName || "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!cleanName) return { success: false, error: "invalid_name" };

  const cfg = loadConfig();
  if (!cfg.models) cfg.models = {};
  if (cfg.models[cleanName]) {
    return { success: false, error: "already_exists", list: cfg.models[cleanName] };
  }

  const items = Array.isArray(initialItems)
    ? initialItems.map(i => i.trim()).filter(Boolean)
    : [];

  cfg.models[cleanName] = items;
  fs.writeFileSync("config.json", JSON.stringify(cfg, null, 2), "utf-8");
  logger.log(`[Models] Created task category "${cleanName}" with ${items.length} item(s)`);
  return { success: true, name: cleanName, list: cfg.models[cleanName] };
}

/**
 * Deletes a task category from config.json.
 */
export function deleteTaskCategory(categoryName) {
  const cleanName = (categoryName || "").trim().toLowerCase();
  const cfg = loadConfig();
  if (!cfg.models || !cfg.models[cleanName]) {
    return { success: false, error: "not_found" };
  }

  delete cfg.models[cleanName];
  fs.writeFileSync("config.json", JSON.stringify(cfg, null, 2), "utf-8");
  logger.log(`[Models] Deleted task category "${cleanName}"`);
  return { success: true, name: cleanName };
}

/**
 * Returns all series names in models.json.
 */
export function getAllSeriesNames(registry = loadModelRegistry()) {
  return Object.keys(registry);
}

/**
 * Returns all task category names in config.json.
 */
export function getAllTaskCategories(cfg = loadConfig()) {
  return Object.keys(cfg.models || {});
}

/**
 * Adds a model to a series in models.json.
 */
export function addModelToSeries(series, model, position = null) {
  const registry = loadModelRegistry();
  if (!Array.isArray(registry[series])) registry[series] = [];

  if (registry[series].includes(model)) {
    return { success: false, error: "already_exists", list: registry[series] };
  }

  if (typeof position === "number" && !isNaN(position)) {
    const insertIdx = Math.max(0, Math.min(registry[series].length, position - 1));
    registry[series].splice(insertIdx, 0, model);
  } else {
    registry[series].push(model);
  }

  saveModelRegistry(registry);
  return { success: true, list: registry[series] };
}

/**
 * Removes a model from a series in models.json.
 */
export function removeModelFromSeries(series, model) {
  const registry = loadModelRegistry();
  if (!Array.isArray(registry[series])) {
    return { success: false, error: "series_not_found" };
  }

  const idx = registry[series].indexOf(model);
  if (idx === -1) {
    return { success: false, error: "model_not_found", list: registry[series] };
  }

  registry[series].splice(idx, 1);
  saveModelRegistry(registry);
  return { success: true, list: registry[series] };
}

/**
 * Moves a model within a series in models.json.
 */
export function moveModelInSeries(series, model, { direction, position }) {
  const registry = loadModelRegistry();
  if (!Array.isArray(registry[series])) {
    return { success: false, error: "series_not_found" };
  }

  const res = moveItemInArray(registry[series], model, { direction, position });
  if (!res.success) {
    return { success: false, error: res.reason, list: registry[series] };
  }

  saveModelRegistry(registry);
  return {
    success: true,
    list: registry[series],
    oldIndex: res.oldIndex,
    newIndex: res.newIndex,
    unchanged: res.unchanged
  };
}

/**
 * Adds an item (series or model) to a task category in config.json.
 */
export function addModelToTask(category, item, position = null) {
  const cfg = loadConfig();
  if (!cfg.models) cfg.models = {};
  if (!Array.isArray(cfg.models[category])) cfg.models[category] = [];

  if (cfg.models[category].includes(item)) {
    return { success: false, error: "already_exists", list: cfg.models[category] };
  }

  if (typeof position === "number" && !isNaN(position)) {
    const insertIdx = Math.max(0, Math.min(cfg.models[category].length, position - 1));
    cfg.models[category].splice(insertIdx, 0, item);
  } else {
    cfg.models[category].push(item);
  }

  fs.writeFileSync("config.json", JSON.stringify(cfg, null, 2), "utf-8");
  return { success: true, list: cfg.models[category] };
}

/**
 * Removes an item from a task category in config.json.
 */
export function removeModelFromTask(category, item) {
  const cfg = loadConfig();
  if (!cfg.models || !Array.isArray(cfg.models[category])) {
    return { success: false, error: "category_empty", list: [] };
  }

  const idx = cfg.models[category].indexOf(item);
  if (idx === -1) {
    return { success: false, error: "item_not_found", list: cfg.models[category] };
  }

  cfg.models[category].splice(idx, 1);
  fs.writeFileSync("config.json", JSON.stringify(cfg, null, 2), "utf-8");
  return { success: true, list: cfg.models[category] };
}

/**
 * Moves an item within a task category in config.json.
 */
export function moveModelInTask(category, item, { direction, position }) {
  const cfg = loadConfig();
  if (!cfg.models || !Array.isArray(cfg.models[category])) {
    return { success: false, error: "category_empty", list: [] };
  }

  const res = moveItemInArray(cfg.models[category], item, { direction, position });
  if (!res.success) {
    return { success: false, error: res.reason, list: cfg.models[category] };
  }

  fs.writeFileSync("config.json", JSON.stringify(cfg, null, 2), "utf-8");
  return {
    success: true,
    list: cfg.models[category],
    oldIndex: res.oldIndex,
    newIndex: res.newIndex,
    unchanged: res.unchanged
  };
}

/**
 * Loads the model registry (categories/series) from models.json.
 * Falls back to DEFAULT_MODEL_REGISTRY on error or missing file.
 */
export function loadModelRegistry() {
  try {
    if (fs.existsSync(MODELS_FILE)) {
      return JSON.parse(fs.readFileSync(MODELS_FILE, "utf-8"));
    }
  } catch (err) {
    logger.warn("Failed to load models.json, using defaults:", err.message);
  }
  return DEFAULT_MODEL_REGISTRY;
}

/**
 * Resolves an array containing category/series names or concrete model names
 * into a flat, deduplicated list of concrete model names.
 *
 * @param {string[]} list - e.g. ["flash-lite-series", "gemma-series"] or ["gemini-3.5-flash-lite"]
 * @param {Record<string, string[]>} [registry] - Optional custom registry
 * @returns {string[]} Concrete model names in priority order
 */
export function resolveModelList(list, registry = loadModelRegistry()) {
  if (!Array.isArray(list)) return [];
  const resolved = [];

  for (const item of list) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;

    if (Array.isArray(registry[trimmed])) {
      for (const m of registry[trimmed]) {
        if (!resolved.includes(m)) resolved.push(m);
      }
    } else {
      if (!resolved.includes(trimmed)) resolved.push(trimmed);
    }
  }

  return resolved;
}

/**
 * Resolves active models for a specific bot task.
 * Note: CLASSIFIER is always gemini flash-lite!
 *
 * @param {"CLASSIFIER"|"SEARCH"|"THINKING"|"NORMAL"|"LIVE"|"IMAGE_GEN"|"VIDEO_GEN"} taskType
 * @param {object} [cfg] - Current config object from loadConfig()
 * @param {Record<string, string[]>} [registry] - Model registry from loadModelRegistry()
 * @returns {string[]} List of concrete model names
 */
export function getTaskModels(taskType, cfg = loadConfig(), registry = loadModelRegistry()) {
  const modelMode = cfg.model_mode || "flash-lite";
  const modelsCfg = cfg.models || {};
  const upperTask = (taskType || "NORMAL").toUpperCase();
  const lowerTask = (taskType || "normal").toLowerCase();

  switch (upperTask) {
    case "CLASSIFIER":
      // Classifier is ALWAYS gemini flash-lite (lightweight and fast)
      return resolveModelList(modelsCfg.classifier || ["flash-lite-series"], registry);

    case "SEARCH":
      return resolveModelList(modelsCfg.search || ["flash-lite-series", "flash-series"], registry);

    case "THINKING":
      return resolveModelList(modelsCfg.thinking || ["flash-series"], registry);

    case "LIVE":
      return resolveModelList(modelsCfg.live || ["live-series"], registry);

    case "IMAGE_GEN":
      return resolveModelList(modelsCfg.image_gen || ["image-gen-series"], registry);

    case "VIDEO_GEN":
      return resolveModelList(modelsCfg.video_gen || ["video-gen-series"], registry);

    case "NORMAL":
      if (modelMode === "flash") {
        return resolveModelList(modelsCfg.default_flash || modelsCfg.thinking || ["flash-series"], registry);
      }
      return resolveModelList(modelsCfg.default || ["flash-lite-series", "gemma-series"], registry);

    default:
      // Custom task category from config.models
      if (modelsCfg[lowerTask]) {
        return resolveModelList(modelsCfg[lowerTask], registry);
      }
      // Custom series directly from models.json registry
      if (registry[lowerTask]) {
        return resolveModelList([lowerTask], registry);
      }
      if (modelMode === "flash") {
        return resolveModelList(modelsCfg.default_flash || modelsCfg.thinking || ["flash-series"], registry);
      }
      return resolveModelList(modelsCfg.default || ["flash-lite-series", "gemma-series"], registry);
  }
}
