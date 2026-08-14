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

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
