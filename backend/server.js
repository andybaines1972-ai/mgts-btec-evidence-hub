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
   HEALTH + CONFIG
================================ */
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/client-config", (_req, res) => {
  res.json({
    logoUrl: process.env.CLIENT_LOGO_URL || ""
  });
});

/* ================================
   HELPERS
================================ */
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
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

/* ================================
   GEMINI CORE
================================ */
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
  return json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
}

/* ================================
   STAGE 1 — BRIEF SCAN
================================ */
async function scanBrief(file) {
  const prompt = {
    contents: [{
      parts: [
        {
          text: `
Extract BTEC structured data.

Return JSON:
{
 "criteria":[{"code":"P1","requirement":"..."}],
 "unit_context":"...",
 "assignment_context":"...",
 "evidence_requirements":["..."],
 "extracted_from":"${file.filename}"
}`
        },
        {
          inline_data: {
            mime_type: "application/pdf",
            data: file.fileBase64
          }
        }
      ]
    }]
  };

  return safeParse(await callGemini("gemini-2.5-flash-lite", prompt));
}

/* ================================
   STAGE 2 — EVIDENCE MAP
================================ */
async function mapEvidence(criteria, files) {
  const prompt = {
    contents: [{
      parts: [{
        text: `
Map evidence to criteria.

Return JSON:
{
 "map":[
   {"id":"P1","evidence":[{"file":"...","snippet":"...","score":70}]}
 ]
}`
      }]
    }]
  };

  return safeParse(await callGemini("gemini-2.5-flash-lite", prompt));
}

/* ================================
   STAGE 3 — ASSESSOR JUDGEMENT
================================ */
async function judge(criteria, evidenceMap, context) {
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
   "confidenceScore":0-100
  }
 ]
}

Criteria:
${JSON.stringify(criteria)}

Evidence:
${JSON.stringify(evidenceMap)}

Context:
${context || ""}
`
      }]
    }]
  };

  return safeParse(await callGemini("gemini-2.5-flash", prompt));
}

/* ================================
   STAGE 4 — VALIDATION
================================ */
async function validate(result) {
  const prompt = {
    contents: [{
      parts: [{
        text: `
Validate assessor output.

Return JSON:
{"audit":[{"id":"P1","finalStatus":"Achieved"}]}

Input:
${JSON.stringify(result)}
`
      }]
    }]
  };

  return safeParse(await callGemini("gemini-2.5-flash-lite", prompt));
}

/* ================================
   PIPELINE
================================ */
async function runPipeline(payload) {

  const evidence = await mapEvidence(payload.criteria, payload.files);
  const judged = await judge(payload.criteria, evidence, payload.unitInfo);
  const validated = await validate(judged);

  const audit = payload.criteria.map(c => {
    const j = judged?.audit?.find(a => a.id === c.code) || {};
    const v = validated?.audit?.find(a => a.id === c.code) || {};

    return {
      id: c.code,
      requirement: c.requirement,
      status: normaliseStatus(j.status),
      finalStatus: normaliseStatus(v.finalStatus || j.status),
      rationale: j.rationale || "",
      action: j.action || "",
      confidenceScore: j.confidenceScore || 50
    };
  });

  return {
    fullName: payload.fullName || "Learner",
    audit,
    grade: calculateGrade(audit),
    meta: {
      pipeline: "v2",
      models: ["flash-lite","flash"],
      timestamp: new Date().toISOString()
    }
  };
}

/* ================================
   ROUTES
================================ */
app.post("/api/brief/scan-file", async (req, res) => {
  const result = await scanBrief(req.body);
  res.json({ result });
});

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
  console.log("🚀 Server running on", PORT);
});
