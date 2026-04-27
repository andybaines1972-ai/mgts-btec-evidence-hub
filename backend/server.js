require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 10000;

/* ===============================
   🔧 HEALTH CHECK
================================= */
app.get("/", (req, res) => {
  res.send("✅ MGTS 2-PASS BACKEND LIVE");
});

/* ===============================
   🧠 MODEL CALL WITH FAILOVER
================================= */

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const API_KEY = process.env.GEMINI_API_KEY;

async function callGemini(prompt) {
  try {
    const res = await fetch(`${GEMINI_URL}?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096
        }
      })
    });

    const data = await res.json();

    if (!data?.candidates?.length) {
      throw new Error("No AI response");
    }

    return data.candidates[0].content.parts[0].text;

  } catch (err) {
    console.error("⚠️ Gemini failed:", err.message);
    throw err;
  }
}

/* ===============================
   🛡️ SAFE JSON PARSER (CRITICAL)
================================= */

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      const cleaned = text
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}

/* ===============================
   🧩 FALLBACK CRITERIA EXTRACTOR
================================= */

function extractCriteriaFallback(text) {
  const matches = text.match(/\b([PMD]\d+)\b/gi) || [];

  const unique = [...new Set(matches.map(c => c.toUpperCase()))];

  return unique.map(code => ({
    code,
    requirement: "Requirement inferred from brief (fallback)"
  }));
}
/* ===============================
   CLIENT CONFIG
================================= */

app.get("/api/client-config", (req, res) => {
  res.json({
    logoUrl: "https://www.mgts.co.uk/wp-content/themes/mgts/images/svg/logo.svg",
    organisation: "MGTS"
  });
});

/* ===============================
   SCAN BRIEF — ALWAYS RETURNS:
   { result: { criteria: [...] } }
================================= */

app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { filename, fileBase64 } = req.body || {};

    if (!filename || !fileBase64) {
      return res.status(400).json({
        error: "filename and fileBase64 are required"
      });
    }

    const buffer = Buffer.from(fileBase64, "base64");

    let extractedText = "";

    // Basic text extraction fallback.
    // DOCX/PDF/PPT/image support can be expanded, but this route will not crash.
    try {
      extractedText = buffer.toString("utf8");
    } catch {
      extractedText = "";
    }

    const prompt = `
You are a BTEC assignment brief interpreter.

Extract ALL Pearson/BTEC grading criteria from this file.

Return JSON only in this exact shape:

{
  "unitTitle": "",
  "unitNumber": "",
  "learningAims": [],
  "tasks": [],
  "criteria": [
    {
      "code": "P1",
      "requirement": "exact criterion wording or mapped task requirement"
    }
  ],
  "assignmentContext": "",
  "schemaVersion": "brief.v1"
}

Rules:
- Extract every P/M/D criterion.
- Do not invent criteria.
- If the file text is messy, recover what you can.
- Criteria codes must be P1, P2, M1, D1 etc.

FILENAME:
${filename}

FILE TEXT:
${extractedText.slice(0, 60000)}
`;

    let parsed = null;

    try {
      const aiText = await callGemini(prompt);
      parsed = safeJsonParse(aiText);
    } catch (aiError) {
      console.error("Brief AI scan failed:", aiError.message);
    }

    let criteria = [];

    if (parsed && Array.isArray(parsed.criteria)) {
      criteria = parsed.criteria
        .map(c => ({
          code: String(c.code || "").trim().toUpperCase(),
          requirement: String(c.requirement || "").trim()
        }))
        .filter(c => c.code && c.requirement);
    }

    // Regex fallback if AI returns nothing
    if (!criteria.length) {
      criteria = extractCriteriaFallback(extractedText);
    }

    // Absolute final fallback so frontend shape never breaks
    if (!criteria.length) {
      return res.json({
        result: {
          unitTitle: parsed?.unitTitle || "",
          unitNumber: parsed?.unitNumber || "",
          learningAims: parsed?.learningAims || [],
          tasks: parsed?.tasks || [],
          criteria: [],
          assignmentContext: parsed?.assignmentContext || "",
          ambiguityFlags: [
            `No P/M/D criteria could be extracted from ${filename}. Paste criteria manually or upload a clearer brief.`
          ],
          schemaVersion: "brief.v1"
        }
      });
    }

    return res.json({
      result: {
        unitTitle: parsed?.unitTitle || "",
        unitNumber: parsed?.unitNumber || "",
        learningAims: Array.isArray(parsed?.learningAims) ? parsed.learningAims : [],
        tasks: Array.isArray(parsed?.tasks) ? parsed.tasks : [],
        criteria,
        assignmentContext: parsed?.assignmentContext || "",
        ambiguityFlags: [],
        extractedFrom: filename,
        schemaVersion: "brief.v1"
      }
    });

  } catch (err) {
    console.error("SCAN BRIEF ERROR:", err);

    return res.status(500).json({
      error: err.message,
      result: {
        criteria: []
      }
    });
  }
});
