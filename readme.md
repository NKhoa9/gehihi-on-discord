A random bon-bot created by a random person with the help of AIs (yeah)

Join my server to chat with the bot: https://discord.gg/CM6CSpCzXu

# A multi-purpose bot
Supports Discord moderation commands like: ban, kick, timeout, purge, etc...

# A bot to chat Gemini with AI

- This bot acts very close to a real person on Discord, can talk, listen, and understand you. It can also answer your questions, and help you with your tasks.
- It will always answer when you @mention it, or when you reply to it.
- It will also randomly appear in text channel.
- It can react to messages, use embed also.

# discord.js-voice + gemini-live-api (beta)

A Discord bot that uses `discord.js-voice` to join voice channels and `gemini-live-api` to stream audio from Gemini Live. This allows you to have a Gemini Live AI assistant that can talk in your Discord server.

## Detail:
- **Gemini Live Integration**: Speaks in real-time using Google's Gemini Live API
- **Voice Channel Support**: Joins voice channels and streams audio
- **Slash Commands**: Easy to use `/join` and `/leave` commands

# Setup

1. Clone the repository:

```bash
cd "D:\!Khoa\Resources\!Code\gemini bot"
```

2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file in the root directory with the following variables:

```env
# ── Required ──────────────────────────────────────────────────────
DISCORD_TOKEN=your-discord-bot-token-here
GEMINI_API_KEY=your-gemini-api-key-here

# ── Optional ──────────────────────────────────────────────────────
ADMINS=your-user-id,another-user-id

```

   Replace the placeholder values with your actual credentials:
   - `DISCORD_TOKEN`: Your Discord bot token from the [Discord Developer Portal](https://discord.com/developers/applications)
   - `GEMINI_API_KEY`: Your Google Gemini API key from the [Google AI Studio](https://aistudio.google.com/app/apikey)
   - `ADMINS`: Your Discord user ID

4. Run the bot:

```bash
npm start
```

## Development

This project uses:

- `discord.js-voice`: For voice connection management
- `gemini-live-api`: For connecting to Gemini Live
- `@google-cloud/gemini`: For the Gemini API (legacy mode)
- `node-opus`: For Opus encoding

## Troubleshooting

### "Unsupported audio format" errors
If you encounter audio format errors, make sure you have `node-opus` installed correctly:

```bash
npm install node-opus
```

On some systems, you may need to install Opus development libraries:

- Debian/Ubuntu: `sudo apt-get install libopus-dev`
- macOS: `brew install opus`

### API Rate Limits
Gemini Live has rate limits. If you hit them, you'll see error messages in the console. Consider:
- Checking your quota on [Google AI Studio](https://aistudio.google.com/app/quotas)