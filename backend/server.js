const express = require("express");
const cors = require("cors");
const mammoth = require("mammoth");
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
const CLIENT_LOGO_URL = process.env.CLIENT_LOGO_URL || "";
const PORT = Number(process.env.PORT || 3000);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("Missing Supabase environment variables.");
}
if (!GEMINI_API_KEY) {
  console.warn("Missing GEMINI_API_KEY.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ================================
   HELPERS
================================ */
function jsonResponse(res, status, payload) {
  return res.status(status).json(payload);
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    try {
      const start = String(text || "").indexOf("{");
      const end = String(text || "").lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(String(text).slice(start, end + 1));
      }
    } catch (_) {}
    return null;
  }
}

function normaliseStatus(value = "") {
  const v = String(value).trim().toLowerCase();

  if (v === "achieved") return "Achieved";
  if (v === "not achieved") return "Not Achieved";
  if (v === "review required") return "Review Required";

  if (v.includes("review")) return "Review Required";
  if (v.includes("not achieved")) return "Not Achieved";
  if (v.includes("not")) return "Not Achieved";
  if (v.includes("ach")) return "Achieved";

  return "Review Required";
}

function calculateOverallGrade(audit = []) {
  const statuses = audit.map(a => a.finalStatus || a.status || "Review Required");
  if (statuses.some(s => s === "Not Achieved")) return "Not Achieved";
  if (statuses.some(s => s === "Review Required")) return "Review Required";
  return "Achieved";
}

function inferMimeType(filename = "") {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function cleanCriterionCode(code = "") {
  return String(code).trim().toUpperCase().replace(/\s+/g, "");
}

function dedupeCriteria(criteria = []) {
  const seen = new Set();
  return criteria
    .map(item => ({
      code: cleanCriterionCode(item.code),
      requirement: String(item.requirement || "").trim(),
    }))
    .filter(item => /^[PMD]\d+$/i.test(item.code) && item.requirement)
    .filter(item => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    });
}

function buildInlineDataPart(file) {
  return {
    inline_data: {
      mime_type: inferMimeType(file.filename || ""),
      data: file.fileBase64,
    },
  };
}

function ensureRecordControl(result) {
  if (!result.recordControl) {
    result.recordControl = {
      recordStatus: "Draft",
      assessorSignedOffAt: "",
      ivRequired: false,
      ivDecision: "",
      releasedAt: "",
    };
  }
  return result;
}

/* ================================
   GEMINI
================================ */
async function callGeminiJson(model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  let json;
  try {
    json = await response.json();
  } catch (err) {
    throw new Error(`Gemini returned non-JSON response for ${model}: ${err.message}`);
  }

  console.log("GEMINI STATUS:", response.status);
  console.log("GEMINI JSON:", JSON.stringify(json));

  if (!response.ok) {
    throw new Error(json?.error?.message || `Gemini request failed for ${model}`);
  }

  return json;
}

function extractGeminiText(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  return parts.map(part => part?.text || "").join("").trim();
}

async function callGeminiText(model, body) {
  const json = await callGeminiJson(model, body);
  return extractGeminiText(json);
}

/* ================================
   TEXT EXTRACTION
================================ */
async function extractTextFromUpload({ filename, fileBase64 }) {
  const lower = String(filename || "").toLowerCase();

  if (lower.endsWith(".docx")) {
    const buffer = Buffer.from(fileBase64, "base64");
    const result = await mammoth.extractRawText({ buffer });
    return String(result.value || "").trim();
  }

  if (lower.endsWith(".txt")) {
    return Buffer.from(fileBase64, "base64").toString("utf8");
  }

  return "";
}

/* ================================
   BRIEF SCAN
================================ */
async function scanBriefWithGemini(file) {
  const extractedText = await extractTextFromUpload(file);

  console.log("BRIEF FILE:", file.filename);
  console.log("EXTRACTED TEXT PREVIEW:", extractedText.slice(0, 2500));

  let body;

  if (extractedText) {
    body = {
      generationConfig: {
        responseMimeType: "application/json",
      },
      contents: [
        {
          parts: [
            {
              text:
                `You are extracting BTEC assessment criteria from an assignment brief.\n` +
                `Return only valid JSON in exactly this shape:\n` +
                `{\n` +
                `  "criteria":[{"code":"P1","requirement":"..."}],\n` +
                `  "unit_context":"...",\n` +
                `  "assignment_context":"...",\n` +
                `  "evidence_requirements":["..."],\n` +
                `  "extracted_from":"${file.filename}"\n` +
                `}\n` +
                `Rules:\n` +
                `- Extract only valid P, M, D criteria codes.\n` +
                `- Remove duplicates.\n` +
                `- Keep requirement text concise but accurate.\n` +
                `- If no criteria are found, return "criteria":[] and still fill other fields where possible.\n\n` +
                `Brief text:\n${extractedText}`,
            },
          ],
        },
      ],
    };
  } else {
    body = {
      generationConfig: {
        responseMimeType: "application/json",
      },
      contents: [
        {
          parts: [
            {
              text:
                `You are extracting BTEC assessment criteria from an assignment brief.\n` +
                `Return only valid JSON in exactly this shape:\n` +
                `{\n` +
                `  "criteria":[{"code":"P1","requirement":"..."}],\n` +
                `  "unit_context":"...",\n` +
                `  "assignment_context":"...",\n` +
                `  "evidence_requirements":["..."],\n` +
                `  "extracted_from":"${file.filename}"\n` +
                `}\n` +
                `Rules:\n` +
                `- Extract only valid P, M, D criteria codes.\n` +
                `- Remove duplicates.\n` +
                `- Keep requirement text concise but accurate.\n` +
                `- If no criteria are found, return "criteria":[] and still fill other fields where possible.\n`,
            },
            buildInlineDataPart(file),
          ],
        },
      ],
    };
  }

  const raw = await callGeminiText("gemini-2.5-flash", body);
  console.log("RAW:", raw);

  const parsed = safeParse(raw) || {};
  const criteria = dedupeCriteria(Array.isArray(parsed.criteria) ? parsed.criteria : []);

  return {
    criteria,
    unit_context: String(parsed.unit_context || "").trim(),
    assignment_context: String(parsed.assignment_context || "").trim(),
    evidence_requirements: Array.isArray(parsed.evidence_requirements)
      ? parsed.evidence_requirements.map(v => String(v).trim()).filter(Boolean)
      : [],
    extracted_from: parsed.extracted_from || file.filename,
  };
}

/* ================================
   EVIDENCE MAP
================================ */
async function mapEvidenceWithGemini(payload) {
  const fileSummary = (payload.files || [])
    .map((f, i) => `${i + 1}. ${f.filename} [role=${f.role || "general"}]`)
    .join("\n");

  const body = {
    generationConfig: {
      responseMimeType: "application/json",
    },
    contents: [
      {
        parts: [
          {
            text:
              `Map likely evidence against each BTEC criterion.\n` +
              `Return only JSON in this shape:\n` +
              `{\n` +
              `  "map":[\n` +
              `    {\n` +
              `      "id":"P1",\n` +
              `      "evidence":[\n` +
              `        {"file":"report.docx","locator":"Page 2","snippet":"...","role":"report","score":78}\n` +
              `      ]\n` +
              `    }\n` +
              `  ]\n` +
              `}\n` +
              `Rules:\n` +
              `- Include one map item per criterion.\n` +
              `- Use only supplied criterion IDs.\n` +
              `- Be conservative.\n\n` +
              `Criteria:\n${JSON.stringify(payload.criteria || [])}\n\n` +
              `Unit context:\n${payload.unitInfo || ""}\n\n` +
              `Files:\n${fileSummary}`,
          },
          ...(payload.files || []).map(buildInlineDataPart),
        ],
      },
    ],
  };

  const raw = await callGeminiText("gemini-2.5-flash-lite", body);
  const parsed = safeParse(raw) || {};
  return Array.isArray(parsed.map) ? parsed.map : [];
}

/* ================================
   JUDGEMENT
================================ */
async function judgeWithGemini(payload, evidenceMap) {
  const body = {
    generationConfig: {
      responseMimeType: "application/json",
    },
    contents: [
      {
        parts: [
          {
            text:
              `You are a BTEC assessor generating criterion-level feedback.\n` +
              `Return only JSON in this shape:\n` +
              `{\n` +
              `  "fullName":"Learner Submission",\n` +
              `  "audit":[\n` +
              `    {\n` +
              `      "id":"P1",\n` +
              `      "status":"Achieved | Not Achieved | Review Required",\n` +
              `      "finalStatus":"Achieved | Not Achieved | Review Required",\n` +
              `      "evidencePage":"...",\n` +
              `      "evidenceAndDepth":"...",\n` +
              `      "rationale":"...",\n` +
              `      "action":"...",\n` +
              `      "confidenceScore":68,\n` +
              `      "evidenceTrace":[{"file":"...","locator":"...","role":"...","score":72,"snippet":"..."}]\n` +
              `    }\n` +
              `  ]\n` +
              `}\n\n` +
              `Rules:\n` +
              `- Include one audit item for every supplied criterion.\n` +
              `- Use exactly these statuses: Achieved, Not Achieved, Review Required.\n` +
              `- If evidence is weak or partial, prefer Review Required.\n` +
              `- Keep rationale and action practical and assessor-style.\n\n` +
              `Mode: ${payload.mode || "assessor"}\n` +
              `Assessment Mode: ${payload.assessmentMode || ""}\n` +
              `Unit: ${payload.unitInfo || ""}\n` +
              `Tutor Notes: ${payload.tutorLedCriteria || ""}\n` +
              `Full Unit Info: ${payload.fullUnitInfo || ""}\n\n` +
              `Criteria:\n${JSON.stringify(payload.criteria || [])}\n\n` +
              `Evidence Map:\n${JSON.stringify(evidenceMap || [])}`,
          },
          ...(payload.files || []).map(buildInlineDataPart),
        ],
      },
    ],
  };

  const raw = await callGeminiText("gemini-2.5-flash", body);
  return safeParse(raw) || {};
}

/* ================================
   VALIDATION
================================ */
async function validateWithGemini(criteria, judgedResult) {
  const body = {
    generationConfig: {
      responseMimeType: "application/json",
    },
    contents: [
      {
        parts: [
          {
            text:
              `Validate assessor feedback for consistency.\n` +
              `Return only JSON in this shape:\n` +
              `{"audit":[{"id":"P1","finalStatus":"Achieved | Not Achieved | Review Required","status":"Achieved | Not Achieved | Review Required","confidenceScore":70,"rationale":"...","action":"...","evidencePage":"...","evidenceAndDepth":"...","evidenceTrace":[]}]}\n` +
              `Rules:\n` +
              `- Preserve one item per criterion.\n` +
              `- Use only the supplied criteria codes.\n` +
              `- Correct any overclaim conservatively.\n\n` +
              `Criteria:\n${JSON.stringify(criteria || [])}\n\n` +
              `Judged result:\n${JSON.stringify(judgedResult || {})}`,
          },
        ],
      },
    ],
  };

  const raw = await callGeminiText("gemini-2.5-flash-lite", body);
  return safeParse(raw) || {};
}

function buildAuditFromJudged(criteria, judged, validated) {
  const judgedAudit = Array.isArray(judged.audit) ? judged.audit : [];
  const validatedAudit = Array.isArray(validated.audit) ? validated.audit : [];

  return criteria.map(c => {
    const found = judgedAudit.find(a => cleanCriterionCode(a.id) === cleanCriterionCode(c.code)) || {};
    const vFound = validatedAudit.find(a => cleanCriterionCode(a.id) === cleanCriterionCode(c.code)) || {};

    return {
      id: c.code,
      requirement: c.requirement,
      status: normaliseStatus(found.status || vFound.status || "Review Required"),
      finalStatus: normaliseStatus(vFound.finalStatus || found.finalStatus || found.status || "Review Required"),
      evidencePage: String(vFound.evidencePage || found.evidencePage || "").trim(),
      evidenceAndDepth: String(vFound.evidenceAndDepth || found.evidenceAndDepth || "").trim(),
      rationale: String(vFound.rationale || found.rationale || "").trim(),
      action: String(vFound.action || found.action || "").trim(),
      confidenceScore: Number(vFound.confidenceScore ?? found.confidenceScore ?? 50),
      evidenceTrace: Array.isArray(vFound.evidenceTrace)
        ? vFound.evidenceTrace
        : (Array.isArray(found.evidenceTrace) ? found.evidenceTrace : []),
    };
  });
}

async function runAssessmentPipeline(payload) {
  const evidenceMap = await mapEvidenceWithGemini(payload);
  const judged = await judgeWithGemini(payload, evidenceMap);
  const validated = await validateWithGemini(payload.criteria || [], judged);

  const audit = buildAuditFromJudged(payload.criteria || [], judged, validated);

  return ensureRecordControl({
    fullName: judged.fullName || payload.fullName || "Learner Submission",
    grade: calculateOverallGrade(audit),
    audit,
    meta: {
      pipelineVersion: "multi-stage-v1",
      models: {
        scan: "gemini-2.5-flash",
        evidence: "gemini-2.5-flash-lite",
        judge: "gemini-2.5-flash",
        validate: "gemini-2.5-flash-lite",
      },
      generatedAt: new Date().toISOString(),
    },
    extractionTrace: {
      files: (payload.files || []).map(f => ({ filename: f.filename, role: f.role || "general" })),
      evidenceMap,
    },
  });
}

/* ================================
   AUTH
================================ */
async function getUserFromRequest(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new Error("Missing bearer token");

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new Error("Invalid or expired login");
  return data.user;
}

/* ================================
   ROUTES
================================ */
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/client-config", (_req, res) => {
  res.json({ logoUrl: CLIENT_LOGO_URL });
});

app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { filename, fileBase64 } = req.body || {};
    if (!filename || !fileBase64) {
      return jsonResponse(res, 400, { error: "filename and fileBase64 are required" });
    }

    const result = await scanBriefWithGemini({ filename, fileBase64 });
    return res.json({ result });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.post("/api/grade/submission", async (req, res) => {
  try {
    const files = Array.isArray(req.body.files) ? req.body.files : [];
    const criteria = Array.isArray(req.body.criteria) ? req.body.criteria : [];

    if (!files.length) return jsonResponse(res, 400, { error: "No files provided" });
    if (!criteria.length) return jsonResponse(res, 400, { error: "No criteria provided" });

    const result = await runAssessmentPipeline(req.body);
    return res.json({ result });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.post("/api/grade/submission-multi", async (req, res) => {
  try {
    const files = Array.isArray(req.body.files) ? req.body.files : [];
    const criteria = Array.isArray(req.body.criteria) ? req.body.criteria : [];

    if (!files.length) return jsonResponse(res, 400, { error: "No files provided" });
    if (!criteria.length) return jsonResponse(res, 400, { error: "No criteria provided" });

    const result = await runAssessmentPipeline(req.body);
    return res.json({ result });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.get("/api/records/list", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    const { data, error } = await supabase
      .from("feedback_records")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return res.json({ records: data || [] });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.post("/api/records/load", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];

    let query = supabase
      .from("feedback_records")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (ids.length) {
      query = query.in("id", ids);
    }

    const { data, error } = await query;
    if (error) throw error;

    const records = (data || []).map(r => ({
      ...r,
      data: { ...(r.data || {}), dbId: r.id },
    }));

    return res.json({ records });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.post("/api/records/save", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const result = ensureRecordControl(req.body.result || {});
    const unit = req.body.unit || "";

    const { data, error } = await supabase
      .from("feedback_records")
      .insert([
        {
          user_id: user.id,
          user_email: user.email,
          unit,
          learner_name: result.fullName || "Learner Submission",
          grade: result.grade || "",
          record_status: result.recordControl?.recordStatus || "Draft",
          data: result,
        },
      ])
      .select("id")
      .single();

    if (error) throw error;
    return res.json({ id: data.id });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.post("/api/records/update", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const { dbId, result } = req.body || {};
    if (!dbId || !result) {
      return jsonResponse(res, 400, { error: "dbId and result are required" });
    }

    const safeResult = ensureRecordControl(result);

    const { error } = await supabase
      .from("feedback_records")
      .update({
        learner_name: safeResult.fullName || "Learner Submission",
        grade: safeResult.grade || "",
        record_status: safeResult.recordControl?.recordStatus || "Draft",
        data: safeResult,
        updated_at: new Date().toISOString(),
      })
      .eq("id", dbId)
      .eq("user_id", user.id);

    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

/* ================================
   START
================================ */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
