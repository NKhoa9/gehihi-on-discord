import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import { loadConfig, sleep } from "../utils/config.js";
import { getHistory, formatReactionsString } from "../core/history.js";
import { getSavedImagesList } from "../media/images.js";
import { buildMemoryBlock, getTempMemory, setTempMemory, resetTempMemoryCounter } from "../core/memory.js";
import { buildGuildEmojisBlock } from "../core/emojis.js";
import { AIProvider, GeminiProvider, createGeminiProvider } from "./provider.js";
import { getDonatedApiKeys } from "../core/keys.js";
import { getTaskModels, resolveModelList, loadModelRegistry } from "./models.js";
import { buildFeedbackBlock } from "../core/feedback.js";

const LIB_GEN_IMG = path.resolve("lib/gen_img");
const LIB_GEN_VID = path.resolve("lib/gen_vid");

/**
 * Resolves the thinking effort level ("low" | "medium" | "high") for a model.
 * - Global mode: returns the global thinking effort.
 * - Local mode: returns the model-specific effort if set, otherwise falls back to global.
 * @param {string} model
 * @param {object} cfg
 * @returns {"low" | "medium" | "high"}
 */
export function getThinkingEffort(model, cfg) {
  const te = cfg?.thinking_effort;
  if (!te) return "medium";
  const mode = te.mode || "global";
  if (mode === "local" && te.local && te.local[model]) {
    return te.local[model].toLowerCase();
  }
  return (te.global || "medium").toLowerCase();
}

/**
 * Returns thinkingConfig object for @google/genai based on the model and thinking effort setting.
 * Models that do not support thinking (e.g. Gemma or non-Gemini) return empty object.
 * Gemini 2.5 models use thinkingBudget (mapped from effort).
 * Gemini 3+ models use thinkingLevel ("LOW" | "MEDIUM" | "HIGH").
 * @param {string} model
 * @param {object} cfg
 * @returns {{ thinkingConfig: object } | {}}
 */
export function getThinkingConfig(model, cfg) {
  const m = (model || "").toLowerCase();
  if (!m.startsWith("gemini")) return {};
  const effort = getThinkingEffort(model, cfg);
  if (m.includes("2.5")) {
    const budgetMap = { low: 1024, medium: 4096, high: 16384 };
    return { thinkingConfig: { thinkingBudget: budgetMap[effort] || 4096 } };
  }
  return { thinkingConfig: { thinkingLevel: effort.toUpperCase() } };
}

export const aiProvider = new GeminiProvider(process.env.GEMINI_API_KEY);
const MAX_RETRIES = 2;

function loadSystemPrompt() {
  try {
    return fs.readFileSync("system_prompt.txt", "utf-8");
  } catch (err) {
    logger.warn("Failed to load system_prompt.txt:", err.message);
    return "You are a friendly AI assistant.";
  }
}

const BASE_SYSTEM_PROMPT = loadSystemPrompt();

/**
 * Formats a contents payload array into a human-readable string for logging.
 * @param {Array<{ role: string, parts: Array<{ text?: string, inlineData?: { mimeType: string } }> }>} contents
 * @returns {string}
 */
export function formatContentsForLog(contents) {
  return contents.map(c => {
    const partsText = c.parts.map(p => {
      if (p.text) return p.text;
      if (p.inlineData) return `[Attachment: ${p.inlineData.mimeType || "unknown"}]`;
      return JSON.stringify(p);
    }).join(" ");
    return `[${c.role}]: ${partsText}`;
  }).join("\n");
}

export async function generateImage(prompt) {
  const cfg = loadConfig();
  const imageModels = getTaskModels("IMAGE_GEN", cfg);

  for (const model of imageModels) {
    try {
      const response = await aiProvider.generateImage(model, prompt);
      if (response.candidates && response.candidates[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData) {
            const mimeType = part.inlineData.mimeType || "image/png";
            const extMap = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
            const ext = extMap[mimeType] || ".png";
            const filename = `gen_${Date.now()}${ext}`;
            const filepath = path.join(LIB_GEN_IMG, filename);
            const buffer = Buffer.from(part.inlineData.data, "base64");
            fs.writeFileSync(filepath, buffer);
            logger.log(`[ImageGen] Generated image saved: ${filename}`);
            return { filepath, filename };
          }
        }
      }
      logger.warn(`[ImageGen] Model ${model} returned no image data.`);
    } catch (err) {
      logger.warn(`[ImageGen] Model ${model} failed:`, err.message);
    }
  }
  return null;
}

export async function generateVideo(prompt) {
  const cfg = loadConfig();
  const videoModels = getTaskModels("VIDEO_GEN", cfg);

  for (const model of videoModels) {
    try {
      const response = await aiProvider.generateVideo(model, prompt);
      if (response.candidates && response.candidates[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
          if (part.inlineData || part.fileData) {
            if (part.inlineData) {
              const mimeType = part.inlineData.mimeType || "video/mp4";
              const extMap = { "video/mp4": ".mp4", "video/webm": ".webm" };
              const ext = extMap[mimeType] || ".mp4";
              const filename = `gen_${Date.now()}${ext}`;
              const filepath = path.join(LIB_GEN_VID, filename);
              const buffer = Buffer.from(part.inlineData.data, "base64");
              fs.writeFileSync(filepath, buffer);
              logger.log(`[VideoGen] Generated video saved: ${filename}`);
              return { filepath, filename };
            }
          }
        }
      }
      logger.warn(`[VideoGen] Model ${model} returned no video data.`);
    } catch (err) {
      logger.warn(`[VideoGen] Model ${model} failed:`, err.message);
    }
  }
  return null;
}

export async function classifyPrompt(text) {
  const prompt = `Classify the following user message into one of these categories:
1: SEARCH (needs up-to-date info, news, weather, real-time facts)
2: THINKING (complex math, coding, logic puzzles, deep reasoning)
3: NORMAL (casual chat, general knowledge, basic questions)
Reply with ONLY the number (1, 2, or 3).
User message: "${text}"`;

  const cfg = loadConfig();
  const classifierModels = getTaskModels("CLASSIFIER", cfg);

  for (const model of classifierModels) {
    try {
      const reply = await aiProvider.generateText(model, [{ role: "user", parts: [{ text: prompt }] }], { maxOutputTokens: 10, temperature: 0 });
      if (reply.includes("1")) return "SEARCH";
      if (reply.includes("2")) return "THINKING";
      return "NORMAL";
    } catch (err) {
      logger.warn(`Classifier failed on ${model}, trying next...`);
    }
  }
  return "NORMAL";
}

/**
 * Converts channel history entries into Gemini `contents` turns, ensuring the conversation
 * starts with a "user" turn so Gemini API never rejects leading "model" turns.
 * @param {Array} history
 * @returns {Array<{ role: string, parts: Array }>}
 */
function buildHistoryContents(history) {
  const contents = history.map((entry) => {
    const rxStr = formatReactionsString(entry.reactions);
    const parts = [{ text: `${entry.text}${rxStr}` }];

    if (entry.attachments && entry.attachments.length > 0) {
      for (const att of entry.attachments) {
        if (att.isUnsupported) {
          parts.push({
            text: `[Attached file: ${att.filename || "unknown"} (unsupported binary format, cannot be read)]`
          });
          continue;
        }
        try {
          if (att.filepath && fs.existsSync(att.filepath)) {
            const buffer = fs.readFileSync(att.filepath);
            parts.push({
              text: `[File attached: ${att.filename || path.basename(att.filepath)}]`
            });
            parts.push({
              inlineData: { data: buffer.toString("base64"), mimeType: att.mimeType }
            });
          }
        } catch (err) {
          logger.warn(`Failed to read cached attachment ${att.filepath}:`, err.message);
        }
      }
    }
    return { role: entry.role, parts };
  });

  while (contents.length > 1 && contents[0].role !== "user") {
    contents.shift();
  }
  return contents;
}

export async function generateReply(channelId, userText, guildId = null, guild = null) {
  const history = getHistory(channelId);
  const contents = buildHistoryContents(history);

  const memoryBlock = buildMemoryBlock(guildId, channelId);
  const savedImages = getSavedImagesList();
  const imagesBlock = savedImages.length > 0
    ? `\n\n--- YOUR SAVED IMAGES ---\nYou currently have these images saved in your library:\n${savedImages.map(f => `- ${f}`).join("\n")}\nYou can send them using [SEND_IMG: name].\n--- END SAVED IMAGES ---`
    : "\n\n--- YOUR SAVED IMAGES ---\nYour library is empty. You can save images using [SAVE_IMG: url | name].\n--- END SAVED IMAGES ---";
  const emojisBlock = guild ? buildGuildEmojisBlock(guild) : "";

  const cfg = loadConfig();
  const feedbackBlock = buildFeedbackBlock(channelId, cfg);
  const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT + memoryBlock + imagesBlock + emojisBlock + feedbackBlock;

  let taskType = "NORMAL";
  let cleanedUserText = userText;

  const registry = loadModelRegistry();
  const allCategories = { ...(cfg.models || {}), ...registry };

  // 1. Check for explicit [CATEGORY: <name>]
  const explicitCatMatch = userText.match(/\[CATEGORY:\s*([a-zA-Z0-9_\-]+)\]/i);
  if (explicitCatMatch) {
    const requestedCat = explicitCatMatch[1].toLowerCase();
    if (allCategories[requestedCat]) {
      taskType = requestedCat.toUpperCase();
      cleanedUserText = userText.replace(/\[CATEGORY:\s*[a-zA-Z0-9_\-]+\]/gi, "").trim() || userText;
      logger.debug(`[Classifier] User forced custom category: ${requestedCat}`);
    }
  } else if (/\[SEARCH\]/i.test(userText)) {
    taskType = "SEARCH";
    cleanedUserText = userText.replace(/\[SEARCH\]/gi, "").trim() || userText;
    logger.debug(`[Classifier] User forced SEARCH mode`);
  } else if (/\[THINKING\]/i.test(userText)) {
    taskType = "THINKING";
    cleanedUserText = userText.replace(/\[THINKING\]/gi, "").trim() || userText;
    logger.debug(`[Classifier] User forced THINKING mode`);
  } else {
    // 2. Check if user specified [<CUSTOM_CATEGORY>]
    let customMatch = null;
    for (const catName of Object.keys(allCategories)) {
      if (["default", "search", "thinking", "classifier", "live", "image_gen", "video_gen"].includes(catName)) continue;
      const regex = new RegExp(`\\[${catName}\\]`, "i");
      if (regex.test(userText)) {
        customMatch = catName;
        cleanedUserText = userText.replace(regex, "").trim() || userText;
        break;
      }
    }
    if (customMatch) {
      taskType = customMatch.toUpperCase();
      logger.debug(`[Classifier] User forced custom category: ${customMatch}`);
    } else if (cleanedUserText.length > 10) {
      taskType = await classifyPrompt(cleanedUserText);
      logger.debug(`[Classifier] Auto-classified as ${taskType}`);
    }
  }

  const modelsDefault = getTaskModels("NORMAL", cfg, registry);
  const modelsSearch = getTaskModels("SEARCH", cfg, registry);
  const modelsThinking = getTaskModels("THINKING", cfg, registry);

  let modelList = modelsDefault;
  let useSearch = false;

  const lowerTask = taskType.toLowerCase();
  if (taskType === "SEARCH") {
    modelList = modelsSearch;
    useSearch = true;
  } else if (taskType === "THINKING") {
    modelList = modelsThinking;
  } else if (cfg.models?.[lowerTask]) {
    // Custom task category from config.models
    modelList = resolveModelList(cfg.models[lowerTask], registry);
  } else if (registry[lowerTask]) {
    // Custom series directly from models.json registry
    modelList = resolveModelList([lowerTask], registry);
  }

  if (!modelList || modelList.length === 0) {
    modelList = modelsDefault;
  }

  let reportedIssue = "";
  const retryDelays = [5000, 15000];

  // Log Raw AI Input before querying models
  logger.log(`\n[Raw AI Input]:\n${formatContentsForLog(contents)}\n--------------------------`);
  logger.debug(`\n[Raw AI System Instruction]:\n${SYSTEM_PROMPT}\n--------------------------`);

  for (const model of modelList) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const config = {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.7,
          ...getThinkingConfig(model, cfg),
        };
        if (useSearch) config.tools = [{ googleSearch: {} }];
        else if (taskType === "NORMAL") {
          config.temperature = 1.0;
        }

        const replyText = await aiProvider.generateText(model, contents, config);
        let finalReplyText = replyText || "hmm, I got nothing 🤔";
        if (reportedIssue && cfg.show_errors_in_chat !== false) {
          finalReplyText = reportedIssue + finalReplyText;
        }

        const thinkingEffort = getThinkingEffort(model, cfg);
        return { text: finalReplyText, model, thinkingEffort };
      } catch (err) {
        const is429 = err?.message?.includes('"code":429') || err?.message?.includes("RESOURCE_EXHAUSTED") || err?.message?.includes("QUOTA_EXCEEDED") || err?.status === 429;
        if (is429 && attempt < MAX_RETRIES) {
          await sleep(retryDelays[attempt] || 5000);
          continue;
        }
        logger.error(`${taskType} task failed on ${model}. Error:`, err.message);
        reportedIssue += `⚠️ *(Auto-Fallback: \`${taskType}\` task failed on \`${model}\`. Switching to next model...)*\n\n`;
        break;
      }
    }
  }

  if (taskType !== "NORMAL") {
    reportedIssue += `⚠️ *(Auto-Fallback: All \`${taskType}\` models failed. Falling back to \`NORMAL\` models...)*\n\n`;
    for (const model of modelsDefault) {
      try {
        logger.debug(`[Router] Attempting ultimate fallback model: ${model}`);
        const fallbackConfig = {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 1.0,
          ...getThinkingConfig(model, cfg),
        };
        const replyText = await aiProvider.generateText(model, contents, fallbackConfig);
        let finalReplyText = replyText || "hmm, I got nothing 🤔";

        if (reportedIssue && cfg.show_errors_in_chat !== false) {
          finalReplyText = reportedIssue + finalReplyText;
        }

        const thinkingEffort = getThinkingEffort(model, cfg);
        return { text: finalReplyText, model, thinkingEffort };
      } catch (err) {
        logger.error(`Fallback default model ${model} failed. Error:`, err.message);
        reportedIssue += `⚠️ *(Auto-Fallback: \`${model}\` failed...)*\n\n`;
      }
    }
  }

  // ── Donated API Keys Fallback ─────────────────────────────────────────────
  const donatedKeys = getDonatedApiKeys();
  if (donatedKeys.length > 0) {
    logger.log(`[Router] Primary API key failed. Attempting fallback with ${donatedKeys.length} donated key(s)...`);
    const fallbackModels = [...new Set([...modelList, ...modelsDefault])];

    for (let k = 0; k < donatedKeys.length; k++) {
      const donatedKey = donatedKeys[k];
      const tempProvider = createGeminiProvider(donatedKey);

      for (const model of fallbackModels) {
        try {
          const donatedConfig = {
            systemInstruction: SYSTEM_PROMPT,
            temperature: taskType === "NORMAL" ? 1.0 : 0.7,
            ...getThinkingConfig(model, cfg),
          };
          if (useSearch) donatedConfig.tools = [{ googleSearch: {} }];

          const replyText = await tempProvider.generateText(model, contents, donatedConfig);
          let finalReplyText = replyText || "hmm, I got nothing 🤔";
          logger.log(`[Router] Donated key #${k + 1} succeeded on ${model}`);
          if (reportedIssue && cfg.show_errors_in_chat !== false) {
            finalReplyText = reportedIssue + finalReplyText;
          }
          const thinkingEffort = getThinkingEffort(model, cfg);
          return { text: finalReplyText, model, thinkingEffort };
        } catch (err) {
          const is429 = err?.message?.includes('"code":429') || err?.message?.includes("RESOURCE_EXHAUSTED") || err?.message?.includes("QUOTA_EXCEEDED") || err?.status === 429;
          logger.warn(`[Router] Donated key #${k + 1} failed on ${model}: ${err.message}`);
          if (is429) {
            break;
          }
        }
      }
    }
  }

  logger.error("[Router] FATAL: All models in all lists and donated keys exhausted.");
  const fatalMsg = (cfg.show_errors_in_chat === false)
    ? "⚠️ *[All models failed - check logs]* I had an error with all available models. Out of tokens or quota! 🤦‍♂️"
    : reportedIssue + "I had an error with all available models. Out of tokens or quota! 🤦‍♂️";
  return { text: fatalMsg, model: "none" };
}

/**
 * Sends the same prompt to multiple models in parallel for side-by-side comparison.
 * Returns an array of { model, reply, error, durationMs } objects.
 */
export async function generateComparisonReply(channelId, userText, guildId = null, guild = null) {
  const cfg = loadConfig();
  const compareModels = resolveModelList(cfg.model_compare?.models || []);

  if (compareModels.length === 0) {
    return [{ model: "none", reply: null, error: "No comparison models configured.", durationMs: 0 }];
  }

  const history = getHistory(channelId);
  const contents = buildHistoryContents(history);

  const memoryBlock = buildMemoryBlock(guildId, channelId);
  const savedImages = getSavedImagesList();
  const imagesBlock = savedImages.length > 0
    ? `\n\n--- YOUR SAVED IMAGES ---\nYou currently have these images saved in your library:\n${savedImages.map(f => `- ${f}`).join("\n")}\nYou can send them using [SEND_IMG: name].\n--- END SAVED IMAGES ---`
    : "\n\n--- YOUR SAVED IMAGES ---\nYour library is empty. You can save images using [SAVE_IMG: url | name].\n--- END SAVED IMAGES ---";
  const emojisBlock = guild ? buildGuildEmojisBlock(guild) : "";

  const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT + memoryBlock + imagesBlock + emojisBlock;

  logger.log(`[Compare] Starting comparison across ${compareModels.length} models: ${compareModels.join(", ")}`);
  logger.log(`\n[Raw AI Input]:\n${formatContentsForLog(contents)}\n--------------------------`);
  logger.debug(`\n[Raw AI System Instruction]:\n${SYSTEM_PROMPT}\n--------------------------`);

  const promises = compareModels.map(async (model) => {
    const start = Date.now();
    try {
      const replyText = await aiProvider.generateText(model, contents, {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.7,
      });
      const durationMs = Date.now() - start;
      logger.debug(`[Compare] ${model} responded in ${durationMs}ms`);
      logger.log(`\n[Raw AI Response (${model})]:\n${replyText}\n--------------------------`);
      return { model, reply: replyText || "(empty response)", error: null, durationMs };
    } catch (err) {
      const durationMs = Date.now() - start;
      logger.error(`[Compare] ${model} failed (${durationMs}ms):`, err.message);
      logger.log(`\n[Raw AI Response (${model})]:\n[ERROR: ${err.message}]\n--------------------------`);
      return { model, reply: null, error: err.message, durationMs };
    }
  });

  return Promise.all(promises);
}

/**
 * Generates a one-shot AI reply from a standalone prompt (no conversation history).
 * Used for greetings, scheduled messages, etc.
 * @param {string} prompt - The prompt text
 * @param {string|null} guildId - Optional guild ID for memory context
 * @param {import("discord.js").Guild|null} guild - Optional Discord guild object
 * @param {string|null} channelId - Optional channel ID for temp memory context
 * @returns {Promise<string>} The AI reply text
 */
export async function generatePromptReply(prompt, guildId = null, guild = null, channelId = null) {
  const cfg = loadConfig();
  const modelList = getTaskModels("NORMAL", cfg);

  const memoryBlock = buildMemoryBlock(guildId, channelId);
  const emojisBlock = guild ? buildGuildEmojisBlock(guild) : "";
  const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT + memoryBlock + emojisBlock;

  const contents = [{ role: "user", parts: [{ text: prompt }] }];

  logger.log(`\n[Raw AI Input]:\n[user]: ${prompt}\n--------------------------`);
  logger.debug(`\n[Raw AI System Instruction]:\n${SYSTEM_PROMPT}\n--------------------------`);

  // 1. Try primary key
  for (const model of modelList) {
    try {
      const replyText = await aiProvider.generateText(model, contents, {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 1.0,
      });
      if (replyText) {
        logger.log(`\n[Raw AI Response]:\n${replyText}\n--------------------------`);
        return replyText;
      }
    } catch (err) {
      logger.warn(`[PromptReply] Model ${model} failed:`, err.message);
    }
  }

  // 2. Fallback to donated keys
  const donatedKeys = getDonatedApiKeys();
  if (donatedKeys.length > 0) {
    for (let k = 0; k < donatedKeys.length; k++) {
      const tempProvider = createGeminiProvider(donatedKeys[k]);
      for (const model of modelList) {
        try {
          const replyText = await tempProvider.generateText(model, contents, {
            systemInstruction: SYSTEM_PROMPT,
            temperature: 1.0,
          });
          if (replyText) {
            logger.log(`\n[Raw AI Response]:\n${replyText}\n--------------------------`);
            return replyText;
          }
        } catch (err) {
          logger.warn(`[PromptReply] Donated key #${k + 1} failed on ${model}:`, err.message);
        }
      }
    }
  }

  return "Welcome! 👋";
}

const summarizingChannels = new Set();
const lastTempSummaryAt = new Map();
const TEMP_SUMMARY_COOLDOWN_MS = 45 * 1000;

/**
 * Generates or refreshes a concise, strictly factual temporary memory summary for a channel
 * in the background. Safe to fire-and-forget; never throws.
 *
 * @param {string} channelId
 * @param {string|null} guildId
 * @param {{ channelName?: string, isPrivate?: boolean }} channelMeta
 * @param {{ force?: boolean }} options
 */
export async function maybeUpdateTempMemory(channelId, guildId = null, channelMeta = {}, options = {}) {
  if (!channelId) return;
  const cfg = loadConfig();
  if (cfg.temp_memory_enabled === false) return;
  if (summarizingChannels.has(channelId)) return;

  const lastRun = lastTempSummaryAt.get(channelId) || 0;
  if (!options.force && Date.now() - lastRun < TEMP_SUMMARY_COOLDOWN_MS) return;

  const history = getHistory(channelId);
  if (!history || history.length < 2) return;

  summarizingChannels.add(channelId);
  lastTempSummaryAt.set(channelId, Date.now());

  try {
    const recentEntries = history.slice(-15);
    const transcript = recentEntries
      .map(e => {
        const label = e.role === "model" ? "[Bot]" : "[Chat]";
        const clean = (e.text || "").replace(/\s+/g, " ").trim().substring(0, 300);
        return `${label} ${clean}`;
      })
      .join("\n");

    const existing = getTempMemory(channelId);
    const priorBlock = existing?.summary
      ? `Previous temp summary:\n${existing.summary}\n\n`
      : "";

    const prompt = `Summarize the ongoing Discord conversation in #${channelMeta.channelName || channelId} into a short temporary memory to ground the AI and prevent hallucinations.

${priorBlock}Recent messages:
${transcript}

Rules:
- Output ONLY 2-4 concise bullet points or sentences (max 450 characters total).
- Record ONLY concrete facts directly stated (active participants, current topic/task, decisions/claims made, open questions).
- NEVER guess, extrapolate, or invent details not explicitly in the messages.
- If the messages are just meaningless greetings/noise with no real context and there is no prior summary worth keeping, reply with exactly: NONE`;

    const registry = loadModelRegistry();
    const classifierModels = getTaskModels("CLASSIFIER", cfg, registry);
    const fallbackModels = getTaskModels("NORMAL", cfg, registry);
    const candidates = classifierModels.length > 0 ? classifierModels : fallbackModels.slice(0, 1);

    for (const model of candidates) {
      try {
        const reply = await aiProvider.generateText(
          model,
          [{ role: "user", parts: [{ text: prompt }] }],
          { maxOutputTokens: 220, temperature: 0.2 }
        );
        const trimmed = (reply || "").trim();
        if (!trimmed) continue;

        if (trimmed.toUpperCase() === "NONE") {
          resetTempMemoryCounter(channelId);
        } else {
          setTempMemory(channelId, trimmed.substring(0, 500), { guildId, ...channelMeta });
        }
        break;
      } catch (err) {
        logger.debug(`[TempMemory] Auto-summary failed on ${model}:`, err.message);
      }
    }
  } catch (err) {
    logger.debug(`[TempMemory] Background summarization error for ${channelId}:`, err.message);
  } finally {
    summarizingChannels.delete(channelId);
  }
}
