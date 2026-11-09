A random Discord bot created by a random person with the help of AIs (yeah)

Join my server to chat with the bot: https://discord.gg/CM6CSpCzXu

# A multi-purpose bot
Supports Discord moderation commands like: ban, kick, timeout, purge, etc...

# A bot to chat Gemini with AI

- This bot acts very close to a real person on Discord, can talk, listen, and understand you. It can also answer your questions, and help you with your tasks.
- It will always answer when you @mention it, or when you reply to it.
- It will also randomly appear in text channel.
- It can react to messages, use embed also.
- It can join voicechats and like Live mode.

# Setup

1. Clone the repository
2. Install dependencies
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
- `@google-cloud/gemini`: For the Gemini API
- `node-opus`: For Opus encoding

## Troubleshooting

### API Rate Limits
Gemini Live has rate limits. If you hit them, you'll see error messages in the console. Consider:
- Checking your quota on [Google AI Studio](https://aistudio.google.com/app/quotas)
