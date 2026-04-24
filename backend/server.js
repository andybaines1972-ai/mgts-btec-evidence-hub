const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const multer = require("multer");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;

/* ==============================
   UTILS
============================== */

async function callGemini(prompt, retries = 2) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`;

  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      });

      const data = await res.json();

      if (data.error) throw new Error(data.error.message);

      return data.candidates[0].content.parts[0].text;

    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

/* ==============================
   2-PASS ANALYSIS
============================== */

async function runTwoPass(text, criteria) {

  // PASS 1 → Deep extraction
  const extractionPrompt = `
Extract detailed evidence for the following criteria:

${criteria.join(", ")}

Return structured bullet points with:
- what the learner did
- depth
- missing areas
- quotes

TEXT:
${text.slice(0, 50000)}
`;

  const extracted = await callGemini(extractionPrompt);

  // PASS 2 → Evaluation
  const evaluationPrompt = `
You are a Pearson BTEC assessor.

Using the extracted evidence below, evaluate each criterion:

${criteria.join(", ")}

RULES:
- Do NOT repeat generic text
- Each criterion must be DIFFERENT
- Provide:
  1. judgement
  2. specific reasoning
  3. improvement action

EVIDENCE:
${extracted}
`;

  const evaluated = await callGemini(evaluationPrompt);

  return evaluated;
}

/* ==============================
   ROUTES
============================== */

// 🔍 FIXED: scan brief endpoint (was 404)
app.post("/api/brief/scan-file", upload.single("file"), async (req, res) => {
  try {
    const text = req.file.buffer.toString("utf-8");

    const result = await callGemini(`
Extract all grading criteria from this assignment brief.

Return:
- list of criteria codes
- mapped descriptions

TEXT:
${text.slice(0, 30000)}
`);

    res.json({ success: true, result });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// 🧠 MAIN AUDIT
app.post("/api/audit/run", async (req, res) => {
  try {
    const { text, criteria } = req.body;

    if (!text || !criteria) {
      return res.status(400).json({ error: "Missing input" });
    }

    const result = await runTwoPass(text, criteria);

    res.json({ success: true, result });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/* ==============================
   START SERVER
============================== */

app.listen(PORT, () => {
  console.log(`🚀 MGTS 2-pass server running on port ${PORT}`);
});
