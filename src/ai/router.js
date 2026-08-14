import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import { loadConfig, sleep } from "../utils/config.js";
import { getHistory, pushHistory } from "../core/history.js";
import { getSavedImagesList } from "../media/images.js";
import { buildMemoryBlock } from "../core/memory.js";
import { AIProvider, GeminiProvider } from "./provider.js";

const LIB_GEN_IMG = path.resolve("lib/gen_img");
const LIB_GEN_VID = path.resolve("lib/gen_vid");

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

export async function generateImage(prompt) {
  const cfg = loadConfig();
  const imageModels = cfg.models?.image_gen || ["gemini-2.0-flash-preview-image-generation"];

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
  const videoModels = cfg.models?.video_gen || ["veo-2.0-generate-001"];

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
  const modelsDefault = cfg.models?.default || ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemma-4-31b"];

  for (const model of modelsDefault) {
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

export async function generateReply(channelId, userText, guildId = null) {
  const history = getHistory(channelId);

  const contents = history.map((entry) => {
    const parts = [{ text: entry.text }];
    if (entry.attachments && entry.attachments.length > 0) {
      for (const att of entry.attachments) {
        try {
          if (fs.existsSync(att.filepath)) {
            const buffer = fs.readFileSync(att.filepath);
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

  const memoryBlock = guildId ? buildMemoryBlock(guildId) : "";
  const savedImages = getSavedImagesList();
  const imagesBlock = savedImages.length > 0
    ? `\n\n--- YOUR SAVED IMAGES ---\nYou currently have these images saved in your library:\n${savedImages.map(f => `- ${f}`).join("\n")}\nYou can send them using [SEND_IMG: name].\n--- END SAVED IMAGES ---`
    : "\n\n--- YOUR SAVED IMAGES ---\nYour library is empty. You can save images using [SAVE_IMG: url | name].\n--- END SAVED IMAGES ---";

  const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT + memoryBlock + imagesBlock;

  let taskType = "NORMAL";
  let cleanedUserText = userText;

  if (/\[SEARCH\]/i.test(userText)) {
    taskType = "SEARCH";
    cleanedUserText = userText.replace(/\[SEARCH\]/gi, "").trim() || userText;
    logger.debug(`[Classifier] User forced SEARCH mode`);
  } else if (/\[THINKING\]/i.test(userText)) {
    taskType = "THINKING";
    cleanedUserText = userText.replace(/\[THINKING\]/gi, "").trim() || userText;
    logger.debug(`[Classifier] User forced THINKING mode`);
  } else if (cleanedUserText.length > 10) {
    taskType = await classifyPrompt(cleanedUserText);
    logger.debug(`[Classifier] Auto-classified as ${taskType}`);
  }

  const cfg = loadConfig();
  const modelsDefault = cfg.models?.default;
  const modelsSearch = cfg.models?.search;
  const modelsThinking = cfg.models?.thinking;

  let modelList = modelsDefault;
  let useSearch = false;

  if (taskType === "SEARCH") {
    modelList = modelsSearch;
    useSearch = true;
  } else if (taskType === "THINKING") {
    modelList = modelsThinking;
  }

  let reportedIssue = "";
  const retryDelays = [5000, 15000];

  for (const model of modelList) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const config = {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.7,
          maxOutputTokens: 1000,
        };
        if (useSearch) config.tools = [{ googleSearch: {} }];
        else if (taskType === "NORMAL") {
          config.maxOutputTokens = 600;
          config.temperature = 1.0;
        }

        const replyText = await aiProvider.generateText(model, contents, config);
        let finalReplyText = replyText || "hmm, I got nothing 🤔";
        if (reportedIssue) finalReplyText = reportedIssue + finalReplyText;

        pushHistory(channelId, "model", finalReplyText);
        return finalReplyText;
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
        const replyText = await aiProvider.generateText(model, contents, {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 1.0,
          maxOutputTokens: 600,
        });
        let finalReplyText = replyText || "hmm, I got nothing 🤔";

        if (reportedIssue) {
          if (cfg.show_errors_in_chat === false) {
            finalReplyText = `⚠️ *[Model fallback occurred - check logs]*\n\n` + finalReplyText;
          } else {
            finalReplyText = reportedIssue + finalReplyText;
          }
        }

        pushHistory(channelId, "model", finalReplyText);
        return finalReplyText;
      } catch (err) {
        logger.error(`Fallback default model ${model} failed. Error:`, err.message);
        reportedIssue += `⚠️ *(Auto-Fallback: \`${model}\` failed...)*\n\n`;
      }
    }
  }

  logger.error("[Router] FATAL: All models in all lists exhausted.");
  if (cfg.show_errors_in_chat === false) return "⚠️ *[All models failed - check logs]* I had an error with all available models. Out of tokens or quota! 🤦‍♂️";
  return reportedIssue + "I had an error with all available models. Out of tokens or quota! 🤦‍♂️";
}
