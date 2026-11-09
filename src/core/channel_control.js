import { loadConfig, saveConfig } from "../utils/config.js";
import { logger } from "../utils/logger.js";

/**
 * Checks if AI responses are disabled for a specific channel.
 */
export function isChannelDisabled(channelId, cfg = loadConfig()) {
  const list = cfg.disabled_channels || [];
  return list.includes(channelId);
}

/**
 * Disables AI responses in a specific channel.
 */
export function disableChannel(channelId) {
  const cfg = loadConfig();
  if (!Array.isArray(cfg.disabled_channels)) {
    cfg.disabled_channels = [];
  }

  if (cfg.disabled_channels.includes(channelId)) {
    return { success: true, alreadyDisabled: true, list: cfg.disabled_channels };
  }

  cfg.disabled_channels.push(channelId);
  saveConfig(cfg);
  logger.log(`[ChannelControl] Disabled AI responses in channel ${channelId}`);
  return { success: true, alreadyDisabled: false, list: cfg.disabled_channels };
}

/**
 * Re-enables AI responses in a specific channel.
 */
export function enableChannel(channelId) {
  const cfg = loadConfig();
  if (!Array.isArray(cfg.disabled_channels)) {
    cfg.disabled_channels = [];
  }

  const index = cfg.disabled_channels.indexOf(channelId);
  if (index === -1) {
    return { success: true, wasDisabled: false, list: cfg.disabled_channels };
  }

  cfg.disabled_channels.splice(index, 1);
  saveConfig(cfg);
  logger.log(`[ChannelControl] Re-enabled AI responses in channel ${channelId}`);
  return { success: true, wasDisabled: true, list: cfg.disabled_channels };
}

/**
 * Gets all channel IDs where AI responses are disabled.
 */
export function getDisabledChannels(cfg = loadConfig()) {
  return cfg.disabled_channels || [];
}
