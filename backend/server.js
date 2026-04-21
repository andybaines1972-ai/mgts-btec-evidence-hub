const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

/* ================================
   ENV
================================ */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("⚠️ Missing Supabase ENV");
}
if (!GEMINI_API_KEY) {
  console.warn("⚠️ Missing Gemini API Key");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ================================
   HELPERS
================================ */
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start !== -1 && end !== -1) {
        return JSON.parse(text.slice(start, end + 1));
      }
    } catch {}
    return null;
  }
}

function normaliseStatus(v = "") {
  const t = v.toLowerCase();
  if (t.includes("not")) return "Not Achieved";
  if (t.includes("review")) return "Review Required";
  if (t.includes("ach")) return "Achieved";
  return "Review Required";
}

function calculateGrade(audit) {
  const statuses = audit.map(a => a.finalStatus || a.status);
  if (statuses.includes("Not Achieved")) return "Not Achieved";
  if (statuses.includes("Review Required")) return "Review Required";
  return "Achieved";
}

function inferMime(filename = "") {
  const f = filename.toLowerCase();
  if (f.endsWith(".pdf")) return "application/pdf";
  if (f.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (f.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (f.endsWith(".txt")) return "text/plain";
  if (f.endsWith(".png")) return "image/png";
  if (f.endsWith(".jpg") || f.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

async function callGemini(model, body) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
    }
  );

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  return text;
}

/* ================================
   HEALTH + CONFIG
================================ */
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/client-config", (_req, res) => {
  res.json({
    logoUrl: process.env.CLIENT_LOGO_URL || ""
  });
});

/* ================================
   STAGE 1 — BRIEF SCAN (FIXED)
================================ */
app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { filename, fileBase64 } = req.body;

    const prompt = {
      contents: [{
        parts: [
          {
            text: `
You are extracting BTEC assessment criteria.

STRICT:
- Return ONLY JSON
- No text before or after

FORMAT:
{
 "criteria":[{"code":"P1","requirement":"..."}],
 "unit_context":"...",
 "assignment_context":"...",
 "evidence_requirements":["..."],
 "extracted_from":"${filename}"
}

RULES:
- Only P/M/D criteria
- Remove duplicates
- If none found return {"criteria":[]}
`
          },
          {
            inline_data: {
              mime_type: inferMime(filename),
              data: fileBase64
            }
          }
        ]
      }]
    };

    const raw = await callGemini("gemini-2.5-flash-lite", prompt);
    console.log("RAW:", raw);

    const parsed = safeParse(raw) || { criteria: [] };

    res.json({ result: parsed });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================================
   PIPELINE
================================ */
async function runPipeline(payload) {

  const prompt = {
    contents: [{
      parts: [{
        text: `
You are a BTEC assessor.

Return JSON:
{
 "audit":[
  {
   "id":"P1",
   "status":"Achieved | Not Achieved | Review Required",
   "rationale":"...",
   "action":"...",
   "confidenceScore":70
  }
 ]
}

Criteria:
${JSON.stringify(payload.criteria)}

Context:
${payload.unitInfo || ""}
`
      }]
    }]
  };

  const raw = await callGemini("gemini-2.5-flash", prompt);
  const parsed = safeParse(raw) || { audit: [] };

  const audit = payload.criteria.map(c => {
    const found = parsed.audit.find(a => a.id === c.code) || {};
    return {
      id: c.code,
      requirement: c.requirement,
      status: normaliseStatus(found.status),
      finalStatus: normaliseStatus(found.status),
      rationale: found.rationale || "",
      action: found.action || "",
      confidenceScore: found.confidenceScore || 50
    };
  });

  return {
    fullName: payload.fullName || "Learner",
    audit,
    grade: calculateGrade(audit),
    meta: {
      model: "gemini-2.5-flash",
      timestamp: new Date().toISOString()
    }
  };
}

/* ================================
   ROUTES
================================ */
app.post("/api/grade/submission", async (req, res) => {
  const result = await runPipeline(req.body);
  res.json({ result });
});

app.post("/api/grade/submission-multi", async (req, res) => {
  const result = await runPipeline(req.body);
  res.json({ result });
});

/* ================================
   RECORDS
================================ */
app.get("/api/records/list", async (_req, res) => {
  const { data } = await supabase
    .from("feedback_records")
    .select("*")
    .order("created_at", { ascending: false });

  res.json({ records: data });
});

app.post("/api/records/load", async (req, res) => {
  const ids = req.body.ids || [];
  let query = supabase.from("feedback_records").select("*");

  if (ids.length) query = query.in("id", ids);

  const { data } = await query.order("created_at", { ascending: false });
  res.json({ records: data });
});

app.post("/api/records/save", async (req, res) => {
  const { result } = req.body;

  const { data } = await supabase
    .from("feedback_records")
    .insert([{ data: result }])
    .select("id")
    .single();

  res.json({ id: data.id });
});

app.post("/api/records/update", async (req, res) => {
  const { dbId, result } = req.body;

  await supabase
    .from("feedback_records")
    .update({ data: result })
    .eq("id", dbId);

  res.json({ ok: true });
});

/* ================================
   START
================================ */
app.listen(PORT, () => {
  console.log("🚀 Running on port", PORT);
});
