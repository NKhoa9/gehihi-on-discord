# Gemini Discord Bot Context

Welcome to the Gemini Discord Bot codebase! This document provides a comprehensive overview of the bot's features, architecture, and current capabilities. It is intended to help future developers or AI assistants quickly understand how the bot works.

## Tech Stack
- **Node.js**
- **discord.js** (v14+): Used for interacting with the Discord API, handling messages, and slash commands.
- **@google/genai**: The official Google Gen AI SDK used to interact with Gemini models.
- **dotenv**: For managing environment variables.

## Core Features & Architecture

### 1. Intelligent Model Routing & Fallback System
To optimize API usage and provide the best answers (especially on free tiers), the bot features a dynamic model router. 
- **Classification**: Before answering, if a prompt is >10 characters, it uses a fast, lightweight call (`classifyPrompt`) to categorize the prompt into `SEARCH`, `THINKING`, or `NORMAL`.
- **Model Lists**: Each category maps to an array of models (e.g., `MODELS_THINKING = ["gemini-3.5-flash", "gemini-2.5-flash"]`).
- **Auto-Fallback**: The bot attempts to use the first model in the corresponding list. If the API returns a rate limit (429) or quota exceeded error, it seamlessly fails over to the next model in the list. If all models in the category fail, it falls back to the `MODELS_DEFAULT` list.
- **User Notification**: When a fallback occurs, a system warning is prepended to the final response to maintain transparency.

### 2. Autonomous Rich Embed Generation
The AI has full control over its formatting via the `[EMBED]` tag mechanism.
- The `SYSTEM_PROMPT` instructs the AI to use `[EMBED]` when it wants to send structured, complex, or long information.
- **JSON Parsing**: The AI can output raw JSON following the `[EMBED]` tag. The bot intercepts this, strips the tag, and parses the JSON to construct a **fully custom Discord Embed** (supporting `title`, `description`, `color`, `fields`, and `footer`).
- **Standard Embeds / Text**: If the AI just outputs plain text after the tag, the bot wraps it in a standard Google Blue (`0x4285F4`) embed. If no tag is present, it responds in normal plain text. (Embeds also bypass the 2,000 character limit by utilizing the 4,096 character description limit).

### 3. Attachment & Multimodal Support
The bot supports reading multiple attachment types natively by converting them to `inlineData` base64 strings before sending them to Gemini.
- **Supported types**:
  - Images (`png`, `jpeg`, `webp`, `gif`, `heic`, `heif`)
  - Documents & Text (`pdf`, `txt`, `html`, `css`, `js`, `json`, `csv`, `md`, `py`, `xml`)
  - Audio (`wav`, `mp3`, `mpeg`, `ogg`)
  - Video (`mp4`, `mpeg`, `webm`)

### 4. Memory & Conversation History
- The bot maintains a per-channel conversation history (`channelHistory` map).
- It retains the last `MAX_HISTORY` (default 30) messages to maintain context.
- Users can wipe the current channel's memory using the `/clear` slash command.

### 5. Moderation & Utility Commands
The bot provides a suite of slash commands for server management (requires appropriate Discord permissions):
- `/ping`: Checks bot latency.
- `/clear`: Clears the bot's conversation memory for the current channel.
- `/kick [user] [reason]`: Kicks a member.
- `/ban [user] [reason]`: Bans a member.
- `/unban [userid] [reason]`: Unbans a member by their ID.
- `/timeout [user] [duration] [reason]`: Times out a member for a specified number of minutes.
- `/purge [amount]`: Bulk deletes up to 100 recent messages.

## Environment Variables (.env)
- `DISCORD_TOKEN`: Your Discord bot token.
- `GEMINI_API_KEY`: Your Google Gemini API key.
- `GEMINI_MODEL`: (Optional) Can be used to override the primary default model.
- `MAX_HISTORY`: (Optional) Overrides the default 30-message history limit.

## Important Notes for Future Development
- The `messageCreate` event handler requires the bot to be mentioned or replied to directly. It ignores its own messages and other bots.
- The bot automatically chunks its responses (whether plain text or embeds) to adhere to Discord's API limits.
- When expanding the JSON embed schema parsing, ensure `finalReply.match(/\{[\s\S]*\}/)` and the `EmbedBuilder` setters remain heavily sanitized and wrapped in `try/catch` to prevent bot crashes from malformed AI output.
