# Discord Channel Logger Bot

Logs every message in every channel the bot can see to a **per-channel RTF file** for training purposes.
Images attached to messages are downloaded and archived into **per-channel ZIP files**.
Designed to deploy on **Railway** with zero extra infrastructure.

---

## File layout produced

```
logs/
├── image_archives/
│   ├── MyServer__general__123456789.images.zip
│   └── MyServer__support__987654321.images.zip
├── MyServer__general__123456789.rtf
└── MyServer__support__987654321.rtf
```

Each RTF file contains:
- **Username** and **UTC timestamp** for every message
- Full message text (Unicode-safe)
- **Note:** Images and attachments are excluded from the RTF files to keep them focused on training data.

Each ZIP file contains:
- All images sent in that channel, prefixed with a timestamp to ensure uniqueness.

---

## 1 — Create a Discord Application & Bot

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. In the left sidebar → **Bot** → **Add Bot**.
3. Under **Token** → **Reset Token** → copy the token. You'll need it in step 3.
4. Scroll down to **Privileged Gateway Intents** and enable:
   - **SERVER MEMBERS INTENT** *(optional but recommended)*
   - **MESSAGE CONTENT INTENT** ← **required** (without this the bot sees no message text)
5. Save changes.

### Bot permissions (OAuth2 invite URL)

Go to **OAuth2 → URL Generator**, select:
- Scopes: `bot`
- Bot Permissions: `Read Messages/View Channels`, `Read Message History`

Open the generated URL and invite the bot to your server.

---

## 2 — Deploy to Railway

### Option A — Deploy from GitHub (recommended)

1. Push this folder to a GitHub repo (the `.gitignore` keeps secrets out).
2. Go to <https://railway.app> → **New Project** → **Deploy from GitHub repo** → select your repo.
3. Railway will auto-detect Node and run `npm install && node bot.js`.

### Option B — Deploy via Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init          # inside this folder
railway up
```

---

## 3 — Set environment variables on Railway

In your Railway project → **Variables** tab, add:

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | the token you copied in step 1 |
| `LOG_DIR` | `/data` if you add a volume (see below), or leave unset to use `./logs` |

---

## 4 — Persistent storage on Railway (important!)

Railway containers are **ephemeral** — files written to the container filesystem are lost on redeploy unless you attach a **Volume**.

1. In your Railway project → **+ New** → **Volume**.
2. Set the **Mount Path** to `/data`.
3. Set `LOG_DIR=/data` in your Variables.

Your RTF files and images will now survive deploys and restarts.

---

## Local development

```bash
cp .env.example .env
# fill in DISCORD_TOKEN in .env

npm install
node bot.js
```

Logs will be written to `./logs/` by default.

---

## Customisation tips

| What | Where |
|---|---|
| Change log directory | `LOG_DIR` env var |
| Skip bot messages | already skipped — line `if (message.author.bot) return;` in `bot.js` |
| Add more image types | `IMAGE_EXTS` set near the top of `bot.js` |
| Change RTF font/size | `rtfHeader()` function in `bot.js` |
