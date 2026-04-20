const express = require("express");
const cors = require("cors");
const { Document, Packer, Paragraph, Table, TableRow, TableCell } = require("docx");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

/* ================================
   CONFIG
================================ */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODELS = (process.env.GEMINI_GRADE_MODELS || "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-1.5-flash").split(",");
const RETRIES = Number(process.env.GEMINI_RETRY_COUNT || 3);

/* ================================
   GEMINI CALL
================================ */
async function callGemini(model, payload) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY
    },
    body: JSON.stringify(payload)
  });

  const json = await res.json();
  return json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

/* ================================
   JSON SAFE PARSE
================================ */
function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      const fixed = text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1);
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }
}

/* ================================
   CASCADE EXECUTION
================================ */
async function runCascade(prompt) {
  for (const model of MODELS) {
    for (let i = 0; i < RETRIES; i++) {
      try {
        const text = await callGemini(model, prompt);
        const parsed = safeJSON(text);
        if (parsed) return parsed;
      } catch (err) {}
    }
  }
  return null;
}

/* ================================
   BASE GRADING PROMPT
================================ */
function buildPrompt(payload) {
  return {
    contents: [
      {
        parts: [
          {
            text: `
You are a BTEC assessor.

Return ONLY JSON.

{
  "fullName": "string",
  "grade": "Achieved | Not Achieved | Review Required",
  "audit": [
    {
      "id": "P1",
      "requirement": "string",
      "status": "Achieved | Not Achieved | Review Required",
      "evidencePage": "string",
      "evidenceAndDepth": "string",
      "rationale": "string",
      "action": "string",
      "confidenceScore": number,
      "evidenceTrace": []
    }
  ]
}

Criteria:
${JSON.stringify(payload.criteria)}

Tutor override:
${payload.tutorOverrideInput || "None"}
`
          }
        ]
      }
    ]
  };
}

/* ================================
   APPLY TUTOR OVERRIDE
================================ */
function applyOverride(result, text) {
  if (!text) return result;

  text.split("\n").forEach(line => {
    const m = line.match(/^([PMD]\d+)\s*=\s*(.+)$/i);
    if (!m) return;

    const code = m[1].toUpperCase();
    let val = m[2].toLowerCase();

    if (val.includes("achieved")) val = "Achieved";
    else if (val.includes("review")) val = "Review Required";
    else val = "Not Achieved";

    const item = result.audit.find(a => a.id === code);
    if (item) item.finalStatus = val;
  });

  return result;
}

/* ================================
   GRADE CALC
================================ */
function calcGrade(audit) {
  if (audit.some(a => a.finalStatus === "Not Achieved")) return "Not Achieved";
  if (audit.some(a => a.finalStatus === "Review Required")) return "Review Required";
  return "Achieved";
}

/* ================================
   GRADE ENDPOINT
================================ */
app.post("/api/grade/submission-multi", async (req, res) => {
  try {
    const prompt = buildPrompt(req.body);
    let result = await runCascade(prompt);

    if (!result) {
      result = {
        fullName: "Submission",
        grade: "Review Required",
        audit: req.body.criteria.map(c => ({
          id: c.code,
          requirement: c.requirement,
          finalStatus: "Review Required"
        }))
      };
    }

    result = applyOverride(result, req.body.tutorOverrideInput);
    result.grade = calcGrade(result.audit);

    res.json({ result });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================================
   EXPORT DOCX
================================ */
app.post("/api/export/feedback-docx", async (req, res) => {
  const result = req.body.result;

  const rows = result.audit.map(a =>
    new TableRow({
      children: [
        new TableCell({ children: [new Paragraph(a.id)] }),
        new TableCell({ children: [new Paragraph(a.requirement)] }),
        new TableCell({ children: [new Paragraph(a.finalStatus)] })
      ]
    })
  );

  const doc = new Document({
    sections: [{
      children: [
        new Paragraph(result.fullName),
        new Paragraph(`Grade: ${result.grade}`),
        new Table({ rows })
      ]
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  res.setHeader("Content-Disposition", "attachment; filename=feedback.docx");
  res.send(buffer);
});

/* ================================
   IV LOG EXPORT
================================ */
app.get("/api/export/iv-log", (req, res) => {
  const data = [
    ["Learner", "Criteria", "Status"],
    ["Example", "P1", "Achieved"]
  ];

  const csv = data.map(r => r.join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.send(csv);
});

/* ================================
   START SERVER
================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));
