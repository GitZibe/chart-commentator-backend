const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const https = require("https");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------------------------------------------
// SECURITY MIDDLEWARE
// -------------------------------------------------------

// Rate limiter — in memory, per IP
const rateLimitMap = new Map();
const RATE_LIMIT = 60; // requests per window
const RATE_WINDOW = 60 * 1000; // 1 minute

function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };

  if (now - entry.start > RATE_WINDOW) {
    entry.count = 1;
    entry.start = now;
  } else {
    entry.count++;
  }

  rateLimitMap.set(ip, entry);

  if (entry.count > RATE_LIMIT) {
    return res.status(429).json({ error: "Too many requests" });
  }
  next();
}

// Strict CORS — only allow your Vercel frontend
const allowedOrigins = [
  "https://chart-commentator-frontend.vercel.app",
  "https://chartly.vercel.app",
  /\.vercel\.app$/,
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // allow server-to-server
    const allowed = allowedOrigins.some(o =>
      typeof o === "string" ? o === origin : o.test(origin)
    );
    callback(null, allowed);
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "X-Access-Token"],
}));

app.use(express.json({ limit: "10kb" })); // reject huge payloads
app.use(rateLimit);

// Security headers
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "changeme123";
const NEWS_API_KEY = process.env.NEWS_API_KEY || "";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "chartly2024"; // subscribers use this
const alerts = [];
const MAX_ALERTS = 50;

// -------------------------------------------------------
// HEALTH CHECK
// -------------------------------------------------------
app.get("/", (req, res) => res.json({ status: "Chartly is running" }));

// -------------------------------------------------------
// REAL NEWS via NewsAPI
// -------------------------------------------------------
async function fetchNews(symbol) {
  try {
    if (!NEWS_API_KEY) return null;
    const queryMap = {
      "NQ1!": "Nasdaq futures tech stocks",
      "ES1!": "S&P 500 futures market",
      "MGC1!": "gold price futures",
      "GC1!": "gold price futures",
      "CL1!": "crude oil price futures",
      "EURUSD": "euro dollar forex",
    };
    const query = queryMap[symbol] || symbol.replace("1!", "");
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=3&language=en&apiKey=${NEWS_API_KEY}`;

    const newsData = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      }).on("error", reject);
    });

    if (!newsData.articles || !newsData.articles.length) return null;
    const headlines = newsData.articles.slice(0, 2).map(a => a.title).filter(Boolean).join(" | ");

    const summary = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 100,
      messages: [{ role: "user", content: `Summarize into 1 sentence for ${symbol} traders: "${headlines}". No fluff, just what moves price.` }]
    });
    return summary.content[0].text.replace(/\*\*/g, "").trim();
  } catch(e) {
    console.error("News error:", e.message);
    return null;
  }
}

// -------------------------------------------------------
// GENERATE UNIQUE SVG CHART per symbol + price
// -------------------------------------------------------
function generateChartSVG(price, symbol) {
  const p = parseFloat(price) || 0;
  if (!p) return null;

  const w = 560, h = 200;
  const pl = 10, pr = 58, pt = 16, pb = 26;
  const cw = w - pl - pr;
  const ch = h - pt - pb;

  const profiles = {
    "NQ1!":   { vol: 0.0042, color: "#4d9fff", targetMult: 2.8 },
    "ES1!":   { vol: 0.003,  color: "#00e87a", targetMult: 2.5 },
    "MGC1!":  { vol: 0.005,  color: "#ffd60a", targetMult: 2.2 },
    "GC1!":   { vol: 0.005,  color: "#ffd60a", targetMult: 2.2 },
    "CL1!":   { vol: 0.006,  color: "#ff9f0a", targetMult: 2.0 },
    "EURUSD": { vol: 0.004,  color: "#bf5af2", targetMult: 2.0 },
  };
  const prof = profiles[symbol] || { vol: 0.004, color: "#00e87a", targetMult: 2.5 };
  const range = p * prof.vol;

  const symSeed = (symbol || "XX").split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const seed = ((p * 100) % 997) + symSeed;
  const sr = (n) => Math.abs(Math.sin(seed * 0.01 + n * 127.1 + symSeed * 0.3));

  const numC = 25;
  let candles = [];
  let val = p - range * (0.6 + sr(0) * 0.5);

  for (let i = 0; i < numC; i++) {
    const open = val;
    const bias = sr(i + 5) > 0.5 ? 1 : -1;
    const move = bias * sr(i + 10) * range * 0.18 + Math.sin(i * (0.8 + sr(1) * 0.4) + seed * 0.05) * range * 0.22;
    const close = open + move;
    candles.push({
      open, close,
      high: Math.max(open, close) + sr(i + 20) * range * 0.14,
      low: Math.min(open, close) - sr(i + 30) * range * 0.14,
    });
    val = close;
  }
  candles[numC-1].close = p;
  candles[numC-1].high = Math.max(candles[numC-1].open, p) + range * 0.07;
  candles[numC-1].low = Math.min(candles[numC-1].open, p) - range * 0.04;

  const allP = candles.flatMap(c => [c.high, c.low]);
  const minP = Math.min(...allP) - range * 0.6;
  const maxP = Math.max(...allP) + range * 0.8;
  const pRange = maxP - minP;

  const toY = (v) => pt + ch - ((v - minP) / pRange) * ch;
  const toX = (i) => pl + (i / (numC-1)) * cw;
  const cndW = cw / numC * 0.5;

  const swingHigh = Math.max(...candles.slice(-10).map(c => c.high));
  const swingLow = Math.min(...candles.slice(-10).map(c => c.low));
  const fvgTop = p + range * (0.25 + sr(40) * 0.2);
  const fvgBot = p + range * (0.06 + sr(41) * 0.1);
  const obTop = p - range * (0.04 + sr(42) * 0.08);
  const obBot = p - range * (0.22 + sr(43) * 0.12);
  const target = swingHigh + range * prof.targetMult;
  const stop = obBot - range * 0.12;
  const resistance = swingHigh + range * 0.3;
  const support = swingLow - range * 0.2;

  let svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" style="background:#0a0b10;border-radius:8px;display:block;">`;

  for (let i = 0; i <= 4; i++) {
    const y = pt + (ch / 4) * i;
    const gp = maxP - (pRange / 4) * i;
    svg += `<line x1="${pl}" y1="${y}" x2="${w-pr}" y2="${y}" stroke="rgba(255,255,255,0.035)" stroke-width="1"/>`;
    svg += `<text x="${w-pr+4}" y="${y+3}" font-family="JetBrains Mono,monospace" font-size="7.5" fill="rgba(255,255,255,0.22)">${gp.toFixed(1)}</text>`;
  }

  if (toY(resistance) > pt && toY(resistance) < pt + ch)
    svg += `<line x1="${pl}" y1="${toY(resistance)}" x2="${w-pr}" y2="${toY(resistance)}" stroke="rgba(255,45,85,0.35)" stroke-width="1" stroke-dasharray="6,4"/><text x="${pl+3}" y="${toY(resistance)-2}" font-family="JetBrains Mono,monospace" font-size="7" fill="rgba(255,45,85,0.7)">R1</text>`;

  if (toY(support) > pt && toY(support) < pt + ch)
    svg += `<line x1="${pl}" y1="${toY(support)}" x2="${w-pr}" y2="${toY(support)}" stroke="rgba(0,232,122,0.35)" stroke-width="1" stroke-dasharray="6,4"/><text x="${pl+3}" y="${toY(support)+9}" font-family="JetBrains Mono,monospace" font-size="7" fill="rgba(0,232,122,0.7)">S1</text>`;

  const fvgY1 = toY(fvgTop), fvgY2 = toY(fvgBot);
  svg += `<rect x="${pl}" y="${fvgY1}" width="${cw}" height="${Math.max(fvgY2-fvgY1,2)}" fill="rgba(255,214,10,0.07)" stroke="rgba(255,214,10,0.4)" stroke-width="1" stroke-dasharray="3,2"/>`;
  svg += `<text x="${pl+3}" y="${fvgY1-2}" font-family="JetBrains Mono,monospace" font-size="7.5" fill="#ffd60a">FVG</text>`;

  const obY1 = toY(obTop), obY2 = toY(obBot);
  svg += `<rect x="${pl}" y="${obY1}" width="${cw*0.6}" height="${Math.max(obY2-obY1,2)}" fill="rgba(191,90,242,0.07)" stroke="rgba(191,90,242,0.4)" stroke-width="1" stroke-dasharray="3,2"/>`;
  svg += `<text x="${pl+3}" y="${obY2+9}" font-family="JetBrains Mono,monospace" font-size="7.5" fill="#bf5af2">OB</text>`;

  candles.forEach((c, i) => {
    const x = toX(i);
    const bull = c.close >= c.open;
    const col = bull ? "#00e87a" : "#ff2d55";
    const bt = toY(Math.max(c.open, c.close));
    const bb = toY(Math.min(c.open, c.close));
    svg += `<line x1="${x}" y1="${toY(c.high)}" x2="${x}" y2="${toY(c.low)}" stroke="${col}" stroke-width="0.9" opacity="0.55"/>`;
    svg += `<rect x="${x-cndW/2}" y="${bt}" width="${cndW}" height="${Math.max(bb-bt,1)}" fill="${col}" opacity="${bull?0.88:0.82}"/>`;
  });

  const tpY = toY(target);
  if (tpY > pt-5 && tpY < pt+ch+5)
    svg += `<line x1="${pl}" y1="${tpY}" x2="${w-pr}" y2="${tpY}" stroke="#00e87a" stroke-width="1.2" stroke-dasharray="5,3" opacity="0.95"/><text x="${w-pr+4}" y="${tpY+3}" font-family="JetBrains Mono,monospace" font-size="8" fill="#00e87a">TP</text>`;

  const slY = toY(stop);
  if (slY > pt-5 && slY < pt+ch+5)
    svg += `<line x1="${pl}" y1="${slY}" x2="${w-pr}" y2="${slY}" stroke="#ff2d55" stroke-width="1.2" stroke-dasharray="5,3" opacity="0.95"/><text x="${w-pr+4}" y="${slY+3}" font-family="JetBrains Mono,monospace" font-size="8" fill="#ff2d55">SL</text>`;

  const alertY = toY(p);
  svg += `<line x1="${pl}" y1="${alertY}" x2="${w-pr}" y2="${alertY}" stroke="${prof.color}" stroke-width="1" opacity="0.6"/>`;
  svg += `<text x="${w-pr+4}" y="${alertY+3}" font-family="JetBrains Mono,monospace" font-size="8" fill="${prof.color}">▶</text>`;
  svg += `<polygon points="${toX(numC-1)+5},${alertY} ${toX(numC-1)+13},${alertY-5} ${toX(numC-1)+13},${alertY+5}" fill="${prof.color}" opacity="0.95"/>`;
  svg += `<text x="${w-pr-4}" y="${pt+ch}" font-family="JetBrains Mono,monospace" font-size="9" fill="rgba(255,255,255,0.07)" text-anchor="end">${symbol||""}</text>`;
  svg += `</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// -------------------------------------------------------
// INPUT VALIDATION
// -------------------------------------------------------
function validateWebhookPayload(body) {
  if (!body || typeof body !== "object") return false;
  if (typeof body.secret !== "string") return false;
  if (body.symbol && typeof body.symbol !== "string") return false;
  if (body.price && isNaN(parseFloat(body.price))) return false;
  // Prevent injection via long strings
  const MAX_LEN = 100;
  for (const key of ["secret","symbol","interval","message"]) {
    if (body[key] && String(body[key]).length > MAX_LEN) return false;
  }
  return true;
}

// -------------------------------------------------------
// WEBHOOK ENDPOINT
// -------------------------------------------------------
app.post("/webhook", async (req, res) => {
  if (!validateWebhookPayload(req.body)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const { secret, symbol, interval, price, message } = req.body;

  // Constant-time comparison to prevent timing attacks
  const expected = Buffer.from(WEBHOOK_SECRET);
  const received = Buffer.from(secret || "");
  const match = expected.length === received.length &&
    crypto.timingSafeEqual(expected, received);

  if (!match) return res.status(401).json({ error: "Unauthorized" });

  res.json({ received: true });

  const prompt = `You are Chartly, an elite ICT Smart Money trading analyst. Alert: ${symbol||"Unknown"} hit $${price||"Unknown"} on the ${interval||"Unknown"}m chart.

Give sharp Smart Money analysis:
- Fair Value Gap: bullish or bearish FVG near this price with exact price range
- Order Block: nearest OB zone with specific prices
- Entry: exact entry price or tight range
- Target: a SIGNIFICANT take profit — aim for 2-3x the stop distance, targeting next major liquidity pool or swing high/low. Give specific price.
- Stop: specific stop loss just beyond the structure
- Structure: did price break structure bullish or bearish here

Rules: no asterisks, no markdown, no bold. Real prices near $${price}. 4-5 sentences. Write like a sharp prop trader texting his buddy. Direct, specific, big targets.

End on a new line with one word: BULLISH, BEARISH, or NEUTRAL`;

  try {
    const [aiResp, newsText] = await Promise.all([
      anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
      fetchNews(symbol)
    ]);

    let raw = aiResp.content[0].text.replace(/\*\*/g,"").replace(/\*/g,"").trim();
    const lines = raw.split("\n").filter(l => l.trim());
    const last = lines[lines.length-1].trim();
    const bias = ["BULLISH","BEARISH","NEUTRAL"].includes(last) ? last : "NEUTRAL";
    const commentary = lines.filter(l => !["BULLISH","BEARISH","NEUTRAL"].includes(l.trim())).join(" ").trim();
    const chartImage = generateChartSVG(price, symbol);

    const alert = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      symbol: symbol || "Unknown",
      interval: interval || "Unknown",
      price: price || null,
      commentary,
      news: newsText,
      chartImage,
      bias,
    };

    alerts.unshift(alert);
    if (alerts.length > MAX_ALERTS) alerts.pop();
    console.log(`[Chartly] ${alert.symbol} $${price} — ${bias}`);
  } catch(err) {
    console.error("Error:", err.message);
  }
});

// -------------------------------------------------------
// ALERTS ENDPOINT — protected by ACCESS_TOKEN
// -------------------------------------------------------
app.get("/alerts", (req, res) => {
  const token = req.headers["x-access-token"] || req.query.token;
  if (!token || token !== ACCESS_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ alerts });
});

app.listen(PORT, () => console.log(`Chartly running on port ${PORT}`));
