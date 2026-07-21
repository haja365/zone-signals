# Real notifications, even with your phone locked and the app closed

This runs a scheduled check on GitHub's own servers — completely independent
of your phone or browser — and messages you on Telegram the moment a
confirmed Gold or Silver signal fires. This is the only way to actually get
notified while your phone is locked; the web app itself cannot do this on
its own, no matter how it's built (browsers stop running JavaScript the
moment you lock the phone or close the tab).

## 1. Create a Telegram bot (2 minutes)

1. Open Telegram (app or web), search for **@BotFather**, start a chat
2. Send `/newbot`, give it any name and a unique username ending in `bot`
   (e.g. `zonesignals_yourname_bot`)
3. BotFather replies with a **token** that looks like
   `123456789:AAExampleTokenTextHere` — copy it, this is `TELEGRAM_BOT_TOKEN`

## 2. Get your chat ID

1. Search for your new bot by its username, open a chat with it, send it
   any message (e.g. "hi")
2. In a browser, visit:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   (replace `<YOUR_TOKEN>` with the token from step 1)
3. You'll see JSON containing `"chat":{"id":123456789,...}` — that number is
   your `TELEGRAM_CHAT_ID`

## 3. Add these files to your existing repo

Keep the folder structure when uploading:

```
.github/workflows/signal-check.yml
scripts/check-signals.mjs
data/last-notified.json
```

Via the GitHub web UI: **Add file → Upload files**, drag these in — GitHub
preserves the folder paths automatically.

## 4. Add secrets

In your repo: **Settings → Secrets and variables → Actions → New
repository secret**. Add:

- `TELEGRAM_BOT_TOKEN` — from step 1
- `TELEGRAM_CHAT_ID` — from step 2

If you're using Twelve Data and/or Finnhub keys for more reliable data
(recommended, same as the web app), also add:

- `TWELVEDATA_API_KEY`
- `FINNHUB_API_KEY`

Optional — override the default 100/200 pip TP targets (same setting as the
app's Size tab, kept in sync manually since GitHub Actions has no
localStorage equivalent):

- `MIN_PIPS` (default 100)
- `MAX_PIPS` (default 200)

(Without either, it falls back to Yahoo automatically, same as the app.)

## 5. Turn it on

- **Actions** tab → "Gold & Silver signal check" → **Enable workflow** if
  prompted
- Click **Run workflow** to test it manually right away
- Open the run, check the log — you'll see a line per symbol like
  `GOLD: daily=bullish 4h=bullish 1h=neutral 15m=none -> watching`. That's
  normal most of the time; it only messages you when all four timeframes
  actually align and confirm.

From here it runs automatically every ~15 minutes, and you'll get a
Telegram message the moment a real signal fires — phone locked or not.

## What the message looks like

```
🟢 BUY Gold (XAU/USD)

Entry: 4010.50
SL: 4002.10
TP1: 4022.70 (1:1.5)
TP2: 4035.30 (1:3)
TP3: 4047.90 (1:4.5)
15m trigger: bullish engulfing
Smart Money: bullish fvg, BOS (bullish)

Confidence: 82%
```

## Things worth knowing

- **Runs every 5 minutes** — GitHub's documented minimum for scheduled
  workflows (2 minutes was requested but isn't actually achievable there;
  the web app itself does refresh every 2 minutes, since a browser timer
  has no such restriction).
- **Only one open trade per symbol at a time.** Once a signal fires for
  Gold or Silver, this script won't check for (or notify about) a new one
  for that same symbol until the open trade hits its stop loss or TP1 —
  you'll get a separate "✅ trade closed: WIN" or "❌ trade closed: LOSS"
  message the moment that happens, and the next signal can fire from
  there.
- **GitHub disables scheduled workflows after 60 days of repo
  inactivity.** If you go quiet on the repo for two months, pop into the
  Actions tab and click Enable again.
- **Timing isn't exact** — GitHub's scheduler can run a few minutes late
  under load.
- **Pip size is $0.10 here** (matches the app's Size-tab convention) — 100
  pips = $10, 200 pips = $20 by default. Daily/4H are no longer required
  for a signal (1H + 15M only), so this script only fetches those two
  timeframes to keep API usage down, given the faster schedule.
- This script mirrors the app's exact signal engine (1H+15M confluence,
  Smart Money Concepts) — if you change the strategy logic in the app
  later, this script needs the matching update to stay in
  sync, or the Telegram alerts and the dashboard could quietly drift apart.
