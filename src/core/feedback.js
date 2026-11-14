import { logger } from "../utils/logger.js";

/**
 * In-memory tracking of the latest bot response per channel.
 * Map<channelId, {
 *   messageId: string,
 *   score: number,
 *   upvotes: number,
 *   downvotes: number,
 *   updatedAt: number
 * }>
 */
const latestFeedbackMap = new Map();

/**
 * Returns the latest feedback entry for a channel.
 * @param {string} channelId
 * @returns {{ messageId: string, score: number, upvotes: number, downvotes: number, updatedAt: number } | null}
 */
export function getLatestFeedback(channelId) {
  return latestFeedbackMap.get(channelId) || null;
}

/**
 * Registers the latest bot response message for a channel.
 * Resets the score and votes to 0.
 * @param {string} channelId
 * @param {string} messageId
 */
export function setLatestFeedback(channelId, messageId) {
  latestFeedbackMap.set(channelId, {
    messageId,
    score: 0,
    upvotes: 0,
    downvotes: 0,
    updatedAt: Date.now(),
  });
}

/**
 * Updates the score of the latest response in a channel from a Discord Message object.
 * Checks for up-arrow (⬆️ / ⬆) and down-arrow (⬇️ / ⬇) reactions, subtracting the bot's own reaction if present.
 * @param {import("discord.js").Message} msg
 * @returns {boolean} true if feedback score was updated
 */
export function updateFeedbackScoreFromMessage(msg) {
  const channelId = msg.channel?.id;
  if (!channelId) return false;

  const current = latestFeedbackMap.get(channelId);
  if (!current || current.messageId !== msg.id) return false;

  const upReact = msg.reactions?.cache.find(r => r.emoji.name === "⬆️" || r.emoji.name === "⬆");
  const downReact = msg.reactions?.cache.find(r => r.emoji.name === "⬇️" || r.emoji.name === "⬇");

  const upvotes = Math.max(0, (upReact?.count || 0) - (upReact?.me ? 1 : 0));
  const downvotes = Math.max(0, (downReact?.count || 0) - (downReact?.me ? 1 : 0));
  const score = upvotes - downvotes;

  current.upvotes = upvotes;
  current.downvotes = downvotes;
  current.score = score;
  current.updatedAt = Date.now();

  logger.log(`[Feedback] Channel ${channelId} latest response score updated: ${score > 0 ? "+" + score : score} (⬆️ +${upvotes}, ⬇️ -${downvotes})`);
  return true;
}

/**
 * Builds the feedback context block to be injected into the AI system prompt.
 * Only includes the block if feedback is enabled and users have voted on the latest response.
 * @param {string} channelId
 * @param {object} cfg
 * @returns {string}
 */
export function buildFeedbackBlock(channelId, cfg) {
  if (cfg.feedback_system === false) return "";

  const fb = latestFeedbackMap.get(channelId);
  if (!fb || (fb.upvotes === 0 && fb.downvotes === 0)) return "";

  const scoreSign = fb.score > 0 ? `+${fb.score}` : `${fb.score}`;
  return `\n\n--- FEEDBACK ON YOUR PREVIOUS RESPONSE IN THIS CHANNEL ---
Your previous message received user feedback:
Score: ${scoreSign} (⬆️ +${fb.upvotes} upvotes, ⬇️ -${fb.downvotes} downvotes)
INSTRUCTION: Acknowledge this feedback score when responding. If the score is negative (less than 0), users disliked or found fault with your previous response—humbly learn from your mistake, apologize or correct yourself, and improve your answer. If the score is positive, maintain what worked well.
--- END FEEDBACK ---`;
}

/**
 * Clears feedback for a specific channel (e.g. on /clear)
 * @param {string} channelId
 */
export function clearFeedback(channelId) {
  latestFeedbackMap.delete(channelId);
}

