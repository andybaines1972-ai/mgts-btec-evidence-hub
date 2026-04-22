const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

/* =========================
   ENV VARIABLES (SET THESE)
========================= */
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GEMINI_API_KEY) console.warn("⚠️ Missing GEMINI_API_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) console.warn("⚠️ Missing Supabase config");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* =========================
   HELPERS
========================= */
function safeParse(text) {
  try { return JSON.parse(text); }
  catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch {}
    }
    return {};
  }
}

function normaliseStatus(s = "") {
  const v = s.toLowerCase();
  if (v.includes("achieved")) return "Achieved";
  if (v.includes("not")) return "Not Achieved";
  return "Review Required";
}

function buildBandSummary(audit = []) {
  const summary = {
    P: { achieved: 0, review: 0, not: 0, total: 0 },
    M: { achieved: 0, review: 0, not: 0, total: 0 },
    D: { achieved: 0, review: 0, not: 0, total: 0 }
  };

  audit.forEach(item => {
    const band = (item.id || "")[0];
    if (!summary[band]) return;

    summary[band].total++;
    const s = normaliseStatus(item.finalStatus || item.status);

    if (s === "Achieved") summary[band].achieved++;
    else if (s === "Not Achieved") summary[band].not++;
    else summary[band].review++;
  });

  return summary;
}

function calculateGrade(audit = []) {
  if (audit.some(a => normaliseStatus(a.finalStatus) === "Not Achieved")) return "Not Achieved";
  if (audit.some(a => normaliseStatus(a.finalStatus) === "Review Required")) return "Review Required";
  return "Achieved";
}

/* =========================
   HEALTH
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* =========================
   CLIENT CONFIG
========================= */
app.get("/api/client-config", (req, res) => {
  res.json({ ok: true });
});

/* =========================
   BRIEF SCAN
========================= */
app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { filename } = req.body;

    // Keep stable for now — frontend still works
    res.json({
      result: {
        unitTitle: "",
        unitNumber: "",
        learningAims: [],
        tasks: [],
        criteria: [],
        commandVerbIndex: [],
        extractedFrom: filename,
        schemaVersion: "brief.v1"
      }
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   MAIN GRADING ENGINE
========================= */
app.post("/api/grade/submission-multi", async (req, res) => {
  try {
    const payload = req.body || {};
    const files = payload.files || [];
    const brief = payload.briefInterpretation || {};
    const criteria = payload.criteria || [];

    if (!files.length) {
      return res.status(400).json({ error: "No files provided" });
    }

    if (!criteria.length && (!brief.criteria || !brief.criteria.length)) {
      return res.status(400).json({ error: "No criteria provided" });
    }

    const criteriaText = (brief.criteria || criteria)
      .map(c => `${c.code}: ${c.requirement}`)
      .join("\n");

    const fileNames = files.map(f => f.filename).join(", ");

    const prompt = `
You are a professional BTEC assessor.

Return ONLY JSON:

{
 "fullName":"Learner Submission",
 "audit":[
  {
   "id":"P1",
   "status":"Achieved",
   "finalStatus":"Achieved",
   "rationale":"Clear evidence-based justification",
   "action":"Developmental improvement guidance",
   "confidenceScore":75
  }
 ],
 "developmentalSummary":"Overall improvements..."
}

Rules:
- Use professional assessor tone
- Development must NOT say "to achieve P1"
- Be realistic and evidence-based
- Do not over-award

Criteria:
${criteriaText}

Files:
${fileNames}
`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    const parsed = safeParse(raw);

    const audit = Array.isArray(parsed.audit) ? parsed.audit : [];

    const normalisedAudit = audit.map(item => ({
      id: item.id || "",
      requirement: item.requirement || "",
      status: normaliseStatus(item.status),
      finalStatus: normaliseStatus(item.finalStatus || item.status),
      rationale: item.rationale || "",
      action: item.action || "",
      confidenceScore: Number(item.confidenceScore || 50)
    }));

    const result = {
      fullName: parsed.fullName || "Learner Submission",
      audit: normalisedAudit,
      grade: calculateGrade(normalisedAudit),
      overallBandSummary: buildBandSummary(normalisedAudit),
      developmentalSummary: parsed.developmentalSummary || "",
      briefInterpretation: brief,
      recordControl: {
        recordStatus: "Draft",
        ivRequired: false
      },
      meta: {
        generatedAt: new Date().toISOString()
      }
    };

    res.json({ result });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   SAVE RECORD
========================= */
app.post("/api/records/save", async (req, res) => {
  try {
    const { result } = req.body;

    const { data, error } = await supabase
      .from("feedback_records")
      .insert([{ data: result }])
      .select("id")
      .single();

    if (error) throw error;

    res.json({ id: data.id });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   UPDATE RECORD
========================= */
app.post("/api/records/update", async (req, res) => {
  try {
    const { dbId, result } = req.body;

    const { error } = await supabase
      .from("feedback_records")
      .update({ data: result })
      .eq("id", dbId);

    if (error) throw error;

    res.json({ ok: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   LIST RECORDS
========================= */
app.get("/api/records/list", async (req, res) => {
  const { data, error } = await supabase
    .from("feedback_records")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.json({ records: data || [] });
});

/* =========================
   WORKFLOW ACTIONS
========================= */
app.post("/api/records/action", async (req, res) => {
  try {
    const { record, action } = req.body;

    const rc = record.recordControl || {};

    if (action === "review") rc.recordStatus = "Reviewed";
    if (action === "signoff") rc.recordStatus = "Signed Off";
    if (action === "iv") rc.recordStatus = "IV Required";
    if (action === "release") rc.recordStatus = "Released";

    record.recordControl = rc;

    res.json({ ok: true, record });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
