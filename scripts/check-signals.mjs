// Runs on GitHub Actions (Node 20, built-in fetch). Mirrors the exact
// signal engine from the web app -- same 4-tier Daily->4H->1H->15M
// confluence, same Smart Money Concepts detection, same confidence score --
// so a "confirmed" signal here means exactly what it means on the dashboard.
import fs from "node:fs";
import path from "node:path";

const SYMBOLS = [
  { key: "GOLD",   label: "Gold (XAU/USD)",   decimals: 2, yahoo: "GC=F", twelveData: "XAU/USD", finnhub: "OANDA:XAU_USD" },
  { key: "SILVER", label: "Silver (XAG/USD)", decimals: 3, yahoo: "SI=F", twelveData: "XAG/USD", finnhub: "OANDA:XAG_USD" },
];

const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY || "";
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || "";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_PATH = path.join(process.cwd(), "data", "last-notified.json");

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID secrets are not set -- see README-TELEGRAM.md.");
  process.exit(1);
}

/* ---------------- price data fetch ---------------- */

async function fetchTwelveData(symbol, interval, apiKey, outputsize = 500) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&timezone=UTC&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.status === "error" || json.code >= 400) throw new Error(json.message || `Twelve Data ${res.status}`);
  const values = json.values || [];
  return values
    .map(v => ({ time: Date.parse(v.datetime.replace(" ", "T") + "Z"), open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +(v.volume || 0) }))
    .sort((a, b) => a.time - b.time);
}

async function fetchFinnhub(finnhubSymbol, resolution, count, apiKey) {
  const url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(finnhubSymbol)}&resolution=${resolution}&count=${count}&token=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  const json = await res.json();
  if (json.s !== "ok" || !Array.isArray(json.t)) throw new Error(json.s || "Finnhub returned no data");
  return json.t.map((t, i) => ({ time: t * 1000, open: json.o[i], high: json.h[i], low: json.l[i], close: json.c[i], volume: json.v?.[i] || 0 }));
}

// No CORS proxy needed server-side -- Yahoo just needs a browser-like
// User-Agent to avoid being flagged as a bare bot request.
async function fetchYahoo(yahooSymbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("No chart data");
  const ts = result.timestamp || [];
  const q = result.indicators.quote[0];
  return ts.map((t, i) => ({ time: t * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] }))
    .filter(c => c.open != null && c.high != null && c.low != null && c.close != null);
}

function resampleToInterval(source, minutes) {
  const bucketMs = minutes * 60 * 1000;
  const buckets = new Map();
  for (const c of source) {
    const bt = Math.floor(c.time / bucketMs) * bucketMs;
    if (!buckets.has(bt)) buckets.set(bt, { time: bt, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
    else { const b = buckets.get(bt); b.high = Math.max(b.high, c.high); b.low = Math.min(b.low, c.low); b.close = c.close; b.volume += c.volume || 0; }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}
function resampleTo4h(hourly) { return resampleToInterval(hourly, 240); }
function resampleToDaily(fourHourly) { return resampleToInterval(fourHourly, 1440); }

async function getCandlesFor(sym, tf) {
  if (TWELVEDATA_API_KEY) {
    const intervalMap = { "15m": "15min", "1h": "1h", "4h": "4h" };
    try { return await fetchTwelveData(sym.twelveData, intervalMap[tf], TWELVEDATA_API_KEY, tf === "4h" ? 800 : 500); }
    catch (err) { console.warn(`Twelve Data failed for ${sym.key} ${tf}, falling back:`, err.message); }
  }
  if (FINNHUB_API_KEY) {
    try {
      const resolutionMap = { "15m": "15", "1h": "60", "4h": "60" };
      const count = tf === "4h" ? 2500 : 500;
      const raw = await fetchFinnhub(sym.finnhub, resolutionMap[tf], count, FINNHUB_API_KEY);
      return tf === "4h" ? resampleTo4h(raw) : raw;
    } catch (err) {
      console.warn(`Finnhub failed for ${sym.key} ${tf}, falling back to Yahoo:`, err.message);
    }
  }
  if (tf === "15m") return fetchYahoo(sym.yahoo, "15m", "5d");
  if (tf === "1h") return fetchYahoo(sym.yahoo, "60m", "1mo");
  const hourly = await fetchYahoo(sym.yahoo, "60m", "6mo");
  return resampleTo4h(hourly);
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    if (prev == null) { if (i >= period - 1) { const s = values.slice(i - period + 1, i + 1); prev = s.reduce((a, b) => a + b, 0) / period; out[i] = prev; } }
    else { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  }
  return out;
}
function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1], gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
    if (i <= period) { avgGain += gain / period; avgLoss += loss / period; if (i === period) out[i] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)); }
    else { avgGain = (avgGain * (period - 1) + gain) / period; avgLoss = (avgLoss * (period - 1) + loss) / period; const rs = avgLoss === 0 ? 100 : avgGain / avgLoss; out[i] = 100 - 100 / (1 + rs); }
  }
  return out;
}
function atr(candles, period = 14) {
  const trs = candles.map((c, i) => i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i-1].close), Math.abs(c.low - candles[i-1].close)));
  return ema(trs, period);
}
function findSwings(candles, lookback = 2) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const w = candles.slice(i - lookback, i + lookback + 1);
    if (w.every(c => c.high <= candles[i].high)) highs.push({ index: i, price: candles[i].high, time: candles[i].time });
    if (w.every(c => c.low >= candles[i].low)) lows.push({ index: i, price: candles[i].low, time: candles[i].time });
  }
  return { swingHighs: highs, swingLows: lows };
}
function detectPattern(candles, idx) {
  const c = candles[idx], prev = candles[idx - 1];
  if (!c || !prev) return null;
  const body = Math.abs(c.close - c.open), range = c.high - c.low || 1e-9;
  const upperWick = c.high - Math.max(c.open, c.close), lowerWick = Math.min(c.open, c.close) - c.low, prevBody = Math.abs(prev.close - prev.open);
  const bullEng = prev.close < prev.open && c.close > c.open && c.close >= prev.open && c.open <= prev.close && body > prevBody;
  const bearEng = prev.close > prev.open && c.close < c.open && c.close <= prev.open && c.open >= prev.close && body > prevBody;
  const bullPin = lowerWick > body * 2 && lowerWick > range * 0.55 && upperWick < body * 1.2;
  const bearPin = upperWick > body * 2 && upperWick > range * 0.55 && lowerWick < body * 1.2;
  if (bullEng) return { type: "bullish_engulfing", bias: "buy" };
  if (bearEng) return { type: "bearish_engulfing", bias: "sell" };
  if (bullPin) return { type: "bullish_pin_bar", bias: "buy" };
  if (bearPin) return { type: "bearish_pin_bar", bias: "sell" };
  return null;
}
function computeAll(candles) {
  const closes = candles.map(c => c.close);
  return { ema20: ema(closes, 20), ema50: ema(closes, 50), rsi14: rsi(closes, 14), atr14: atr(candles, 14), ...findSwings(candles) };
}
function efficiencyRatio(closes, i, period = 20) {
  if (i < period) return null;
  const net = Math.abs(closes[i] - closes[i - period]);
  let sumMoves = 0;
  for (let k = i - period + 1; k <= i; k++) sumMoves += Math.abs(closes[k] - closes[k - 1]);
  return sumMoves > 0 ? net / sumMoves : 0;
}

/* ---------------- Smart Money Concepts ---------------- */

// Fair Value Gap: a 3-candle imbalance left by an impulsive middle candle --
// the outer candles' ranges don't overlap, leaving a "gap" price often
// returns to fill before continuing.
function detectFVG(candles, i) {
  if (i < 2) return null;
  const c0 = candles[i - 2], c2 = candles[i];
  if (c0.high < c2.low) return { type: "bullish_fvg", top: c2.low, bottom: c0.high };
  if (c0.low > c2.high) return { type: "bearish_fvg", top: c0.low, bottom: c2.high };
  return null;
}

// Order Block: the last opposite-colored candle right before a strong
// impulsive move -- read as the footprint of institutional positioning.
function detectOrderBlock(candles, i) {
  if (i < 6) return null;
  const bodies = candles.slice(i - 5, i).map(c => Math.abs(c.close - c.open));
  const avgBody = bodies.reduce((a, b) => a + b, 0) / bodies.length;
  const impulse = candles[i];
  const impulseBody = Math.abs(impulse.close - impulse.open);
  if (impulseBody < avgBody * 1.6) return null;
  const prev = candles[i - 1];
  if (impulse.close > impulse.open && prev.close < prev.open) return { type: "bullish_ob", top: prev.high, bottom: prev.low, index: i - 1 };
  if (impulse.close < impulse.open && prev.close > prev.open) return { type: "bearish_ob", top: prev.low, bottom: prev.high, index: i - 1 };
  return null;
}

// BOS (Break of Structure) = price breaks a swing point in the direction of
// the prevailing trend -- continuation. CHOCH (Change of Character) = price
// breaks a swing point against the prevailing trend -- early reversal
// warning. Same break, different label, depending on the trend it's set against.
function detectStructureBreak(candles, i, swingHighs, swingLows, prevailingBias) {
  const priorHighs = swingHighs.filter(s => s.index < i - 1);
  const priorLows = swingLows.filter(s => s.index < i - 1);
  const lastHigh = priorHighs[priorHighs.length - 1];
  const lastLow = priorLows[priorLows.length - 1];
  const brokeUp = lastHigh && candles[i].close > lastHigh.price;
  const brokeDown = lastLow && candles[i].close < lastLow.price;
  if (brokeUp && !brokeDown) return { direction: "bullish", kind: prevailingBias === "bearish" ? "CHOCH" : "BOS", level: lastHigh.price };
  if (brokeDown && !brokeUp) return { direction: "bearish", kind: prevailingBias === "bullish" ? "CHOCH" : "BOS", level: lastLow.price };
  return null;
}

// Scans back a short window for the nearest FVG/Order Block so a signal a
// few candles after the actual imbalance still gets credited with it.
function findRecentSMC(candles, ind, i, bias, lookback = 6) {
  for (let k = i; k >= Math.max(2, i - lookback); k--) {
    const fvg = detectFVG(candles, k);
    const ob = detectOrderBlock(candles, k);
    const structure = detectStructureBreak(candles, k, ind.swingHighs, ind.swingLows, bias);
    if (fvg || ob || structure) return { fvg, orderBlock: ob, structure, atIndex: k };
  }
  return { fvg: null, orderBlock: null, structure: null, atIndex: null };
}

/* ---------------- signal engine (shared by live view + backtest) ---------------- */

function biasAt(ind, i) {
  const e20 = ind.ema20[i], e50 = ind.ema50[i], r = ind.rsi14[i];
  if (e20 == null || e50 == null || r == null) return "neutral";
  if (e20 > e50 && r > 45) return "bullish";
  if (e20 < e50 && r < 55) return "bearish";
  return "neutral";
}
// Same $0.01-per-pip convention as Exness and virtually all CFD brokers,
// for both XAU/USD and XAG/USD. MIN_PIPS/MAX_PIPS env vars mirror the
// app's Size-tab settings (localStorage has no equivalent here).
const PIP_SIZE = 0.10;
const MIN_PIPS = parseFloat(process.env.MIN_PIPS) || 100;
const MAX_PIPS = parseFloat(process.env.MAX_PIPS) || 200;

function zoneAt(candles, ind, i, direction) {
  const price = candles[i].close, e50 = ind.ema50[i], atrNow = ind.atr14[i] || price * 0.005, proximity = atrNow * 2.5;
  const levels = [];
  if (e50 != null) levels.push(e50);
  const relevant = (direction === "buy" ? ind.swingLows : ind.swingHighs).filter(s => s.index <= i - 2).slice(-8);
  relevant.forEach(s => levels.push(s.price));
  const nearLevel = levels.find(lvl => Math.abs(price - lvl) <= proximity);
  return { inZone: !!nearLevel, level: nearLevel, atrNow };
}

// SL still comes off ATR/structure. TP1/TP2/TP3 target the configured pip
// range instead of pure risk-multiples.
function computeLevels(direction, entry, atrRaw, swingLows, swingHighs, uptoIndex) {
  const atrNow = atrRaw || entry * 0.003;
  const relevantSwings = (direction === "buy" ? swingLows : swingHighs).filter(s => uptoIndex == null || s.index <= uptoIndex - 2);
  const nearestStructure = relevantSwings.length ? relevantSwings[relevantSwings.length - 1].price : null;
  let stopLoss;
  if (direction === "buy") { const s = nearestStructure != null ? nearestStructure - atrNow * 0.3 : entry - atrNow * 1.5; stopLoss = Math.min(s, entry - atrNow * 1.2); }
  else { const s = nearestStructure != null ? nearestStructure + atrNow * 0.3 : entry + atrNow * 1.5; stopLoss = Math.max(s, entry + atrNow * 1.2); }
  const risk = Math.abs(entry - stopLoss);

  const minDist = MIN_PIPS * PIP_SIZE, midDist = ((MIN_PIPS + MAX_PIPS) / 2) * PIP_SIZE, maxDist = MAX_PIPS * PIP_SIZE;
  const tp1 = direction === "buy" ? entry + minDist : entry - minDist;
  const tp2 = direction === "buy" ? entry + midDist : entry - midDist;
  const tp3 = direction === "buy" ? entry + maxDist : entry - maxDist;

  const atrUnits = atrNow > 0 ? minDist / atrNow : null;
  const estBars15m = atrUnits != null ? Math.round(atrUnits * atrUnits) : null;
  const feasibility = estBars15m == null ? null : estBars15m <= 8 ? "typical" : estBars15m <= 30 ? "stretch" : "ambitious";

  return { stopLoss, tp1, tp2, tp3, risk, rrTp1: risk > 0 ? minDist / risk : null, rrTp2: risk > 0 ? midDist / risk : null, rrTp3: risk > 0 ? maxDist / risk : null, feasibility, estBars15m };
}
function biasOnly(candles) {
  if (!candles || candles.length < 10) return "neutral";
  const closes = candles.map(c => c.close);
  const ind = { ema20: ema(closes, 20), ema50: ema(closes, 50), rsi14: rsi(closes, 14) };
  return biasAt(ind, candles.length - 2);
}
function buildTrendTable(m1, m15, h1, h4) {
  return [
    { label: "1 min", bias: biasOnly(m1) },
    { label: "3 min", bias: biasOnly(resampleToInterval(m1, 3)) },
    { label: "5 min", bias: biasOnly(resampleToInterval(m1, 5)) },
    { label: "15 min", bias: biasOnly(m15) },
    { label: "30 min", bias: biasOnly(resampleToInterval(m15, 30)) },
    { label: "1H", bias: biasOnly(h1) },
    { label: "2H", bias: biasOnly(resampleToInterval(h1, 120)) },
    { label: "4H", bias: biasOnly(h4) },
    { label: "8H", bias: biasOnly(resampleToInterval(h4, 480)) },
    { label: "Daily", bias: biasOnly(resampleToInterval(h4, 1440)) },
  ];
}

function analyzeTimeframe(candles) {
  if (!candles || candles.length < 60) return { bias: "neutral", zone: null, pattern: null, atrNow: null, lastClose: null, smc: null };
  const ind = computeAll(candles), i = candles.length - 2, bias = biasAt(ind, i), pattern = detectPattern(candles, i);
  const want = bias === "bullish" ? "buy" : bias === "bearish" ? "sell" : null;
  let zone = null;
  if (want) { const z = zoneAt(candles, ind, i, want); if (z.inZone) zone = { direction: want, level: z.level, atrNow: z.atrNow }; }
  const er = efficiencyRatio(candles.map(c => c.close), i, 20);
  const smc = findRecentSMC(candles, ind, i, bias);
  return { bias, zone, pattern, atrNow: ind.atr14[i], lastClose: candles[i].close, swingHighs: ind.swingHighs, swingLows: ind.swingLows, candleTime: candles[i].time, ema20: ind.ema20[i], ema50: ind.ema50[i], rsi14: ind.rsi14[i], efficiencyRatio: er, smc };
}

// Does the detected SMC context at this timeframe support the given trade direction?
function smcSupports(smc, direction) {
  if (!smc) return false;
  if (smc.fvg && ((direction === "buy" && smc.fvg.type === "bullish_fvg") || (direction === "sell" && smc.fvg.type === "bearish_fvg"))) return true;
  if (smc.orderBlock && ((direction === "buy" && smc.orderBlock.type === "bullish_ob") || (direction === "sell" && smc.orderBlock.type === "bearish_ob"))) return true;
  if (smc.structure && ((direction === "buy" && smc.structure.direction === "bullish") || (direction === "sell" && smc.structure.direction === "bearish"))) return true;
  return false;
}

// Two-tier confluence, matching the app exactly: 1H sets the bias and must
// be in a zone, 15M supplies the trigger (candle pattern or SMC structure
// break). Daily/4H are no longer required to fire a signal.
function buildSignal(tfReads) {
  const h1 = tfReads["1h"], m15 = tfReads["15m"];
  if (!h1.bias || h1.bias === "neutral") return { status: "watching", reason: "1H has no clear trend right now — no bias to trade either direction" };
  const direction = h1.bias === "bullish" ? "buy" : "sell";
  const wantSmcDir = direction === "buy" ? "bullish" : "bearish";

  const inZone = h1.zone && h1.zone.direction === direction;
  const zoneLevel = inZone ? h1.zone.level : null;

  const patternConfirms = m15.pattern && m15.pattern.bias === direction;
  const structureConfirms = m15.smc?.structure && m15.smc.structure.direction === wantSmcDir;
  const m15Confirms = inZone && (patternConfirms || structureConfirms);

  const entryNow = m15.lastClose;
  const preview = (entryNow != null) ? computeLevels(direction, entryNow, m15.atrNow, m15.swingLows, m15.swingHighs) : null;

  if (!inZone || !m15Confirms) {
    const reason = !inZone ? "1H trend set, but price isn't at a zone yet"
      : "In a zone — waiting for a 15m candle or structure break to confirm";
    return { status: "watching", direction, preview, reason, tf: { "1h": h1.bias, "15m": m15.pattern?.type || "none" } };
  }

  const confirmed = computeLevels(direction, entryNow, m15.atrNow, m15.swingLows, m15.swingHighs);
  const triggerLabel = patternConfirms ? m15.pattern.type : `${m15.smc.structure.kind.toLowerCase()}_${m15.smc.structure.direction}`;
  return { status: "signal", direction, entry: entryNow, ...confirmed, riskRewardTp1: confirmed.rrTp1, riskRewardTp2: confirmed.rrTp2, riskRewardTp3: confirmed.rrTp3, pattern: triggerLabel, zoneLevel, tf: { "1h": h1.bias, "15m": triggerLabel }, candleTime: m15.candleTime, smc: m15.smc };
}

// Weighted 0-100 confidence score. Simplified vs. the app's version: this
// script doesn't fetch Daily/4H at all (to keep API credit usage sane on a
// 5-minute schedule, now that Daily/4H aren't required for the signal to
// fire either), so the timeframe-alignment component just confirms 1H
// itself is non-neutral rather than checking 3 timeframes.
function computeConfidence(tfReads, direction, newsSoon) {
  if (!direction) return null;
  const h1 = tfReads["1h"], m15 = tfReads["15m"];
  const checks = [];
  let score = 0;

  const h1Confirmed = h1.bias !== "neutral";
  const trendPts = h1Confirmed ? 35 : 0;
  score += trendPts;
  checks.push({ label: "1H trend confirmed (Daily/4H not fetched here)", pass: h1Confirmed, points: trendPts });

  const rsi15 = m15.rsi14;
  let momentumPts = 0;
  if (rsi15 != null) {
    const sweetSpot = direction === "buy" ? (rsi15 >= 45 && rsi15 <= 68) : (rsi15 <= 55 && rsi15 >= 32);
    momentumPts = sweetSpot ? 20 : 8;
  }
  score += momentumPts;
  checks.push({ label: "RSI in a healthy range (not overextended)", pass: momentumPts >= 20, points: momentumPts });

  const inZone = !!(h1.zone && h1.zone.direction === direction);
  const zonePts = inZone ? 15 : 4;
  score += zonePts;
  checks.push({ label: "Price at a support/resistance zone", pass: inZone, points: zonePts });

  const smcAligned = smcSupports(m15.smc, direction) || smcSupports(h1.smc, direction);
  const smcPts = smcAligned ? 15 : 5;
  score += smcPts;
  checks.push({ label: "Smart Money confluence (FVG / Order Block / BOS)", pass: smcAligned, points: smcPts });

  const er = h1.efficiencyRatio;
  let erPts = 0;
  if (er != null) erPts = Math.max(0, Math.min(15, er * 15 / 0.5));
  score += erPts;
  checks.push({ label: "1H trend is clean, not choppy", pass: er != null && er >= 0.3, points: Math.round(erPts) });

  let newsPenalty = 0;
  if (newsSoon) { newsPenalty = 15; score -= newsPenalty; }
  checks.push({ label: "No major news event imminent", pass: !newsSoon, points: newsSoon ? -newsPenalty : 0 });

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, checks };
}

function dxyConfluence(goldDirection, dxyH4Bias, dxyH1Bias) {
  if (!goldDirection || dxyH4Bias === "neutral") return null;
  const wantsDXY = goldDirection === "buy" ? "bearish" : "bullish";
  const agrees = dxyH4Bias === wantsDXY;
  return { agrees, dxyH4Bias, dxyH1Bias };
}


/* ---------------- economic calendar (confidence penalty only, non-critical) ---------------- */

async function isHighImpactNewsSoon() {
  try {
    const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json");
    if (!res.ok) return false;
    const events = await res.json();
    const now = Date.now();
    return events.some(e => {
      const ts = Date.parse(e.date);
      return e.impact === "High" && e.country === "USD" && ts - now < 2 * 60 * 60 * 1000 && ts - now > -30 * 60 * 1000;
    });
  } catch {
    return false; // non-critical -- just skip the news penalty if the calendar is unreachable
  }
}

/* ---------------- state + Telegram ---------------- */

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
  });
  if (!res.ok) throw new Error(`Telegram API returned ${res.status}: ${await res.text()}`);
}

const fmt = (n, decimals) => Number(n).toFixed(decimals);

function formatMessage(sym, signal, confidence) {
  const emoji = signal.direction === "buy" ? "🟢" : "🔴";
  const smcText = signal.smc
    ? [signal.smc.fvg?.type, signal.smc.orderBlock?.type, signal.smc.structure && `${signal.smc.structure.kind} (${signal.smc.structure.direction})`]
        .filter(Boolean).map(s => s.replace(/_/g, " ")).join(", ")
    : null;
  const rr = n => n == null ? "—" : n.toFixed(1);
  const feasText = signal.feasibility === "typical" ? "reachable within a normal candle or two"
    : signal.feasibility === "stretch" ? "a bit of a stretch given current volatility"
    : signal.feasibility === "ambitious" ? "ambitious right now -- volatility is low relative to this target"
    : null;
  const lines = [
    `${emoji} <b>${signal.direction.toUpperCase()} ${sym.label}</b>`,
    ``,
    `Entry: ${fmt(signal.entry, sym.decimals)}`,
    `SL: ${fmt(signal.stopLoss, sym.decimals)}`,
    `TP1 (${MIN_PIPS}p): ${fmt(signal.tp1, sym.decimals)} (1:${rr(signal.riskRewardTp1)})`,
    `TP2 (mid): ${fmt(signal.tp2, sym.decimals)} (1:${rr(signal.riskRewardTp2)})`,
    `TP3 (${MAX_PIPS}p): ${fmt(signal.tp3, sym.decimals)} (1:${rr(signal.riskRewardTp3)})`,
    `15m trigger: ${signal.pattern.replace(/_/g, " ")}`,
  ];
  if (feasText) lines.push(`TP1 feasibility: ${feasText}`);
  if (smcText) lines.push(`Smart Money: ${smcText}`);
  if (confidence) lines.push(``, `Confidence: ${confidence.score}%`);
  return lines.join("\n");
}

/* ---------------- main ---------------- */

async function checkSymbol(sym, newsSoon, state) {
  const [c15, c1h] = await Promise.all([getCandlesFor(sym, "15m"), getCandlesFor(sym, "1h")]);
  const tfReads = { "15m": analyzeTimeframe(c15), "1h": analyzeTimeframe(c1h) };
  const lastPrice = c15[c15.length - 1]?.close ?? null;

  // If a trade is already open for this symbol, check whether price has hit
  // SL or TP1 -- only once it resolves does the next signal get a chance.
  const openTrade = state[sym.key]?.open;
  if (openTrade && lastPrice != null) {
    const hitSL = openTrade.direction === "buy" ? lastPrice <= openTrade.stopLoss : lastPrice >= openTrade.stopLoss;
    const hitTP1 = openTrade.direction === "buy" ? lastPrice >= openTrade.tp1 : lastPrice <= openTrade.tp1;
    if (hitSL || hitTP1) {
      const outcome = hitTP1 ? "WIN (TP1 hit)" : "LOSS (SL hit)";
      console.log(`${sym.key}: open trade resolved -- ${outcome}`);
      await sendTelegram(`${hitTP1 ? "✅" : "❌"} <b>${sym.label} trade closed: ${outcome}</b>\nNext signal for ${sym.label} can now fire.`);
      delete state[sym.key].open;
      return true;
    }
    console.log(`${sym.key}: still in an open ${openTrade.direction} trade, waiting for SL/TP1 before checking for a new signal.`);
    return false;
  }

  const signal = buildSignal(tfReads);
  const confidence = computeConfidence(tfReads, signal.direction, newsSoon);

  console.log(`${sym.key}: 1h=${tfReads["1h"].bias} 15m=${tfReads["15m"].pattern?.type || "none"} -> ${signal.status}${confidence ? ` (${confidence.score}%)` : ""}`);

  if (signal.status !== "signal") return false;

  const signature = `${sym.key}:${signal.direction}:${signal.candleTime}`;
  if (state[sym.key]?.lastSignature === signature) {
    console.log(`${sym.key}: already notified for this candle, skipping.`);
    return false;
  }

  await sendTelegram(formatMessage(sym, signal, confidence));
  console.log(`${sym.key}: notification sent.`);
  state[sym.key] = {
    lastSignature: signature,
    open: { direction: signal.direction, entry: signal.entry, stopLoss: signal.stopLoss, tp1: signal.tp1, candleTime: signal.candleTime },
  };
  return true;
}

async function main() {
  const newsSoon = await isHighImpactNewsSoon();
  const state = loadState();
  let changed = false;
  for (const sym of SYMBOLS) {
    try {
      const didNotify = await checkSymbol(sym, newsSoon, state);
      if (didNotify) changed = true;
    } catch (err) {
      console.error(`${sym.key} check failed:`, err.message);
    }
  }
  if (changed) saveState(state);
}

main().catch(err => { console.error(err); process.exit(1); });
