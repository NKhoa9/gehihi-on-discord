import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";

const KEYS_FILE = path.resolve("lib/donated_keys.json");

function loadKeys() {
  try {
    if (fs.existsSync(KEYS_FILE)) {
      return JSON.parse(fs.readFileSync(KEYS_FILE, "utf-8"));
    }
  } catch (err) {
    logger.warn("Failed to load donated keys:", err.message);
  }
  return [];
}

function saveKeys(keys) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), "utf-8");
}

/**
 * Add or update a donated API key for a user.
 * Returns { updated: true } if the key was updated, { updated: false } if new.
 */
export function addKey(userId, username, key) {
  const keys = loadKeys();
  const existing = keys.find(k => k.userId === userId);
  if (existing) {
    existing.key = key;
    existing.username = username;
    existing.updatedAt = new Date().toISOString();
    saveKeys(keys);
    return { updated: true };
  }
  keys.push({
    userId,
    username,
    key,
    addedAt: new Date().toISOString(),
  });
  saveKeys(keys);
  return { updated: false };
}

/**
 * Remove a user's donated API key.
 * Returns true if removed, false if not found.
 */
export function removeKey(userId) {
  const keys = loadKeys();
  const idx = keys.findIndex(k => k.userId === userId);
  if (idx === -1) return false;
  keys.splice(idx, 1);
  saveKeys(keys);
  return true;
}

/**
 * Get a specific user's donated key entry, or null.
 */
export function getUserKey(userId) {
  return loadKeys().find(k => k.userId === userId) || null;
}

/**
 * Get all donated key entries (with userId, username, addedAt — for admin display).
 */
export function getAllKeys() {
  return loadKeys();
}

/**
 * Get just the raw API key strings for fallback usage.
 */
export function getDonatedApiKeys() {
  return loadKeys().map(k => k.key);
}
