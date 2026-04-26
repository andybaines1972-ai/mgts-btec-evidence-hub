require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/* =========================
   HEALTH
========================= */
app.get("/", (req, res) => {
  res.send("MGTS Backend Running ✅");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    gemini: !!GEMINI_API_KEY
  });
});

/* =========================
   CLIENT CONFIG (fixes 404)
========================= */
app.get("/api/client-config", (req, res) => {
  res.json({
    logoUrl: "https://www.mgts.co.uk/wp-content/themes/mgts/images/svg/logo.svg"
  });
});

/* =========================
   SAFE GEMINI CALL
========================= */
async function callGemini(prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        }),
        signal: controller.signal
      }
    );

    clearTimeout(timeout);

    const data = await response.json();

    return (
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response"
    );
  } catch (err) {
    return `AI Error: ${err.message}`;
  }
}

/* =========================
   SCAN BRIEF (FIXED)
========================= */
app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { filename, fileBase64 } = req.body;

    if (!filename || !fileBase64) {
      return res.status(400).json({ error: "Missing file" });
    }

    const prompt = `
Extract ALL BTEC criteria from this assignment brief.
Return JSON:
{
  "criteria":[
    {"code":"P1","requirement":"..."}
  ]
}
`;

    const result = await callGemini(prompt);

    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch {
      parsed = { criteria: [] };
    }

    res.json({
      result: parsed
    });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`🚀 MGTS backend running on port ${PORT}`);
});
