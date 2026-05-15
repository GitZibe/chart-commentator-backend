const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------------------------------------------
// SETUP
// -------------------------------------------------------
app.use(cors()); // allows your frontend to talk to this backend
app.use(express.json()); // lets us read JSON data from TradingView

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// In-memory store — holds the last 50 alerts
// (resets if the server restarts, which is fine for now)
const alerts = [];
const MAX_ALERTS = 50;

// Secret token to make sure only YOUR TradingView alerts hit this endpoint
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "changeme123";

// -------------------------------------------------------
// HEALTH CHECK
// Makes sure Railway knows the server is running
// -------------------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "Chart Commentator is running" });
});

// -------------------------------------------------------
// WEBHOOK ENDPOINT
// TradingView will POST to: https://your-app.railway.app/webhook
// -------------------------------------------------------
app.post("/webhook", async (req, res) => {
  const { secret, symbol, interval, price, message } = req.body;

  // Basic security check
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Acknowledge TradingView immediately so it doesn't retry
  res.json({ received: true });

  // Build the AI prompt from what TradingView sent
  const prompt = `You are an expert futures and forex trading co-pilot.

A TradingView alert just fired. Here are the details:
- Symbol: ${symbol || "Unknown"}
- Timeframe: ${interval || "Unknown"}
- Price at alert: ${price || "Unknown"}
- Alert message from TradingView: ${message || "No message"}

Give a concise 3-5 sentence commentary in plain English, like an experienced trader sitting next to a beginner.
Cover: what this alert likely means, the key level or zone to watch, and one thing to look for before considering a trade.
End your response on its own line with just one word: BULLISH, BEARISH, or NEUTRAL.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const commentary = response.content[0].text;

    // Extract bias from the last line
    const lines = commentary.trim().split("\n");
    const lastLine = lines[lines.length - 1].trim();
    const bias = ["BULLISH", "BEARISH", "NEUTRAL"].includes(lastLine)
      ? lastLine
      : "NEUTRAL";
    const commentaryText = bias
      ? lines.slice(0, -1).join("\n").trim()
      : commentary.trim();

    // Build the alert object
    const alert = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      symbol: symbol || "Unknown",
      interval: interval || "Unknown",
      price: price || null,
      tvMessage: message || "",
      commentary: commentaryText,
      bias,
    };

    // Add to front of array, keep max 50
    alerts.unshift(alert);
    if (alerts.length > MAX_ALERTS) alerts.pop();

    console.log(`[${alert.symbol}] Alert processed — ${bias}`);
  } catch (err) {
    console.error("AI error:", err.message);
  }
});

// -------------------------------------------------------
// ALERTS ENDPOINT
// Your frontend polls this to get the latest commentary
// -------------------------------------------------------
app.get("/alerts", (req, res) => {
  res.json({ alerts });
});

// -------------------------------------------------------
// START SERVER
// -------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Chart Commentator running on port ${PORT}`);
});
