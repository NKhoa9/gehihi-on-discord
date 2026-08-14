import { GoogleGenAI } from "@google/genai";

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
