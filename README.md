# Find the Imposter Game Bot

A Among Us-style played entirely inside **Slack**. Players gather in a channel, get assigned roles, investigate missions via DMs, and vote to find the impostor before it's too late.

When fewer than 4 humans join, **AI-powered bot players** fill the space so the game always launches.

---

## Game Flow

```
Lobby → Mission → Discussion → Voting → Result → (next round or end)
```

| Phase | What happens |
|---|---|
| **Lobby** | Players join via `/fn-imposter` or the *Join Game* button. Creator starts when ready. |
| **Mission** | Each alive player receives a DM with a scenario. Crewmates get a secret clue; the Impostor must bluff. |
| **Discussion** | All responses are posted anonymously. Players debate who's lying. |
| **Voting** | 30-second window to vote via modal. Skip is allowed. Non-voters default to skip. |
| **Result** | Ejected player is revealed. Game ends if Impostor is caught or crewmates are wiped out. |

---

## Commands

| Command | Action |
|---|---|
| `/fn-imposter` | Create a new game or show status |
| `/fn-imposter join` | Join the lobby |
| `/fn-imposter leave` | Leave the lobby |
| `/fn-imposter start` | Start the game (creator only, auto-fills bots if < 4 humans) |
| `/fn-imposter vote @user` | Vote via text command |
| `/fn-imposter status` | Show current game state |
| `/fn-imposter cancel` | Cancel the game (creator only) |
| `/fn-imposter help` | Show help |
| `/fn-ping` | Ping / latency check |

---

## Setup

### Prerequisites

- [Bun](https://bun.sh) v1.3.13+
- A Slack app with **Socket Mode** enabled

### 1. Clone and install

```bash
git clone https://github.com/KingNish24/gameBot.git
cd gameBot
bun i
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in:

```env
SLACK_BOT_TOKEN=xoxb-...   # Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...   # App-Level Token 
# AI config for bot players fill empty slots up to 4 players
AI_BASE_URL=https://...    # OpenAI-compatible API base URL
AI_API_KEY=sk-...          # API key
AI_MODEL=gpt-5.3-mini      # Model name
```

### 3. Run

```bash
bun run index.ts
```

---

## Bot Players (AI)

When a game starts with **fewer than 4 human players**, bots are automatically added to fill to 4.

- **Mission phase**: Bots receive the same scenario via AI prompt. Crewmate bots use the secret clue; impostor bots fabricate a believable lie.
- **Voting phase**: Bots read all anonymised responses and vote for the most suspicious player.
- **Fallback**: If the AI API is unreachable, bots respond with `"(no response)"` or a random vote — the game never breaks.

---

## Timers

| Phase | Duration | Countdown |
|---|---|---|
| Mission | 60s | Live countdown in channel, deleted on expiry |
| Discussion | 45s | Live countdown in channel, deleted on expiry |
| Voting | 30s | Live countdown in channel, deleted on expiry |

---

## Tech Stack

| Layer | |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| Language | TypeScript (strict) |
| Slack SDK | `@slack/bolt` (Socket Mode) |
| AI API | OpenAI-compatible (configurable `AI_BASE_URL`) |
| Linter | [Biome](https://biomejs.dev) |
| Storage | In-memory (`Map`) |
