const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "changeme123";
const alerts = [];
const MAX_ALERTS = 50;

app.get("/", (req, res) => {
  res.json({ status: "Chartly is running" });
});

// -------------------------------------------------------
// FETCH REAL NEWS via NewsAPI
// -------------------------------------------------------
async function fetchNews(symbol) {
  try {
    const NEWS_API_KEY = process.env.NEWS_API_KEY || "3af3dd65947c4a6e8e7d6ddbfc79ed6a";

    const queryMap = {
      "NQ1!": "Nasdaq futures OR tech stocks",
      "ES1!": "S&P 500 futures OR stock market",
      "MGC1!": "gold price OR gold futures",
      "GC1!": "gold price OR gold futures",
      "CL1!": "crude oil price OR oil futures",
      "EURUSD": "euro dollar forex",
    };
    const query = queryMap[symbol] || symbol.replace("1!", "");

    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=3&language=en&apiKey=${NEWS_API_KEY}`;

    const newsData = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }).on("error", reject);
    });

    if (!newsData.articles || newsData.articles.length === 0) return null;

    // Take top 2 headlines
    const headlines = newsData.articles
      .slice(0, 2)
      .map(a => a.title)
      .filter(Boolean)
      .join(" | ");

    // Use Claude to summarize into 1 clean sentence
    const summary = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: `Summarize these news headlines into 1 sentence of what matters for ${symbol} traders right now. Be direct, no fluff: "${headlines}"`
      }]
    });

    return summary.content[0].text.replace(/\*\*/g, "").trim();
  } catch (e) {
    console.error("News fetch error:", e.message);
    return null;
  }
}

// -------------------------------------------------------
// GENERATE SVG CHART
// -------------------------------------------------------
function generateChartSVG(price) {
  const p = parseFloat(price) || 0;
  if (!p) return null;

  const w = 560, h = 180;
  const pl = 8, pr = 52, pt = 12, pb = 20;
  const cw = w - pl - pr;
  const ch = h - pt - pb;
  const range = p * 0.004;
  const numC = 22;

  let candles = [];
  let val = p * 0.9975;
  for (let i = 0; i < numC; i++) {
    const open = val;
    const chg = (Math.sin(i * 1.3 + 0.5) * 0.45 + Math.cos(i * 0.9) * 0.3) * range * 0.5;
    const close = open + chg;
    const high = Math.max(open, close) + Math.abs(Math.sin(i * 2.3)) * range * 0.18;
    const low = Math.min(open, close) - Math.abs(Math.cos(i * 1.9)) * range * 0.18;
    candles.push({ open, high, low, close });
    val = close;
  }
  candles[numC - 1].close = p;
  candles[numC - 1].high = Math.max(candles[numC - 1].open, p) + range * 0.08;

  const allP = candles.flatMap(c => [c.high, c.low]);
  const minP = Math.min(...allP) - range * 0.4;
  const maxP = Math.max(...allP) + range * 0.5;
  const pr2 = maxP - minP;

  const toY = (v) => pt + ch - ((v - minP) / pr2) * ch;
  const toX = (i) => pl + (i / (numC - 1)) * cw;
  const cndW = cw / numC * 0.55;

  const fvgTop = p + range * 0.38;
  const fvgBot = p + range * 0.12;
  const obTop = p - range * 0.08;
  const obBot = p - range * 0.32;
  const target = p + range * 0.72;
  const stop = p - range * 0.48;

  let svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" style="background:#0a0b10;border-radius:8px;display:block;">`;

  // grid
  for (let i = 0; i <= 3; i++) {
    const y = pt + (ch / 3) * i;
    const gp = maxP - (pr2 / 3) * i;
    svg += `<line x1="${pl}" y1="${y}" x2="${w - pr}" y2="${y}" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>`;
    svg += `<text x="${w - pr + 4}" y="${y + 3}" font-family="JetBrains Mono,monospace" font-size="8" fill="rgba(255,255,255,0.25)">${gp.toFixed(1)}</text>`;
  }

  // FVG box
  svg += `<rect x="${pl}" y="${toY(fvgTop)}" width="${cw}" height="${Math.max(toY(fvgBot) - toY(fvgTop), 2)}" fill="rgba(255,214,10,0.07)" stroke="rgba(255,214,10,0.35)" stroke-width="1" stroke-dasharray="3,2"/>`;
  svg += `<text x="${pl + 3}" y="${toY(fvgTop) - 2}" font-family="JetBrains Mono,monospace" font-size="8" fill="#ffd60a">FVG</text>`;

  // OB box
  svg += `<rect x="${pl}" y="${toY(obTop)}" width="${cw * 0.65}" height="${Math.max(toY(obBot) - toY(obTop), 2)}" fill="rgba(191,90,242,0.07)" stroke="rgba(191,90,242,0.35)" stroke-width="1" stroke-dasharray="3,2"/>`;
  svg += `<text x="${pl + 3}" y="${toY(obBot) + 9}" font-family="JetBrains Mono,monospace" font-size="8" fill="#bf5af2">OB</text>`;

  // candles
  candles.forEach((c, i) => {
    const x = toX(i);
    const bull = c.close >= c.open;
    const col = bull ? "#00e87a" : "#ff2d55";
    const bt = toY(Math.max(c.open, c.close));
    const bb = toY(Math.min(c.open, c.close));
    const bh = Math.max(bb - bt, 1);
    svg += `<line x1="${x}" y1="${toY(c.high)}" x2="${x}" y2="${toY(c.low)}" stroke="${col}" stroke-width="0.8" opacity="0.6"/>`;
    svg += `<rect x="${x - cndW / 2}" y="${bt}" width="${cndW}" height="${bh}" fill="${col}" opacity="${bull ? 0.9 : 0.85}"/>`;
  });

  // target line
  svg += `<line x1="${pl}" y1="${toY(target)}" x2="${w - pr}" y2="${toY(target)}" stroke="#00e87a" stroke-width="1" stroke-dasharray="4,3" opacity="0.9"/>`;
  svg += `<text x="${w - pr + 4}" y="${toY(target) + 3}" font-family="JetBrains Mono,monospace" font-size="8" fill="#00e87a">TP</text>`;

  // stop line
  svg += `<line x1="${pl}" y1="${toY(stop)}" x2="${w - pr}" y2="${toY(stop)}" stroke="#ff2d55" stroke-width="1" stroke-dasharray="4,3" opacity="0.9"/>`;
  svg += `<text x="${w - pr + 4}" y="${toY(stop) + 3}" font-family="JetBrains Mono,monospace" font-size="8" fill="#ff2d55">SL</text>`;

  // alert line
  svg += `<line x1="${pl}" y1="${toY(p)}" x2="${w - pr}" y2="${toY(p)}" stroke="rgba(77,159,255,0.7)" stroke-width="1"/>`;
  svg += `<text x="${w - pr + 4}" y="${toY(p) + 3}" font-family="JetBrains Mono,monospace" font-size="8" fill="#4d9fff">▶</text>`;

  // entry arrow at last candle
  const lx = toX(numC - 1);
  const ey = toY(p);
  svg += `<polygon points="${lx + 6},${ey} ${lx + 14},${ey - 5} ${lx + 14},${ey + 5}" fill="#4d9fff" opacity="0.95"/>`;

  svg += `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// -------------------------------------------------------
// WEBHOOK
// -------------------------------------------------------
app.post("/webhook", async (req, res) => {
  const { secret, symbol, interval, price, message } = req.body;

  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.json({ received: true });

  const prompt = `You are Chartly, an elite ICT Smart Money trading analyst. Alert fired: ${symbol || "Unknown"} hit $${price || "Unknown"} on the ${interval || "Unknown"}m chart.

Give sharp Smart Money analysis covering:
- Fair Value Gap: bullish or bearish FVG near this price with exact range
- Order Block: nearest OB zone with specific prices
- Entry: exact entry price or tight range
- Target: specific take profit price  
- Stop: specific stop loss price
- Structure: did price break structure bullish or bearish here

Rules — no asterisks, no markdown, no bold. Real prices close to $${price}. 4-5 sentences. Write like a sharp prop trader texting his friend, not a textbook. Direct and specific.

End response on a new line with one word: BULLISH, BEARISH, or NEUTRAL`;

  try {
    const [aiResp, newsText] = await Promise.all([
      anthropic.messages.create({
        model: "claude-opus-4-5",
        max_tokens: 350,
        messages: [{ role: "user", content: prompt }],
      }),
      fetchNews(symbol)
    ]);

    let raw = aiResp.content[0].text.replace(/\*\*/g, "").replace(/\*/g, "").trim();
    const lines = raw.split("\n").filter(l => l.trim());
    const last = lines[lines.length - 1].trim();
    const bias = ["BULLISH", "BEARISH", "NEUTRAL"].includes(last) ? last : "NEUTRAL";
    const commentary = lines.filter(l => !["BULLISH","BEARISH","NEUTRAL"].includes(l.trim())).join(" ").trim();

    const chartImage = generateChartSVG(price);

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
  } catch (err) {
    console.error("Error:", err.message);
  }
});

app.get("/alerts", (req, res) => {
  res.json({ alerts });
});

app.listen(PORT, () => {
  console.log(`Chartly running on port ${PORT}`);
});
