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

- **One notification per confirmed candle**, not per run — it remembers
  the last signal it notified about per symbol (in
  `data/last-notified.json`, committed back to the repo each run
  automatically) so you won't get spammed every 15 minutes while the same
  setup is still open.
- **GitHub disables scheduled workflows after 60 days of repo
  inactivity.** If you go quiet on the repo for two months, pop into the
  Actions tab and click Enable again.
- **Timing isn't exact** — GitHub's scheduler can run a few minutes late
  under load. Fine for Daily/4H/1H/15M signals, not built for anything
  faster.
- This script mirrors the app's exact signal engine (4-tier confluence,
  Smart Money Concepts, confidence score) — if you change the strategy
  logic in the app later, this script needs the matching update to stay in
  sync, or the Telegram alerts and the dashboard could quietly drift apart.
