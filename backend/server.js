const express = require("express");
const cors = require("cors");
const mammoth = require("mammoth");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

/* =========================
   ENV VARIABLES
========================= */
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GEMINI_API_KEY) console.warn("⚠️ GEMINI_API_KEY missing");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) console.warn("⚠️ Supabase config missing");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* =========================
   HELPERS
========================= */
function safeParse(text = "") {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {}
    }
    return {};
  }
}

function normaliseStatus(s = "") {
  const v = String(s).toLowerCase();
  if (v === "achieved") return "Achieved";
  if (v === "not achieved") return "Not Achieved";
  if (v === "review required") return "Review Required";
  if (v.includes("review")) return "Review Required";
  if (v.includes("not")) return "Not Achieved";
  if (v.includes("ach")) return "Achieved";
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

function ensureRecordControl(result = {}) {
  result.recordControl = {
    recordStatus: "Draft",
    ivRequired: false,
    ...(result.recordControl || {})
  };
  return result;
}

async function extractDocxText(fileBase64) {
  const buffer = Buffer.from(fileBase64, "base64");
  const result = await mammoth.extractRawText({ buffer });
  return String(result.value || "").trim();
}

function dedupeCriteria(criteria = []) {
  const seen = new Set();
  return criteria
    .map(item => ({
      code: String(item.code || "").trim().toUpperCase(),
      requirement: String(item.requirement || "").trim(),
      band: String(item.band || "").trim().toUpperCase() || String(item.code || "").trim().toUpperCase().charAt(0),
      linkedLearningAims: Array.isArray(item.linkedLearningAims) ? item.linkedLearningAims : [],
      linkedTasks: Array.isArray(item.linkedTasks) ? item.linkedTasks : [],
      commandVerbs: Array.isArray(item.commandVerbs) ? item.commandVerbs : []
    }))
    .filter(item => /^[PMD]\d+$/i.test(item.code) && item.requirement)
    .filter(item => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    });
}

/* =========================
   HEALTH
========================= */
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/* =========================
   CLIENT CONFIG
========================= */
app.get("/api/client-config", (_req, res) => {
  res.json({ ok: true });
});

/* =========================
   BRIEF SCAN (FIXED)
========================= */
app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { filename, fileBase64 } = req.body || {};

    if (!filename || !fileBase64) {
      return res.status(400).json({ error: "filename and fileBase64 are required" });
    }

    let extractedText = "";
    const lower = filename.toLowerCase();

    if (lower.endsWith(".docx")) {
      extractedText = await extractDocxText(fileBase64);
    } else if (lower.endsWith(".txt")) {
      extractedText = Buffer.from(fileBase64, "base64").toString("utf8");
    } else {
      extractedText = "[Brief text extraction is currently optimised for DOCX and TXT briefs]";
    }

    const prompt = `
You are extracting BTEC assignment brief structure.

Return ONLY JSON in this shape:

{
  "unitTitle": "",
  "unitNumber": "",
  "learningAims": [],
  "tasks": [],
  "criteria": [
    {
      "code": "P1",
      "requirement": "",
      "band": "P",
      "linkedLearningAims": [],
      "linkedTasks": [],
      "commandVerbs": []
    }
  ],
  "commandVerbIndex": [],
  "assignmentContext": "",
  "unitContext": "",
  "evidenceRequirements": [],
  "ambiguityFlags": [],
  "extractedFrom": "${filename}",
  "schemaVersion": "brief.v1"
}

Rules:
- Extract only valid P/M/D criteria
- Remove duplicates
- Detect command verbs where possible
- Add learning aims and tasks where clearly present
- If no criteria are found, return "criteria": []
- Return JSON only

Brief text:
${extractedText}
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

    const result = {
      unitTitle: String(parsed.unitTitle || "").trim(),
      unitNumber: String(parsed.unitNumber || "").trim(),
      learningAims: Array.isArray(parsed.learningAims) ? parsed.learningAims : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      criteria: dedupeCriteria(Array.isArray(parsed.criteria) ? parsed.criteria : []),
      commandVerbIndex: Array.isArray(parsed.commandVerbIndex) ? parsed.commandVerbIndex : [],
      assignmentContext: String(parsed.assignmentContext || "").trim(),
      unitContext: String(parsed.unitContext || "").trim(),
      evidenceRequirements: Array.isArray(parsed.evidenceRequirements) ? parsed.evidenceRequirements : [],
      ambiguityFlags: Array.isArray(parsed.ambiguityFlags) ? parsed.ambiguityFlags : [],
      extractedFrom: parsed.extractedFrom || filename,
      schemaVersion: parsed.schemaVersion || "brief.v1"
    };

    return res.json({ result });
  } catch (err) {
    console.error("scan-file failed:", err);
    return res.status(500).json({ error: err.message });
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

    const criteriaSource = Array.isArray(brief.criteria) && brief.criteria.length ? brief.criteria : criteria;

    if (!criteriaSource.length) {
      return res.status(400).json({ error: "No criteria provided" });
    }

    const criteriaText = criteriaSource
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
   "rationale":"Clear evidence-based reasoning",
   "action":"Improvement suggestion written professionally",
   "confidenceScore":75
  }
 ],
 "developmentalSummary":"..."
}

Rules:
- Do not say "to achieve P1"
- Write like a real assessor
- Be realistic, not generous
- Evidence-based judgement
- If unsure, prefer Review Required

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

    let result = {
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

    result = ensureRecordControl(result);

    res.json({ result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/grade/submission", async (req, res) => {
  try {
    const payload = req.body || {};
    const files = payload.files || [];
    if (!files.length) return res.status(400).json({ error: "No files provided" });

    const multiResponse = await fetch(`http://127.0.0.1:${PORT}/api/grade/submission-multi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await multiResponse.json();
    return res.status(multiResponse.status).json(data);
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
      .insert([{ data: ensureRecordControl(result || {}) }])
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
      .update({ data: ensureRecordControl(result || {}) })
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
app.get("/api/records/list", async (_req, res) => {
  const { data, error } = await supabase
    .from("feedback_records")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.json({ records: data || [] });
});

app.post("/api/records/load", async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];

    let query = supabase
      .from("feedback_records")
      .select("*")
      .order("created_at", { ascending: false });

    if (ids.length) {
      query = query.in("id", ids);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ records: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   WORKFLOW ACTIONS
========================= */
app.post("/api/records/action", async (req, res) => {
  try {
    const { record, action } = req.body;
    const rc = (record && record.recordControl) ? record.recordControl : {};

    if (action === "review") rc.recordStatus = "Reviewed";
    if (action === "signoff") rc.recordStatus = "Signed Off";
    if (action === "iv") {
      rc.recordStatus = "IV Required";
      rc.ivRequired = true;
    }
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
