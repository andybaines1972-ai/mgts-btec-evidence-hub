const express = require("express");
const cors = require("cors");
const mammoth = require("mammoth");
const JSZip = require("jszip");
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
const CLIENT_LOGO_URL = process.env.CLIENT_LOGO_URL || "";
const PORT = Number(process.env.PORT || 3000);

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
      const start = String(text || "").indexOf("{");
      const end = String(text || "").lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(String(text).slice(start, end + 1));
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

async function getUserFromRequest(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new Error("Missing bearer token");

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) throw new Error("Invalid or expired login");
  return data.user;
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

function isImageMime(mimeType = "") {
  return ["image/png", "image/jpeg", "image/webp"].includes(mimeType);
}

function isInlineSupportedMimeForGemini(mimeType = "") {
  return mimeType === "application/pdf" || isImageMime(mimeType);
}

async function extractTextFromDocxBase64(fileBase64) {
  const buffer = Buffer.from(fileBase64, "base64");
  const result = await mammoth.extractRawText({ buffer });
  return String(result.value || "").trim();
}

async function extractTextFromTxtBase64(fileBase64) {
  return Buffer.from(fileBase64, "base64").toString("utf8");
}

async function extractTextFromPptxBase64(fileBase64) {
  const buffer = Buffer.from(fileBase64, "base64");
  const zip = await JSZip.loadAsync(buffer);

  const slidePaths = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const aNum = Number((a.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      const bNum = Number((b.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      return aNum - bNum;
    });

  const slides = [];
  for (const path of slidePaths) {
    const xml = await zip.files[path].async("string");
    const matches = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)];
    const text = matches
      .map(m => m[1])
      .map(t =>
        t
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    const slideNo = Number((path.match(/slide(\d+)\.xml/i) || [])[1] || slides.length + 1);
    if (text) slides.push(`Slide ${slideNo}: ${text}`);
  }

  return slides.join("\n\n").trim();
}

async function toGeminiPart(file) {
  const mimeType = file.mimeType || inferMimeType(file.filename || "");

  if (isInlineSupportedMimeForGemini(mimeType)) {
    return {
      kind: "inline",
      part: {
        inline_data: {
          mime_type: mimeType,
          data: file.fileBase64,
        },
      },
      summary: `${file.filename} [${file.role || "general"}] sent as inline ${mimeType}`,
    };
  }

  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const text = await extractTextFromDocxBase64(file.fileBase64);
    return {
      kind: "text",
      part: {
        text:
          `FILE: ${file.filename}\n` +
          `ROLE: ${file.role || "general"}\n` +
          `TYPE: DOCX extracted text\n\n` +
          (text || "[No extractable text found]"),
      },
      summary: `${file.filename} [${file.role || "general"}] converted from DOCX to text`,
    };
  }

  if (mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    const text = await extractTextFromPptxBase64(file.fileBase64);
    return {
      kind: "text",
      part: {
        text:
          `FILE: ${file.filename}\n` +
          `ROLE: ${file.role || "general"}\n` +
          `TYPE: PPTX extracted slide text\n\n` +
          (text || "[No extractable slide text found]"),
      },
      summary: `${file.filename} [${file.role || "general"}] converted from PPTX to text`,
    };
  }

  if (mimeType === "text/plain") {
    const text = await extractTextFromTxtBase64(file.fileBase64);
    return {
      kind: "text",
      part: {
        text:
          `FILE: ${file.filename}\n` +
          `ROLE: ${file.role || "general"}\n` +
          `TYPE: TXT plain text\n\n` +
          (text || "[Empty text file]"),
      },
      summary: `${file.filename} [${file.role || "general"}] included as plain text`,
    };
  }

  return {
    kind: "text",
    part: {
      text:
        `FILE: ${file.filename}\n` +
        `ROLE: ${file.role || "general"}\n` +
        `TYPE: Unsupported inline MIME (${mimeType})\n` +
        `NOTE: This file type was not sent as binary. Review manually if needed.`,
    },
    summary: `${file.filename} [${file.role || "general"}] fell back to metadata note only`,
  };
}

async function prepareGeminiFileParts(files = []) {
  const prepared = [];
  for (const file of files) {
    prepared.push(await toGeminiPart(file));
  }
  return prepared;
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
    console.log("GEMINI STATUS:", res.status);
    console.log("GEMINI JSON:", JSON.stringify(json));

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
async function buildBriefScanRequest({ filename, fileBase64 }) {
  const mimeType = inferMimeType(filename);

  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const extractedText = await extractTextFromDocxBase64(fileBase64);
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
                `{"criteria":[{"code":"P1","requirement":"..."}],"unit_context":"...","assignment_context":"...","evidence_requirements":["..."],"extracted_from":"${filename}"}\n` +
                `Rules:\n` +
                `- Extract only valid assessment criteria.\n` +
                `- Codes should be like P1, P2, M1, D1.\n` +
                `- Remove duplicates.\n` +
                `- Keep requirement text concise but accurate.\n\n` +
                `Brief text:\n${extractedText}`,
            },
          ],
        },
      ],
    };
  }

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
              `{"criteria":[{"code":"P1","requirement":"..."}],"unit_context":"...","assignment_context":"...","evidence_requirements":["..."],"extracted_from":"${filename}"}\n` +
              `Rules:\n` +
              `- Extract only valid assessment criteria.\n` +
              `- Codes should be like P1, P2, M1, D1.\n` +
              `- Remove duplicates.\n` +
              `- Keep requirement text concise but accurate.\n`,
          },
          {
            inline_data: {
              mime_type: mimeType,
              data: fileBase64,
            },
          },
        ],
      },
    ],
  };
}

async function buildGradeRequest(payload) {
  const criteriaText = JSON.stringify(payload.criteria || []);
  const preparedFiles = await prepareGeminiFileParts(payload.files || []);
  const fileSummary = preparedFiles.map((f, i) => `${i + 1}. ${f.summary}`).join("\n");

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
    `Assessment Mode: ${payload.assessmentMode || ""}\n` +
    `Unit: ${payload.unitInfo || ""}\n` +
    `Assessor: ${payload.assessorName || ""}\n` +
    `Tutor-led Notes: ${payload.tutorLedCriteria || ""}\n` +
    `Full Unit Information: ${payload.fullUnitInfo || ""}\n` +
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
          ...preparedFiles.map(f => f.part),
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
  const body = await buildBriefScanRequest(file);
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

  return {
    criteria,
    unit_context: String(parsed.unit_context || "").trim(),
    assignment_context: String(parsed.assignment_context || "").trim(),
    evidence_requirements: Array.isArray(parsed.evidence_requirements)
      ? parsed.evidence_requirements.map(v => String(v).trim()).filter(Boolean)
      : [],
    extracted_from: parsed.extracted_from || file.filename,
    modelUsed: model
  };
}

async function gradeSubmissionWithGemini(payload) {
  const gradeBody = await buildGradeRequest(payload);
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
   EXPORT HELPERS
================================ */
function buildFeedbackDoc(result) {
  const rows = [
    new TableRow({
      children: [
        new TableCell({ children: [new Paragraph("Criterion")] }),
        new TableCell({ children: [new Paragraph("Requirement")] }),
        new TableCell({ children: [new Paragraph("Status")] }),
        new TableCell({ children: [new Paragraph("Rationale")] }),
        new TableCell({ children: [new Paragraph("Action")] }),
      ],
    }),
    ...(result.audit || []).map(item =>
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(String(item.id || ""))] }),
          new TableCell({ children: [new Paragraph(String(item.requirement || ""))] }),
          new TableCell({ children: [new Paragraph(String(item.finalStatus || item.status || ""))] }),
          new TableCell({ children: [new Paragraph(String(item.rationale || ""))] }),
          new TableCell({ children: [new Paragraph(String(item.action || ""))] }),
        ],
      })
    ),
  ];

  return new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun({ text: "MGTS BTEC Feedback Record", bold: true, size: 28 })],
          }),
          new Paragraph(`Learner: ${result.fullName || "Learner Submission"}`),
          new Paragraph(`Overall Grade: ${result.grade || ""}`),
          new Paragraph(""),
          new Table({ rows }),
        ],
      },
    ],
  });
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

    const result = await gradeSubmissionWithGemini(req.body);
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

app.post("/api/export/feedback-docx", async (req, res) => {
  try {
    const result = req.body.result || {};
    const doc = buildFeedbackDoc(result);
    const buffer = await Packer.toBuffer(doc);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="feedback-${Date.now()}.docx"`);
    return res.send(buffer);
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.post("/api/export/iv-log", async (req, res) => {
  try {
    const result = req.body.result || {};
    const rows = [
      ["Learner", result.fullName || ""],
      ["Grade", result.grade || ""],
      ["Record Status", result.recordControl?.recordStatus || ""],
      [],
      ["Criterion", "Requirement", "Status", "Rationale", "Action"],
      ...((result.audit || []).map(item => [
        item.id || "",
        item.requirement || "",
        item.finalStatus || item.status || "",
        item.rationale || "",
        item.action || ""
      ]))
    ];

    const csv = rows.map(row => row.map(escapeCsv).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="iv-log-${Date.now()}.csv"`);
    return res.send(csv);
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.post("/api/gdpr/export", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    const { data: records, error: recordsError } = await supabase
      .from("feedback_records")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (recordsError) throw recordsError;

    const { data: events, error: eventsError } = await supabase
      .from("audit_events")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (eventsError) throw eventsError;

    return res.json({
      user: { id: user.id, email: user.email },
      feedback_records: records || [],
      audit_events: events || [],
    });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.post("/api/gdpr/delete", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    const { error: recordsError } = await supabase
      .from("feedback_records")
      .delete()
      .eq("user_id", user.id);

    if (recordsError) throw recordsError;

    const { error: eventsError } = await supabase
      .from("audit_events")
      .delete()
      .eq("user_id", user.id);

    if (eventsError) throw eventsError;

    return res.json({ ok: true });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
