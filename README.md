# My-Personal-Bot

[한국어 README](README.ko.md)

A **self-hosted personal AI assistant web app** that runs on your Mac mini (or any macOS/Linux server).
It delivers a Grok-style chat experience without vendor lock-in — **connect any model you want**.

## Features

### Chat Core
- SSE streaming chat, conversation branching (edit / regenerate / sibling navigation ‹1/2›)
- Automatic conversation titles
- Grok-style dark minimal UI (sidebar + unified prompt bar)

### Multi-Model
- 200+ models when connected to an OpenAI-compatible proxy (e.g. airoute)
- Custom OpenAI-compatible endpoints (Ollama, LM Studio, any API)
- Provider → namespace → model two-level picker (search + THINK/EYE/AUTO badges)
- Per-conversation model memory

### Modes
- **Think** — collapsible reasoning panel (`reasoning_content` / `<think>` parsing)
- **DeepSearch** — query decomposition → parallel web search (Bing/SearXNG/Tavily/Brave) → source reading → [n] cited report
- **Image** — OpenAI Images-compatible / Draw Things local generation + uploaded-image vision analysis
- **Team (Boss Bot)** — see below

### Team Mode (Multi-Agent Orchestration)
- Every conversation belongs to a bot — a **CEO bot** is the default contact; switching models preserves the bot's memory and context
- **Designate any bot as CEO** in Settings — the CEO manages all bots: `agent_list` (roster), `agent_direct` (instant delegation), `agent_update` (edit role/model), `agent_delete`
- The CEO analyzes your instruction and **proposes a task plan** — you approve which bots run via checkboxes
- Role bots are auto-created/reused, then work in parallel (up to 4)
- Reuses a persistent bot only when its persona fits; otherwise creates a fresh persona
- Bots with scheduled routines are excluded automatically — the boss spawns a different bot
- Each bot shows its **actual routed model** (e.g. `openai/gpt-6-astra@high`), not the alias
- Bot tools: web search, shared workspace file I/O, MCP tools, built-in browser, routine scheduling (`routine_add`)
- Live per-bot status cards; the CEO synthesizes the final answer

### Built-in Browser (shared login sessions)
- Server-driven persistent-profile Chromium (headless)
- Open a login window once, sign in manually (e.g. x.com) → bots reuse the session
- **Site accounts**: register per-site credentials in Settings → bots auto-login via `browser_login` (company groupware mail, approval lists, etc.). Passwords stay in the local DB — never sent to the model
- Per-bot tab isolation, automation-detection signals removed

### Productivity
- Personas (default/Fun/translator/code reviewer/teacher + custom)
- Memory: facts about you auto-extracted and injected into later chats
- Workspaces: per-project instructions + conversation isolation
- Skills: custom slash commands (`/summarize`, `/translate`, ...)
- Routines: `every:30m` / `daily:HH:MM` scheduled runs → results saved as conversations (assignable to a bot)
- Voice: browser Web Speech STT (🎤) + TTS (🔊) — zero install
- Notifications: deliver answers & routine results via Telegram bot / SMTP email (chat window is the default)
- MCP (Model Context Protocol) stdio server integration
- Attachments: images (vision analysis), text files (content injection)
- Optional access code protects the entire API
- PWA manifest (Add to Home Screen)
- All data stays local in SQLite — nothing leaves your machine

## Install

### Requirements
- [Bun](https://bun.sh) 1.4+
- A model source: an OpenAI-compatible endpoint (e.g. an airoute proxy at `http://127.0.0.1:11441`)

### Setup

```bash
git clone https://github.com/TechLLM/My-Personal-Bot.git
cd My-Personal-Bot
bun install
bun --cwd web install
bunx playwright install chromium   # built-in browser (optional)
bun run build                      # build web frontend
bun start                          # http://127.0.0.1:5274
```

### Auto-start on macOS (launchd)

```bash
mkdir -p ~/Library/Logs/mybot
cat > ~/Library/LaunchAgents/ai.mybot.server.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.mybot.server</string>
  <key>ProgramArguments</key><array>
    <string>~/.bun/bin/bun</string><string>start</string>
  </array>
  <key>WorkingDirectory</key><string>/absolute/path/My-Personal-Bot</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>~/Library/Logs/mybot/stdout.log</string>
  <key>StandardErrorPath</key><string>~/Library/Logs/mybot/stderr.log</string>
</dict></plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.mybot.server.plist
```

> launchd log paths must be on the internal volume (`~/Library/Logs`).

## Usage

| Feature | How |
|---|---|
| Model selection | Model button on the left of the prompt bar → provider/group/search |
| DeepSearch | Toggle "DeepSearch" chip, ask a question |
| Team mode | Toggle "팀" chip, give an instruction → the boss delegates to bots |
| Image generation | "이미지" chip (requires `image_endpoint` in Settings) |
| Bot login | Settings → Browser → open login window → sign in manually |
| Skills | Type `/` in the input → autocomplete |
| Routines/bots/personas | ⚙ Settings at the bottom of the sidebar |

Other devices on your LAN (iPhone etc.) can reach `http://<serverIP>:5274` — set an access code in Settings first.

## Settings (⚙)

- `searxng_url` / `tavily_key` / `brave_key` — better search quality
- `image_endpoint` / `image_model` — image generation
- `mcp_servers` — MCP servers as JSON `[{"name":"fs","command":"npx","args":[...]}]`
- `access_code` — access password
- `system_prompt`, memory management, personas/workspaces/skills/routines/agents

## Tech Stack

Bun + TypeScript + Hono + SQLite (`bun:sqlite`) · React + Vite + Tailwind · Playwright (built-in browser) · SSE

## Data Locations

```
server/data/mybot.db          chats/memories/bots/routines (SQLite WAL)
server/data/files/            uploaded & generated files
server/data/workspace/        shared bot work directory
server/data/browser-profile/  browser login sessions (git-ignored)
```

## License

Copyright © 2026. All Rights Reserved.
This software is protected by copyright law. Copying, modification, or
distribution without prior written consent is prohibited.
