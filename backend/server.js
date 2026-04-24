require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mammoth = require("mammoth");
const JSZip = require("jszip");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MODELS = [
  "gemini-1.5-flash",
  "gemini-1.5-pro"
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/* =========================
   FILE EXTRACTION
========================= */

async function extractDocx(base64) {
  const buffer = Buffer.from(base64, "base64");
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function extractTxt(base64) {
  return Buffer.from(base64, "base64").toString("utf-8");
}

async function extractPptx(base64) {
  const zip = await JSZip.loadAsync(Buffer.from(base64, "base64"));

  const slides = Object.keys(zip.files)
    .filter(f => f.includes("slides/slide"))
    .sort();

  let text = "";

  for (const s of slides) {
    const xml = await zip.files[s].async("string");
    const matches = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)];
    text += matches.map(m => m[1]).join(" ") + "\n";
  }

  return text;
}

/* =========================
   GEMINI CALL
========================= */

async function callGemini(prompt) {
  for (const model of MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
          })
        }
      );

      const data = await res.json();

      if (!res.ok) throw new Error(data.error?.message);

      return data.candidates[0].content.parts[0].text;

    } catch (err) {
      console.log("Retrying model:", model);
      await sleep(1000);
    }
  }

  throw new Error("All AI models failed");
}

/* =========================
   BRIEF SCAN (FIXED)
========================= */

app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { filename, fileBase64 } = req.body;

    let text = "";
    const lower = filename.toLowerCase();

    if (lower.endsWith(".docx")) text = await extractDocx(fileBase64);
    else if (lower.endsWith(".txt")) text = await extractTxt(fileBase64);
    else if (lower.endsWith(".pptx")) text = await extractPptx(fileBase64);
    else {
      // fallback for PDF / images
      text = "[Binary file sent to AI]";
    }

    const prompt = `
Extract ALL assessment criteria from this brief.

Return JSON:
{
  "criteria":[
    {"code":"P1","requirement":"..."}
  ]
}

TEXT:
${text.slice(0, 50000)}
`;

    const ai = await callGemini(prompt);
    const parsed = safeJsonParse(ai);

    if (!parsed) throw new Error("AI JSON parse failed");

    res.json({ result: parsed });

  } catch (err) {
    console.error("SCAN ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   HEALTH CHECK
========================= */

app.get("/health", (_, res) => {
  res.json({ status: "ok" });
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(`🚀 MGTS server running on ${PORT}`);
});
