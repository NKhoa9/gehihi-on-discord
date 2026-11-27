import { GoogleGenAI } from "@google/genai";
import { logger } from "../utils/logger.js";

export class AIProvider {
  async generateText(model, contents, config) { throw new Error("Not implemented"); }
  async generateTextWithThoughts(model, contents, config) {
    const text = await this.generateText(model, contents, config);
    return { text, thoughts: "" };
  }
  async generateImage(model, prompt) { throw new Error("Not implemented"); }
  async generateVideo(model, prompt) { throw new Error("Not implemented"); }
}

export class GeminiProvider extends AIProvider {
  constructor(apiKey) {
    super();
    this.client = new GoogleGenAI({ apiKey });
  }

  async generateText(model, contents, config) {
    const response = await this.client.models.generateContent({ model, contents, config });

    // Check for truncation due to max output tokens
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason === "MAX_TOKENS") {
      logger.warn(`[Provider] Response from ${model} was TRUNCATED (finishReason: MAX_TOKENS). Consider increasing maxOutputTokens.`);
    } else if (finishReason && finishReason !== "STOP") {
      logger.warn(`[Provider] Response from ${model} ended with finishReason: ${finishReason}`);
    }

    return response.text?.trim() || "";
  }

  async generateTextWithThoughts(model, contents, config) {
    const response = await this.client.models.generateContent({ model, contents, config });

    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason === "MAX_TOKENS") {
      logger.warn(`[Provider] Response from ${model} was TRUNCATED (finishReason: MAX_TOKENS). Consider increasing maxOutputTokens.`);
    } else if (finishReason && finishReason !== "STOP") {
      logger.warn(`[Provider] Response from ${model} ended with finishReason: ${finishReason}`);
    }

    const parts = response.candidates?.[0]?.content?.parts || [];
    const thoughtParts = [];
    const textParts = [];
    for (const part of parts) {
      if (typeof part.text === "string") {
        if (part.thought === true) {
          thoughtParts.push(part.text);
        } else {
          textParts.push(part.text);
        }
      }
    }

    const text = (textParts.join("") || response.text || "").trim();
    const thoughts = thoughtParts.join("\n").trim();
    return { text, thoughts };
  }

  async generateImage(model, prompt) {
    return await this.client.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseModalities: ["TEXT", "IMAGE"], temperature: 1.0 },
    });
  }

  async generateVideo(model, prompt) {
    return await this.client.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseModalities: ["TEXT", "VIDEO"], temperature: 1.0 },
    });
  }
}

export function createGeminiProvider(apiKey) {
  return new GeminiProvider(apiKey);
}

