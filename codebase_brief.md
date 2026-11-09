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
- `models.json` — Model series registry for named model pools.
- `config.json` — Central configuration file for all quick-change settings (models, rates, voice, etc.).
- `system_prompt.txt` — The core system prompt containing instructions and persona for the AI.
- `memories.json` — Persistent AI memory storage (per-guild, auto-generated, gitignored).
- `src/ai/models.js` — Model registry management, series resolution, category and series manipulation.
- `src/ai/router.js` — Dynamic prompt classification, model fallback router, comparison mode, one-shot prompt generation, and RAW AI input/output logging.
- `src/core/channel_control.js` — Per-channel AI enable/disable management.
- `src/core/scheduler.js` — Autonomous scheduled tasks (random intervals or fixed daily UTC times).
- `src/core/trigger.js` — Smart contextual response trigger algorithm (beta) vs classic random appear rate.
- `src/core/emojis.js` — Server custom emoji awareness, prompt injection, and bidirectional name/ID resolution.
- `src/core/memory.js` — Persistent per-guild memory tagging (`[MEMORY:ADD]`, `[MEMORY:EDIT]`, `[MEMORY:DELETE]`).
- `src/media/attachments.js` — Dynamic file attachment handling: accepts any image/audio/video/PDF/code/text file without a hardcoded whitelist, with binary detection fallback.
- `lib/ran_img/` — Library of random images the bot can send via `[IMG]` tag. Persists across restarts.
- `lib/gen_img/` — AI-generated images stored here automatically. Gitignored.
- `.env` — Environment secrets (DISCORD_TOKEN, GEMINI_API_KEY).
- `context.md` — This file.

## Core Features & Architecture

### 1. Centralized Configuration (`config.json`)
All tunable settings live in `config.json` for quick changes without touching code:
- `logging` — Toggle file logging on/off (default: `true`). Console logging always remains active regardless of this setting.
- `debug_logging` — Toggle ultra-detailed step-by-step debug logging (default: `true`).
- `show_errors_in_chat` — If `false`, massive model fallback errors are hidden from the Discord chat and replaced with a compact warning, keeping chat clean (default: `false`).
- `max_history` — Messages to keep in memory per channel (default: 30).
- `response_mode` — Response trigger strategy: `"smart"` (contextual momentum, bot name boost, anti-burst fatigue) or `"random"` (classic flat random dice) (default: `"smart"`).
- `random_appear_rate` — Probability (0–1) of the bot spontaneously responding to unmentioned messages in random mode, or base rate in smart mode (default: 0.2).
- `silence_duration_ms` — Voice silence threshold before the bot considers the user done speaking (default: 200).
- `voice_name` — Gemini Live voice persona (e.g., "Aoede", "Charon", "Fenrir", "Kore", "Puck").
- `model_mode` — Default model selection preference (`flash` vs `flash-lite`).
- `greet_new_members` — Toggle autonomous AI greeting for new members joining the server (default: `true`).
- `greet_channel_id` — (Optional) Specific channel ID for greetings; defaults to system channel or first sendable text channel.
- `disabled_channels` — Array of channel IDs where the AI is completely disabled from auto-responding.
- `scheduled_tasks` — Array of configured periodic or daily scheduled messages.
- `model_compare` — Configuration for side-by-side multi-model comparison debug mode.
- `models.*` — Model lists/series for built-in and custom task categories.

Both `bot.js` and `voice.js` read from this file dynamically on each execution, allowing settings to be hot-reloaded without restarting the bot.

### 2. Intelligent Model Routing & Provider Abstraction
To optimize API usage and provide the best answers, the bot uses a dynamic model router and an abstract `AIProvider`.
- **AI Abstraction**: The core generation logic is routed through an `AIProvider` class interface. Swappable providers.
- **Classification**: Before answering, if a prompt is >10 characters, it uses a fast, lightweight call (`classifyPrompt`) to categorize the prompt into `SEARCH`, `THINKING`, or `NORMAL`.
- **Model Series & Pools (`models.json`)**: Models are grouped into series (e.g., `flash-lite-series`, `flash-series`, `gemma-series`, or custom series). Task categories reference series or concrete model names.
- **Auto-Fallback & Retries**: The bot attempts models in priority order, retrying on 429 errors with exponential backoff before failing over to fallback models and donated keys.
- **Side-by-Side Model Comparison Mode**: Admins can enable comparison mode (`/compare`) with a list of models (`/compare_add`, `/compare_remove`, `/compare_models`). In this mode, the bot queries all selected models simultaneously and sends side-by-side color-coded embeds.
- **Raw Input & Output Logging**: Complete logging of the raw AI input (conversation turns, roles, attachments) and raw AI response (before tag stripping) to console and `bot.log`. System instruction is captured at DEBUG level.

### 3. Custom Model Series & Task Categories
Users and admins have complete flexibility over model categorization:
- **Custom Series in `models.json`**: Create named pools of models using `/series_create [name] [models]` and delete them with `/series_delete [name]`. Add/remove/move models with `/series_add`, `/series_remove`, `/series_move`.
- **Custom Task Categories in `config.json`**: Create new task categories using `/category_create [name] [items]` and delete them with `/category_delete [name]`. Assign models/series with `/model_add`, `/model_remove`, `/model_move`.
- **Chat Triggers**: Users can trigger custom categories or series directly in chat using either `[CATEGORY: <name>]` or `[<name>]` (e.g. `[coding] write a python script`).
- **Slash Command Autocomplete**: `/set_models`, `/model_add`, `/model_remove`, `/model_move`, `/series_add`, `/series_remove`, `/series_move`, and `/series_list` feature live dynamic autocomplete for all existing categories and series.

### 4. Per-Channel AI Control (`channel_control.js`)
Admins can disable AI auto-responses in specific channels to avoid disruptions:
- `/disable_ai [channel]` — Disables AI auto-responses, greetings, and scheduled messages in the specified channel (or current channel).
- `/enable_ai [channel]` — Re-enables AI responses in a previously disabled channel.
- `/config_check` — Lists all currently disabled channels.

### 5. Scheduled Tasks System (`scheduler.js`)
The bot can autonomously send periodic messages or announcements:
- **Random-Interval Tasks**: Fires at randomized intervals within a configured window (e.g., every 60–480 minutes).
- **Daily Fixed-Time Tasks**: Fires once every day at a specific hour and minute in UTC.
- **Commands**:
  - `/schedule_add` — Create a scheduled message (supports channel, prompt, random vs. daily, interval range, UTC hour/minute).
  - `/schedule_remove [id]` — Remove a scheduled task.
  - `/schedule_toggle [id]` — Pause or resume a scheduled task.
  - `/schedule_list` — View all configured scheduled tasks with status and schedule info.
- **Persistence**: Scheduled tasks are saved in `config.json` and automatically re-initialized when the bot boots up.

### 6. New Member AI Greetings
When someone joins the server (`guildMemberAdd`):
- The bot generates a warm, personalized welcome message using `generatePromptReply`.
- It posts the greeting to `greet_channel_id` (if configured), the guild's system channel, or the first available text channel where the bot has send permissions.
- Greetings respect channel disable status (`/disable_ai`) and can be toggled on/off globally via `/config setting: greet_new_members value: false`.

### 7. Autonomous Rich Embed Generation
The AI has full control over its formatting via the `[EMBED]` tag mechanism.
- The system prompt instructs the AI to use `[EMBED]` when it wants to send structured, complex, or long information.
- Supports both parsed JSON custom embeds and standard auto-wrapped Google Blue embeds.

### 8. Response Trigger Algorithms (`trigger.js`)
Supports two trigger modes, switchable via `/config setting: response_mode value: smart|random`:
- **Direct Triggers**: Always responds to `@mentions` and replies to the bot's own messages.
- **Smart Dynamic Mode (`"smart"`)**:
  - Suppresses bot command prefixes (`!`, `/`, `?`, `$`, `-`, etc.) and short noise messages.
  - High probability boost (0.85+) when the bot's name or nickname is mentioned anywhere in the message.
  - Conversation momentum boost (decays over a 90-second active window) so conversations flow naturally without needing constant `@mentions`.
  - Question detection boost (+0.20) for inquisitive messages.
  - Anti-burst fatigue protection prevents spamming when responding unprompted in quick succession.
- **Classic Random Mode (`"random"`)**: Uses flat `Math.random() < random_appear_rate`.

### 9. Server Custom Emojis & Message Reactions Support (`emojis.js`, `history.js`)
- **Server Emoji Awareness**: Injects a compact list of the server's custom emojis (`<:name:id> (:name:)`) into the system prompt. Handled with `GuildExpressions` intent and automatic guild cache pre-fetching on startup and incoming messages.
- **Bidirectional Resolution**: The AI can write custom emojis as `:emoji_name:` or `<:name:id>` in text responses. Standalone `:emoji_name:` tags are resolved to Discord's custom emoji tags before sending.
- **Reaction Resolution & Sanitization**: The AI can react using `[REACT: :emoji_name:]`, `[REACT: emoji_name]`, or `[REACT: <:name:id>]`. Resolves directly to the custom emoji ID for `message.react()`. Standard Unicode emojis (`🍎`) remain fully supported. Defensively strips accidental reaction counts (e.g. `x1`, `x2`) and safely ignores non-existent custom emojis to prevent Discord API `Unknown Emoji` errors.
- **Reaction Visibility on Messages**: Messages in the AI context include reaction summaries (e.g. `[reactions: 👍 x2, 🔥 x1]`). Tracked in real time via `GuildMessageReactions` intent, `messageReactionAdd`/`Remove` listeners, and pre-generation cache synchronization.

### 10. Universal File Attachment Handling (`attachments.js`)
- **No Hardcoded Extension Whitelist**: Automatically accepts any media, document, config, or code file (`.rs`, `.go`, `.py`, `.c`, `.cpp`, `.ts`, `.toml`, `.yaml`, `.env`, etc.).
- **Dynamic Type Detection**:
  - Image, audio, video, and PDF files are passed directly with their media MIME types.
  - Non-media files are inspected via UTF-8 null-byte analysis (`isTextBuffer`); valid text/code files are converted to `text/plain` and fed into Gemini inline data with their filename.
  - Unsupported compiled binaries (e.g. `.exe`, `.zip`, `.dll`) are detected and rejected gracefully with an in-chat indicator instead of causing Gemini API 400 errors.

### 11. Persistent AI Memory Classification System (`memory.js`)
Persistent AI memory stored in `memories.json` with a two-tier classification:
- **Universal Memories** (`_universal`): Global facts, skills, learned capabilities, and general knowledge that apply across all servers and DMs. Injected as `[UNIVERSAL FACTS & SKILLS]` in prompts.
- **Server-Specific Memories** (`<guildId>`): Local server context, member nicknames, channel lore, and running jokes to ensure natural conversation flow. Injected as `[SERVER-SPECIFIC CONTEXT]` in prompts.
- **Autonomous Tags**:
  - `[MEMORY:ADD:UNIVERSAL text]` or `[MEMORY:ADD UNIVERSAL: text]` — Adds to universal memory.
  - `[MEMORY:ADD:SERVER text]` or `[MEMORY:ADD SERVER: text]` — Adds to server-specific memory.
  - `[MEMORY:ADD text]` — Defaults to server memory if in a guild, or universal if in a DM.
  - `[MEMORY:EDIT #id text]` — Edits memory by ID across server and universal stores.
  - `[MEMORY:DELETE #id (reason)]` — Deletes memory by ID across server and universal stores.
- **Commands**:
  - `/memories [scope: all|universal|server]` — Ephemeral view of AI memories segregated by scope.
  - `/reset_memory [scope: server|universal|all]` — [Admin] Selectively reset server memories, universal memories, or all memories.

### 11. Voice Channel Integration (Gemini Live)
- Real-time voice conversations using Gemini Live WebSocket and Opus audio pipeline.
- Commands: `/join` and `/leave`.

### 12. Admin, Moderation & Utility Commands
**Admin Commands (Requires User ID to be in `ADMINS` inside `.env`)**:
- `/reset_memory` — Completely wipes the AI's saved memories for the server.
- `/pause_ai` — Toggles pausing/unpausing the AI from generating text responses globally.
- `/config [setting] [value]` — Updates `config.json` settings directly from Discord.
- `/config_check` — Displays the complete bot configuration, model categories, series pools, disabled channels, and scheduled tasks in a rich embed.
- `/logs [lines]` — Views recent log entries.
- `/disable_ai [channel]` — Disables AI responses in a channel.
- `/enable_ai [channel]` — Re-enables AI responses in a channel.
- `/schedule_add` / `/schedule_remove` / `/schedule_toggle` / `/schedule_list` — Manages scheduled AI messages.
- `/series_create` / `/series_delete` / `/series_add` / `/series_remove` / `/series_move` / `/series_list` — Manages model series in `models.json`.
- `/category_create` / `/category_delete` / `/model_add` / `/model_remove` / `/model_move` / `/set_models` — Manages task categories in `config.json`.
- `/compare` / `/compare_add` / `/compare_remove` / `/compare_models` — Manages multi-model side-by-side comparison mode.
- `/add_image [name] [url|file]` — Adds an image to the bot's library.

**Utility & Moderation Commands**:
- `/ping` — Checks bot latency.
- `/clear` — Clears conversation history for the current channel.
- `/memories` — Views persistent saved memories for the server.
- `/donate_key [key]` / `/remove_key` — Donates or removes a Gemini API key.
- `/add_custom_img` — Adds an image (rate-limited for members).
- `/join` / `/leave` — Voice channel controls.
- `/kick`, `/ban`, `/unban`, `/timeout`, `/purge` — Standard moderation tools.

## Environment Variables (.env)
- `DISCORD_TOKEN`: Your Discord bot token (required).
- `GEMINI_API_KEY`: Your Google Gemini API key (required).
- `ADMINS`: Comma-separated Discord User IDs authorized for admin commands.
