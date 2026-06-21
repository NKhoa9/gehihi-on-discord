# Gemini Discord Bot Context

Welcome to the Gemini Discord Bot codebase! This document provides a comprehensive overview of the bot's features, architecture, and current capabilities. It is intended to help future developers or AI assistants quickly understand how the bot works.

## Tech Stack
- **Node.js** (ES Modules)
- **discord.js** (v14+): Used for interacting with the Discord API, handling messages, and slash commands.
- **@google/genai**: The official Google Gen AI SDK used to interact with Gemini models.
- **@discordjs/voice**: For voice channel integration with Gemini Live.
- **prism-media** + **ffmpeg-static**: Audio encoding/decoding for voice (Opus ↔ PCM resampling).
- **ws**: WebSocket client for Gemini Live API.
- **dotenv**: For managing environment variables.

## File Structure
- `bot.js` — Main bot logic: Discord client, message handling, Gemini API integration, memory system, slash commands.
- `voice.js` — Voice channel module: Gemini Live WebSocket, audio pipeline, join/leave logic.
- `config.json` — Central configuration file for all quick-change settings (models, rates, voice, etc.).
- `system_prompt.txt` — The core system prompt containing instructions and persona for the AI.
- `memories.json` — Persistent AI memory storage (per-guild, auto-generated, gitignored).
- `.env` — Environment secrets (DISCORD_TOKEN, GEMINI_API_KEY).
- `context.md` — This file.

## Core Features & Architecture

### 1. Centralized Configuration (`config.json`)
All tunable settings live in `config.json` for quick changes without touching code:
- `max_history` — Messages to keep in memory per channel (default: 30).
- `random_appear_rate` — Probability (0–1) of the bot spontaneously responding to unmentioned messages (default: 0.2).
- `silence_duration_ms` — Voice silence threshold before the bot considers the user done speaking (default: 300).
- `voice_name` — Gemini Live voice persona (e.g., "Aoede", "Charon", "Fenrir", "Kore", "Puck").
- `models.default` / `models.thinking` / `models.search` / `models.live` — Model lists for each task category.

Both `bot.js` and `voice.js` read from this file at startup (with hardcoded fallback defaults if the file is missing).

### 2. Intelligent Model Routing & Fallback System
To optimize API usage and provide the best answers (especially on free tiers), the bot features a dynamic model router.
- **Classification**: Before answering, if a prompt is >10 characters, it uses a fast, lightweight call (`classifyPrompt`) to categorize the prompt into `SEARCH`, `THINKING`, or `NORMAL`.
- **Model Lists**: Each category maps to an array of models defined in `config.json`.
- **Auto-Fallback**: The bot attempts to use the first model in the corresponding list. If the API returns a rate limit (429) or quota exceeded error, it seamlessly fails over to the next model in the list. If all models in the category fail, it falls back to the `MODELS_DEFAULT` list.
- **Retry Logic**: Each model gets up to `MAX_RETRIES` (2) attempts with exponential backoff (5s, 15s) on 429 errors before moving to the next model.
- **User Notification**: When a fallback occurs, a system warning is prepended to the final response to maintain transparency.

### 3. Autonomous Rich Embed Generation
The AI has full control over its formatting via the `[EMBED]` tag mechanism.
- The system prompt instructs the AI to use `[EMBED]` when it wants to send structured, complex, or long information.
- **JSON Parsing**: The AI can output raw JSON following the `[EMBED]` tag. The bot intercepts this, strips the tag, and parses the JSON to construct a **fully custom Discord Embed** (supporting `title`, `description`, `color`, `fields`, and `footer`).
- **Standard Embeds / Text**: If the AI just outputs plain text after the tag, the bot wraps it in a standard Google Blue (`0x4285F4`) embed. If no tag is present, it responds in normal plain text. (Embeds also bypass the 2,000 character limit by utilizing the 4,096 character description limit).

### 4. Autonomous Interaction & Personality
The bot behaves like a true participant in the server rather than just a command-response tool.
- **Contextual Awareness**: Every user message in the server is silently added to the conversation history (prefixed with the user's display name **and Discord User ID**). This means the AI always knows the ongoing context and exactly who is speaking, allowing it to remember specific users (e.g. for creating admin whitelists).
- **Probability Gate**: To save API quota while still acting autonomously, the bot will randomly "wake up" to process normal, unmentioned chat messages (configurable via `random_appear_rate` in `config.json`). It will *always* process messages if directly `@mentioned` or replied to.
- **Dynamic Reactions**: When processing a message, the AI is instructed in its system prompt that it has full autonomy to:
  - Output `[REACT: emoji]` to simply react to the message with a chosen emoji.
  - Output `[IGNORE]` to purposely stay silent and ignore the message.
  - Output normal text or an `[EMBED]` to join the conversation.

### 5. Persistent AI Memory System
The AI can autonomously create, edit, and delete its own memories — persisted to `memories.json` (per-guild).
- **How it works**: The system prompt teaches the AI to use special tags anywhere in its response:
  - `[MEMORY:ADD text]` — Save a new memory.
  - `[MEMORY:EDIT #N text]` — Edit memory number N.
  - `[MEMORY:DELETE #N reason]` — Delete memory number N.
- **Silent processing**: After the AI generates its response, `processMemoryTags()` extracts and executes all memory operations, then strips the tags from the visible reply. Users never see the raw tags.
- **Injection**: Before each API call, `buildMemoryBlock()` appends the current memories to the system prompt so the AI always has access to them.
- **Storage**: `memories.json` stores memories keyed by guild ID. Each memory has `text`, `createdAt`, and optionally `updatedAt` fields.
- **Proactive usage**: The AI is instructed to proactively save useful information like user preferences, nicknames, birthdays, inside jokes, etc.
- **Viewing memories**: Users can use the `/memories` slash command to view all saved memories for their server (ephemeral, only visible to the user who runs it).

### 6. Attachment & Multimodal Support
The bot supports reading multiple attachment types natively by converting them to `inlineData` base64 strings before sending them to Gemini.
- **Supported types**:
  - Images (`png`, `jpeg`, `webp`, `gif`, `heic`, `heif`)
  - Documents & Text (`pdf`, `txt`, `html`, `css`, `js`, `json`, `csv`, `md`, `py`, `xml`)
  - Audio (`wav`, `mp3`, `mpeg`, `ogg`)
  - Video (`mp4`, `mpeg`, `webm`)

### 7. Conversation History (per-channel)
- The bot maintains a per-channel conversation history (`channelHistory` map) in memory.
- It retains the last `max_history` (configurable, default 30) messages to maintain context.
- Only text is stored in history — image/attachment buffers are not retained to avoid memory bloat.
- Users can wipe the current channel's memory using the `/clear` slash command.

### 8. Voice Channel Integration (Gemini Live)
The bot can join a voice channel and have real-time voice conversations using Gemini Live API.
- **Join**: `/join` connects the bot to the user's voice channel and opens a WebSocket to Gemini Live.
- **Audio Pipeline**: Discord Opus → PCM (48kHz stereo) → FFmpeg resample to 16kHz mono → Gemini. Gemini's response: PCM 24kHz mono → FFmpeg resample to 48kHz stereo → Discord.
- **Interruption**: When a user starts speaking, any current bot audio playback is interrupted immediately.
- **Active speaker lock**: Prevents duplicate audio streams for the same user via an `activeSpeakers` Set.
- **Auto-reconnect**: If the WebSocket drops unexpectedly (codes 1000, 1006, 1008, 1011), the bot automatically reconnects with the next model in the `models.live` list.
- **Intentional disconnect**: The `/leave` command sets an `_intentionalClose` flag on the WebSocket itself (not the session map) to prevent the close handler from triggering reconnection after the session has been cleaned up.
- **Configurable**: Silence duration and voice name are configurable via `config.json`.

### 9. Moderation & Utility Commands
The bot provides a suite of slash commands for server management (requires appropriate Discord permissions):
- `/ping` — Checks bot latency.
- `/clear` — Clears the bot's conversation memory for the current channel.
- `/memories` — View the bot's saved memories for this server (ephemeral).
- `/join` — Join voice channel and start Gemini Live.
- `/leave` — Leave the voice channel.
- `/kick [user] [reason]` — Kicks a member.
- `/ban [user] [reason]` — Bans a member.
- `/unban [userid] [reason]` — Unbans a member by their ID.
- `/timeout [user] [duration] [reason]` — Times out a member for a specified number of minutes.
- `/purge [amount]` — Bulk deletes up to 100 recent messages.

### 10. Logging
- All bot activity is logged to both console and `bot.log` via a custom logger (`logger.log`, `logger.warn`, `logger.error`).
- The bot logs its **responses** (not user messages) for debugging and monitoring.
- Memory operations (add/edit/delete) are logged with details.
- Command usage is logged with the user's tag and command name.

## Environment Variables (.env)
- `DISCORD_TOKEN`: Your Discord bot token (required).
- `GEMINI_API_KEY`: Your Google Gemini API key (required).
- `MAX_HISTORY`: (Optional, legacy) Overrides `config.json`'s `max_history` if config is missing.

## Important Notes for Future Development
- The `messageCreate` event handler reads *all* messages in the channel to build history context, but uses a probability check (`random_appear_rate`) to decide whether to hit the Gemini API for unmentioned messages to conserve quota. It will always hit the API if directly `@mentioned` or replied to.
- The bot automatically chunks its responses (whether plain text or embeds) to adhere to Discord's API limits.
- When expanding the JSON embed schema parsing, ensure `finalReply.match(/\{[\s\S]*\}/)` and the `EmbedBuilder` setters remain heavily sanitized and wrapped in `try/catch` to prevent bot crashes from malformed AI output.
- Memory tags are processed *after* the response is generated but *before* it's sent to Discord. The stripping regex must stay in sync with the parsing regex.
- The `config.json` is loaded once at startup for `bot.js` constants, and on each call for `voice.js`. If you want hot-reload for bot.js settings, you'd need to call `loadConfig()` per-message instead.
