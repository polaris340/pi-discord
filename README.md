# pi-discord

Run [pi](https://github.com/badlogic/pi-mono) coding agent from Discord. Send a message, get streamed responses with tool use — same experience as the terminal TUI.

## Setup

### 1. Create a Discord bot

1. Go to https://discord.com/developers/applications
2. "New Application" → name your bot
3. Left sidebar "Bot" → "Reset Token" → copy token
4. Under "Privileged Gateway Intents", enable **Message Content Intent**
5. Left sidebar "OAuth2" → URL Generator
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Messages/View Channels`, `Read Message History`
6. Invite the bot to your server (or DM) using the generated URL

### 2. Configure environment

```bash
cp .env.example .env
vi .env   # set DISCORD_TOKEN and ALLOWED_USER_ID
```

To find your Discord User ID:
- Discord Settings → Advanced → Developer Mode ON
- Right-click your profile → "Copy User ID"

### 3. Authenticate pi

Run pi interactively once to log in. Credentials are persisted in `./sessions/`.

```bash
mkdir -p workspace sessions
docker compose run --rm pi-discord pi
```

### 4. Start the bot

```bash
docker compose up -d
docker compose logs -f   # check logs
```

## Usage

Send any message in a Discord channel (or DM the bot). The bot streams pi's response in real time by editing a single message.

```
You:  Build a FastAPI TODO app
Bot:  ⏳ Thinking...
      (updates in real time via message edits)
      [bash] ...
      ✅
```

### Commands

Same command names as pi's TUI `/commands`, using `!` prefix to avoid Discord slash command conflicts.

| Command | Description |
|---------|-------------|
| `!model` | Cycle to next model |
| `!model <provider> <modelId>` | Set specific model |
| `!thinking` | Cycle thinking level |
| `!thinking <level>` | Set thinking level (off/minimal/low/medium/high/xhigh) |
| `!compact` | Compact context |
| `!new` / `!reset` | Start new session |
| `!abort` | Abort current task |
| `!kill` | Kill pi process (restarts on next message) |
| `!help` | Show all commands (including dynamic pi extensions/skills) |

Any unrecognized `!xxx` is forwarded to pi as `/xxx`, so extension commands, prompt templates, and skills work automatically.

## Architecture

```
Discord message
    ↓
bot.js (discord.js)
    ↓  stdin/stdout (line-delimited JSON)
pi --mode rpc
    ↓
/workspace (Docker volume mount)
```

### Streaming

Responses are streamed by editing a single Discord message every 1.5 seconds. When content exceeds 2000 characters, it automatically continues in a follow-up message. This stays well within Discord's rate limits while feeling real-time.

### Security

- `ALLOWED_USER_ID` restricts usage to a single user
- pi runs inside a Docker container — host system is protected
- No exposed ports (Discord uses outbound connections only)
