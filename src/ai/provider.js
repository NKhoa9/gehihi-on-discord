import { GoogleGenAI } from "@google/genai";
import { logger } from "../utils/logger.js";

export class AIProvider {
  async generateText(model, contents, config) { throw new Error("Not implemented"); }
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

