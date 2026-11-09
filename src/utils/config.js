import fs from "fs";
import { logger } from "./logger.js";

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync("config.json", "utf-8"));
  } catch (err) {
    logger.warn("Failed to load config.json, using defaults:", err.message);
    return {};
  }
}

export function saveConfig(config) {
  try {
    fs.writeFileSync("config.json", JSON.stringify(config, null, 2), "utf-8");
    return true;
  } catch (err) {
    logger.error("Failed to save config.json:", err.message);
    throw err;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
