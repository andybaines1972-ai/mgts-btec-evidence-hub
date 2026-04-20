const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun } = require("docx");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

/* ================================
   ENV
================================ */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const SCAN_MODELS = (process.env.GEMINI_SCAN_MODELS || "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-1.5-flash")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const GRADE_MODELS = (process.env.GEMINI_GRADE_MODELS || "gemini-2.5-flash,gemini-2.5-flash-lite,gemini-1.5-flash")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const VALIDATE_MODELS = (process.env.GEMINI_VALIDATE_MODELS || "gemini-2.5-flash-lite,gemini-1.5-flash")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const RETRIES = Number(process.env.GEMINI_RETRY_COUNT || 2);
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 90000);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("Missing Supabase env vars");
}
if (!GEMINI_API_KEY) {
  console.warn("Missing GEMINI_API_KEY");
}

/* ================================
   CLIENTS
================================ */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ================================
   HELPERS
================================ */
function jsonResponse(res, status, payload) {
  return res.status(status).json(payload);
}

function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(id),
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    try {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(text.slice(start, end + 1));
      }
    } catch (_) {}
    return null;
  }
}

function escapeCsv(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function normaliseStatus(value = "") {
  const v = String(value).trim().toLowerCase();
  if (v.includes("review")) return "Review Required";
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

async function getUserFromRequest(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new Error("Missing bearer token");

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new Error("Invalid or expired login");
  return data.user;
}

function buildInlineDataPart(file) {
  const mimeType =
    file.mimeType ||
    inferMimeType(file.filename || "") ||
    "application/octet-stream";

  return {
    inline_data: {
      mime_type: mimeType,
      data: file.fileBase64,
    },
  };
}

function inferMimeType(filename = "") {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function cleanAuditItem(item = {}, fallback = {}) {
  return {
    id: item.id || fallback.id || "",
    requirement: item.requirement || fallback.requirement || "",
    status: normaliseStatus(item.status || fallback.status || "Review Required"),
    finalStatus: normaliseStatus(item.finalStatus || item.status || fallback.finalStatus || fallback.status || "Review Required"),
    evidencePage: item.evidencePage || "",
    evidenceAndDepth: item.evidenceAndDepth || "",
    rationale: item.rationale || "",
    action: item.action || "",
    confidenceScore: Number(item.confidenceScore ?? 50),
    evidenceTrace: Array.isArray(item.evidenceTrace) ? item.evidenceTrace : [],
  };
}

function applyTutorOverride(result, tutorOverrideInput = "") {
  if (!tutorOverrideInput) return result;

  const lines = String(tutorOverrideInput).split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^([PMD]\d+)\s*=\s*(.+)$/i);
    if (!match) continue;

    const code = match[1].toUpperCase();
    const status = normaliseStatus(match[2]);

    const found = result.audit.find(a => String(a.id).toUpperCase() === code);
    if (found) found.finalStatus = status;
  }

  result.grade = calculateOverallGrade(result.audit);
  result.tutorOverrideInput = tutorOverrideInput;
  return result;
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
async function callGemini(model, body) {
  const timeout = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY,
        },
        body: JSON.stringify(body),
        signal: timeout.signal,
      }
    );

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.error?.message || `Gemini request failed for ${model}`);
    }

    const parts = json?.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text || "").join("").trim();
    if (!text) throw new Error(`Empty Gemini response from ${model}`);
    return text;
  } finally {
    timeout.clear();
  }
}

async function runModelCascade(models, body) {
  const attempts = [];

  for (const model of models) {
    for (let i = 0; i < RETRIES; i++) {
      try {
        const raw = await callGemini(model, body);
        const parsed = safeJsonParse(raw);
        if (parsed) {
          return { parsed, raw, model, attempts };
        }
        attempts.push({ model, try: i + 1, error: "Invalid JSON" });
      } catch (err) {
        attempts.push({ model, try: i + 1, error: err.message });
      }
    }
  }

  throw new Error(`All Gemini models failed: ${attempts.map(a => `${a.model}#${a.try}:${a.error}`).join(" | ")}`);
}

/* ================================
   PROMPTS
================================ */
function buildBriefScanRequest({ filename, fileBase64 }) {
  return {
    generationConfig: {
      responseMimeType: "application/json",
    },
    contents: [
      {
        parts: [
          {
            text:
              `You are extracting BTEC assessment criteria from an assignment brief.\n` +
              `Return only JSON in this shape:\n` +
              `{"criteria":[{"code":"P1","requirement":"..."},{"code":"M1","requirement":"..."}]}\n` +
              `Rules:\n` +
              `- Extract only valid assessment criteria.\n` +
              `- Codes should be like P1, P2, M1, D1.\n` +
              `- Remove duplicates.\n` +
              `- Keep requirement text concise but accurate.\n`,
          },
          buildInlineDataPart({ filename, fileBase64 }),
        ],
      },
    ],
  };
}

function buildGradeRequest(payload) {
  const criteriaText = JSON.stringify(payload.criteria || []);
  const fileSummary = (payload.files || [])
    .map((f, i) => `${i + 1}. ${f.filename} [role=${f.role || "general"}]`)
    .join("\n");

  const textPrompt =
    `You are a BTEC assessor generating criterion-level feedback.\n` +
    `Return only JSON in this shape:\n` +
    `{\n` +
    `  "fullName":"Learner Submission",\n` +
    `  "grade":"Achieved | Not Achieved | Review Required",\n` +
    `  "audit":[\n` +
    `    {\n` +
    `      "id":"P1",\n` +
    `      "requirement":"...",\n` +
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
    `- Use exactly these statuses: Achieved, Not Achieved, Review Required.\n` +
    `- Include one audit item for every criterion supplied.\n` +
    `- If evidence is weak or partial, prefer Review Required.\n` +
    `- Keep rationale and action practical and assessor-style.\n` +
    `- evidencePage should describe where the evidence is found.\n` +
    `- evidenceAndDepth should explain how the evidence meets or fails the criterion.\n` +
    `- confidenceScore should be 0-100.\n\n` +
    `Mode: ${payload.mode || "assessor"}\n` +
    `Unit: ${payload.unitInfo || ""}\n` +
    `Assessor: ${payload.assessorName || ""}\n` +
    `Tutor override guidance:\n${payload.tutorOverrideInput || "None"}\n\n` +
    `Criteria:\n${criteriaText}\n\n` +
    `Files:\n${fileSummary}`;

  return {
    generationConfig: {
      responseMimeType: "application/json",
    },
    contents: [
      {
        parts: [
          { text: textPrompt },
          ...(payload.files || []).map(buildInlineDataPart),
        ],
      },
    ],
  };
}

function buildValidateRequest(result, criteria) {
  return {
    generationConfig: {
      responseMimeType: "application/json",
    },
    contents: [
      {
        parts: [
          {
            text:
              `You are validating assessor feedback for consistency.\n` +
              `Return only JSON in this shape:\n` +
              `{"audit":[{"id":"P1","finalStatus":"Achieved | Not Achieved | Review Required","status":"Achieved | Not Achieved | Review Required","confidenceScore":70,"rationale":"...","action":"...","evidencePage":"...","evidenceAndDepth":"...","evidenceTrace":[]}]}\n` +
              `Rules:\n` +
              `- Preserve one item per criterion.\n` +
              `- Use only the supplied criteria codes.\n` +
              `- Normalise statuses to exactly Achieved, Not Achieved, Review Required.\n` +
              `- If an item looks inconsistent, correct it conservatively.\n\n` +
              `Criteria:\n${JSON.stringify(criteria || [])}\n\n` +
              `Result to validate:\n${JSON.stringify(result)}`,
          },
        ],
      },
    ],
  };
}

/* ================================
   AI WORKFLOWS
================================ */
async function scanBriefWithGemini(file) {
  const body = buildBriefScanRequest(file);
  const { parsed, model } = await runModelCascade(SCAN_MODELS, body);

  const rawCriteria = Array.isArray(parsed.criteria) ? parsed.criteria : [];
  const seen = new Set();
  const criteria = rawCriteria
    .map(c => ({
      code: String(c.code || "").toUpperCase().trim(),
      requirement: String(c.requirement || "").trim(),
    }))
    .filter(c => /^[PMD]\d+$/i.test(c.code) && c.requirement)
    .filter(c => {
      if (seen.has(c.code)) return false;
      seen.add(c.code);
      return true;
    });

  return { criteria, modelUsed: model };
}

async function gradeSubmissionWithGemini(payload) {
  const gradeBody = buildGradeRequest(payload);
  const { parsed, model } = await runModelCascade(GRADE_MODELS, gradeBody);

  const criteria = Array.isArray(payload.criteria) ? payload.criteria : [];
  const incomingAudit = Array.isArray(parsed.audit) ? parsed.audit : [];

  const audit = criteria.map(c => {
    const found = incomingAudit.find(a => String(a.id || "").toUpperCase() === String(c.code).toUpperCase());
    return cleanAuditItem(found || {}, { id: c.code, requirement: c.requirement });
  });

  let result = {
    fullName: parsed.fullName || "Learner Submission",
    grade: parsed.grade || calculateOverallGrade(audit),
    audit,
    modelUsed: model,
    tutorOverrideInput: payload.tutorOverrideInput || "",
  };

  try {
    const validateBody = buildValidateRequest(result, criteria);
    const { parsed: validated, model: validateModel } = await runModelCascade(VALIDATE_MODELS, validateBody);

    if (Array.isArray(validated.audit)) {
      result.audit = criteria.map(c => {
        const found = validated.audit.find(a => String(a.id || "").toUpperCase() === String(c.code).toUpperCase());
        return cleanAuditItem(found || {}, { id: c.code, requirement: c.requirement });
      });
      result.validationModelUsed = validateModel;
    }
  } catch (_) {
    // keep original graded result if validation fails
  }

  result = applyTutorOverride(result, payload.tutorOverrideInput || "");
  result.audit = result.audit.map(a => cleanAuditItem(a));
  result.grade = calculateOverallGrade(result.audit);
  return ensureRecordControl(result);
}

/* ================================
   DATABASE
================================ */
async function insertAuditEvent({ user, recordId = null, action, actorName = "", details = {} }) {
  const { error } = await supabase.from("audit_events").insert([
    {
      user_id: user.id,
      user_email: user.email,
      record_id: recordId,
      action,
      actor_name: actorName,
      details,
    },
  ]);
  if (error) throw error;
}

async function getRecordByIdForUser(recordId, userId) {
  const { data, error } = await supabase
    .from("feedback_records")
    .select("*")
    .eq("id", recordId)
    .eq("user_id", userId)
    .single();

  if (error) throw error;
  return data;
}

/* ================================
   ROUTES
================================ */
app.get("/health", (_req, res) => {
  res.json({ ok: true });
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

app.post("/api/grade/submission-multi", async (req, res) => {
  try {
    const files = Array.isArray(req.body.files) ? req.body.files : [];
    const criteria = Array.isArray(req.body.criteria) ? req.body.criteria : [];

    if (!files.length) return jsonResponse(res, 400, { error: "No files provided" });
    if (!criteria.length) return jsonResponse(res, 400, { error: "No criteria provided" });

    const result = await gradeSubmissionWithGemini(req.body);
    return res.json({ result });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.post("/api/records/save", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const unit = req.body.unit || "";
    const result = ensureRecordControl(req.body.result || {});

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

    await insertAuditEvent({
      user,
      recordId: data.id,
      action: "save",
      actorName: req.body.actorName || "",
      details: { unit },
    });

    return res.json({ id: data.id });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.post("/api/records/update", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const { dbId, result } = req.body || {};
    if (!dbId || !result) return jsonResponse(res, 400, { error: "dbId and result are required" });

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

    await insertAuditEvent({
      user,
      recordId: dbId,
      action: "update",
      actorName: req.body.actorName || "",
      details: {},
    });

    return res.json({ ok: true });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.post("/api/records/load", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    const { data, error } = await supabase
      .from("feedback_records")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

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

app.post("/api/records/action", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const { dbId, action, actorName = "" } = req.body || {};
    if (!dbId || !action) return jsonResponse(res, 400, { error: "dbId and action are required" });

    const record = await getRecordByIdForUser(dbId, user.id);
    const result = ensureRecordControl(record.data || {});
    const now = new Date().toISOString();

    switch (action) {
      case "sign_off":
        result.recordControl.recordStatus = "Signed Off";
        result.recordControl.assessorSignedOffAt = now;
        break;
      case "request_iv":
        result.recordControl.recordStatus = "IV Requested";
        result.recordControl.ivRequired = true;
        result.recordControl.ivDecision = "In progress";
        break;
      case "iv_approve":
        result.recordControl.recordStatus = "IV Approved";
        result.recordControl.ivRequired = true;
        result.recordControl.ivDecision = "Approved";
        break;
      case "iv_return":
        result.recordControl.recordStatus = "IV Returned";
        result.recordControl.ivRequired = true;
        result.recordControl.ivDecision = "Returned";
        break;
      case "release":
        result.recordControl.recordStatus = "Released";
        result.recordControl.releasedAt = now;
        break;
      default:
        return jsonResponse(res, 400, { error: "Unknown action" });
    }

    const { error } = await supabase
      .from("feedback_records")
      .update({
        record_status: result.recordControl.recordStatus,
        data: result,
        updated_at: now,
      })
      .eq("id", dbId)
      .eq("user_id", user.id);

    if (error) throw error;

    await insertAuditEvent({
      user,
      recordId: dbId,
      action,
      actorName,
      details: { recordStatus: result.recordControl.recordStatus },
    });

    return res.json({ record });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.get("/api/gdpr/export", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    const { data: records, error: recordsError } = await supabase
      .from("feedback_records")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (recordsError) throw recordsError;

    const { data: auditEvents, error: auditError } = await supabase
      .from("audit_events")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (auditError) throw auditError;

    return res.json({
      exportedAt: new Date().toISOString(),
      user: { id: user.id, email: user.email },
      records: records || [],
      auditEvents: auditEvents || [],
    });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.post("/api/gdpr/delete", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    const { error: auditError } = await supabase
      .from("audit_events")
      .delete()
      .eq("user_id", user.id);

    if (auditError) throw auditError;

    const { error: recordsError } = await supabase
      .from("feedback_records")
      .delete()
      .eq("user_id", user.id);

    if (recordsError) throw recordsError;

    return res.json({ ok: true });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.post("/api/export/feedback-docx", async (req, res) => {
  try {
    const result = req.body.result || {};
    const audit = Array.isArray(result.audit) ? result.audit : [];

    const rows = [
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph("Criteria")] }),
          new TableCell({ children: [new Paragraph("Requirement")] }),
          new TableCell({ children: [new Paragraph("Status")] }),
          new TableCell({ children: [new Paragraph("Evidence")] }),
        ],
      }),
      ...audit.map(item =>
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(item.id || "")] }),
            new TableCell({ children: [new Paragraph(item.requirement || "")] }),
            new TableCell({ children: [new Paragraph(item.finalStatus || item.status || "")] }),
            new TableCell({
              children: [
                new Paragraph(item.evidencePage || ""),
                new Paragraph(item.evidenceAndDepth || ""),
              ],
            }),
          ],
        })
      ),
    ];

    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              children: [new TextRun({ text: result.fullName || "Feedback Report", bold: true, size: 32 })],
            }),
            new Paragraph(`Overall Grade: ${result.grade || ""}`),
            new Paragraph(`Unit: ${req.body.unit || ""}`),
            new Paragraph(" "),
            new Table({ rows }),
          ],
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", 'attachment; filename="feedback.docx"');
    return res.send(buffer);
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.get("/api/export/iv-log", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const format = String(req.query.format || "csv").toLowerCase();

    const { data, error } = await supabase
      .from("audit_events")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const events = data || [];

    if (format === "json") {
      return res.json({ events });
    }

    const lines = [
      ["Record ID", "Action", "Actor", "Created At", "Details"].join(","),
      ...events.map(e =>
        [
          escapeCsv(e.record_id || ""),
          escapeCsv(e.action || ""),
          escapeCsv(e.actor_name || ""),
          escapeCsv(e.created_at || ""),
          escapeCsv(JSON.stringify(e.details || {})),
        ].join(",")
      ),
    ];

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="iv-log.csv"');
    return res.send(lines.join("\n"));
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

/* ================================
   START
================================ */
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
