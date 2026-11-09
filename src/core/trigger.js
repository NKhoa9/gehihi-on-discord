import { logger } from "../utils/logger.js";

const lastBotReplyTimes = new Map(); // channelId -> timestamp (ms)

/**
 * Record that the bot sent a message in this channel.
 * Used to calculate conversation momentum and prevent spam bursts.
 * @param {string} channelId
 */
export function recordBotReply(channelId) {
  if (channelId) {
    lastBotReplyTimes.set(channelId, Date.now());
  }
}

/**
 * Evaluate whether the bot should respond to an incoming message.
 * Supports "smart" (dynamic contextual algorithm) and "random" (legacy flat rate).
 *
 * @param {Object} params
 * @param {import("discord.js").Message} params.message - The Discord message
 * @param {import("discord.js").Client} params.client - The Discord client
 * @param {Object} params.cfg - Current loaded config
 * @param {string} params.userText - Cleaned message text
 * @param {boolean} params.isMentioned - Whether client is mentioned
 * @param {boolean} params.isReplyToBot - Whether message replies to bot
 * @returns {{ shouldProcess: boolean, mode: string, reason: string, score?: number }}
 */
export function shouldRespond({ message, client, cfg, userText, isMentioned, isReplyToBot }) {
  // 1. Direct triggers always pass
  if (isMentioned) {
    return { shouldProcess: true, mode: cfg.response_mode || "smart", reason: "mention" };
  }
  if (isReplyToBot) {
    return { shouldProcess: true, mode: cfg.response_mode || "smart", reason: "reply" };
  }

  const mode = (cfg.response_mode || "smart").toLowerCase();

  // 2. Legacy Random Mode
  if (mode === "random") {
    const rate = typeof cfg.random_appear_rate === "number" ? cfg.random_appear_rate : 0.05;
    const dice = Math.random();
    const pass = dice < rate;
    logger.debug(`[Trigger:random] rate: ${rate}, dice: ${dice.toFixed(3)}, pass: ${pass}`);
    return {
      shouldProcess: pass,
      mode: "random",
      reason: pass ? "random_pass" : "random_fail",
      score: rate
    };
  }

  // 3. Smart Dynamic Trigger Algorithm (Beta Test)
  const trimmed = userText.trim();
  const lower = trimmed.toLowerCase();

  // Check hard suppressions:
  // - Bot commands (e.g. !play, /help, ?info, $balance, -skip)
  if (/^[!./?$~#;,%^-][a-zA-Z0-9_]+/i.test(trimmed)) {
    logger.debug(`[SmartTrigger] Ignored: looks like a bot command prefix "${trimmed.substring(0, 10)}"`);
    return { shouldProcess: false, mode: "smart", reason: "suppressed_command" };
  }

  // - Ultra short text without bot keywords (e.g. "k", "ok", "lol", "?")
  const botKeywords = ["gehihi", "gdbot"];
  if (client.user?.username) {
    botKeywords.push(client.user.username.toLowerCase());
  }

  const mentionsBotName = botKeywords.some(kw => lower.includes(kw));

  if (trimmed.length <= 2 && !mentionsBotName) {
    logger.debug(`[SmartTrigger] Ignored: message too short (${trimmed.length} chars)`);
    return { shouldProcess: false, mode: "smart", reason: "suppressed_short_text" };
  }

  // - URL only message
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    logger.debug("[SmartTrigger] Ignored: pure URL");
    return { shouldProcess: false, mode: "smart", reason: "suppressed_url_only" };
  }

  // Calculate dynamic engagement probability
  const factors = [];
  let baseRate = typeof cfg.random_appear_rate === "number" ? Math.min(cfg.random_appear_rate, 0.15) : 0.08;
  let probability = baseRate;
  factors.push(`base: ${baseRate.toFixed(2)}`);

  // Factor A: Bot name mentioned in text
  if (mentionsBotName) {
    probability = Math.max(probability, 0.85);
    factors.push("bot_name (+0.85 min)");
  }

  // Factor B: Conversation momentum (recent interaction in this channel)
  const lastReply = lastBotReplyTimes.get(message.channel.id) || 0;
  const timeSinceLast = Date.now() - lastReply;
  const MOMENTUM_WINDOW = 90 * 1000; // 90 seconds
  const COOLDOWN_WINDOW = 12 * 1000; // 12 seconds anti-burst

  if (lastReply > 0 && timeSinceLast < MOMENTUM_WINDOW) {
    const momentum = 1.0 - (timeSinceLast / MOMENTUM_WINDOW);
    const boost = momentum * 0.35;
    probability += boost;
    factors.push(`momentum: +${boost.toFixed(2)} (${Math.round(timeSinceLast / 1000)}s ago)`);
  }

  // Factor C: Question detection
  const isQuestion = /[?？]/.test(trimmed) || /^(why|how|what|who|when|where|is it|can someone|có ai|sao|thế nào|được không|giúp)\b/i.test(trimmed);
  if (isQuestion) {
    probability += 0.20;
    factors.push("question: +0.20");
  }

  // Factor D: Cooldown / Fatigue check
  // If the bot spoke unprompted very recently, reduce rate to prevent burst spamming
  if (lastReply > 0 && timeSinceLast < COOLDOWN_WINDOW && !mentionsBotName) {
    probability *= 0.15;
    factors.push("cooldown: x0.15 fatigue");
  }

  // Clamp probability between 0 and 0.90
  const finalProb = Math.min(Math.max(probability, 0), 0.90);
  const dice = Math.random();
  const pass = dice < finalProb;

  logger.debug(`[SmartTrigger] finalProb: ${finalProb.toFixed(3)}, dice: ${dice.toFixed(3)}, pass: ${pass} | Factors: [${factors.join(", ")}]`);

  return {
    shouldProcess: pass,
    mode: "smart",
    reason: pass ? "smart_pass" : "smart_fail",
    score: finalProb
  };
}

