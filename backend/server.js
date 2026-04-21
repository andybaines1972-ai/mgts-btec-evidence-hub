const express = require("express");
const cors = require("cors");
const mammoth = require("mammoth");
const JSZip = require("jszip");
const { createClient } = require("@supabase/supabase-js");
const {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  TextRun,
} = require("docx");

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

const BRIEF_MODELS = (process.env.GEMINI_BRIEF_MODELS || "gemini-2.5-flash,gemini-2.5-flash-lite")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const MAP_MODELS = (process.env.GEMINI_MAP_MODELS || "gemini-2.5-flash-lite,gemini-2.5-flash")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const JUDGE_MODELS = (process.env.GEMINI_JUDGE_MODELS || "gemini-2.5-flash,gemini-2.5-flash-lite")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const VALIDATE_MODELS = (process.env.GEMINI_VALIDATE_MODELS || "gemini-2.5-flash-lite,gemini-2.5-flash")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const RETRIES = Number(process.env.GEMINI_RETRY_COUNT || 2);
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 90000);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("Missing Supabase environment variables.");
}
if (!GEMINI_API_KEY) {
  console.warn("Missing GEMINI_API_KEY.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ================================
   CONSTANTS
================================ */
const RECORD_STATES = {
  DRAFT: "Draft",
  REVIEWED: "Assessor Reviewed",
  SIGNED_OFF: "Assessor Signed Off",
  IV_REQUIRED: "IV Required",
  IV_IN_REVIEW: "IV In Review",
  IV_RETURNED: "IV Returned",
  IV_APPROVED: "IV Approved",
  RELEASED: "Released"
};

const PROMPT_VERSIONS = {
  brief: "brief.v1",
  evidence: "evidence-map.v1",
  judgement: "judgement.v1",
  validation: "validation.v1"
};

/* ================================
   GENERIC HELPERS
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
      const str = String(text || "");
      const start = str.indexOf("{");
      const end = str.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(str.slice(start, end + 1));
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

function cleanCriterionCode(code = "") {
  return String(code).trim().toUpperCase().replace(/\s+/g, "");
}

function getBandFromCriterion(code = "") {
  const c = cleanCriterionCode(code);
  if (c.startsWith("P")) return "P";
  if (c.startsWith("M")) return "M";
  if (c.startsWith("D")) return "D";
  return "";
}

function detectVerbDepth(verbs = []) {
  const set = new Set((verbs || []).map(v => String(v).toLowerCase().trim()));

  if (set.has("evaluate") || set.has("justify")) return "evaluative";
  if (set.has("analyse") || set.has("analyze") || set.has("compare")) return "analytical";
  if (set.has("explain")) return "explanatory";
  if (set.has("describe")) return "descriptive";
  if (set.has("identify") || set.has("state") || set.has("outline")) return "surface";
  return "unknown";
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

function buildBandSummary(audit = []) {
  const summary = {
    P: { achieved: 0, reviewRequired: 0, notAchieved: 0, total: 0 },
    M: { achieved: 0, reviewRequired: 0, notAchieved: 0, total: 0 },
    D: { achieved: 0, reviewRequired: 0, notAchieved: 0, total: 0 }
  };

  for (const item of audit) {
    const band = getBandFromCriterion(item.id);
    if (!summary[band]) continue;

    summary[band].total += 1;
    const status = item.finalStatus || item.status || "Review Required";

    if (status === "Achieved") summary[band].achieved += 1;
    else if (status === "Not Achieved") summary[band].notAchieved += 1;
    else summary[band].reviewRequired += 1;
  }

  return summary;
}

function dedupeCriteria(criteria = []) {
  const seen = new Set();
  return (criteria || [])
    .map(item => ({
      code: cleanCriterionCode(item.code),
      requirement: String(item.requirement || "").trim(),
      band: item.band || getBandFromCriterion(item.code),
      linkedLearningAims: Array.isArray(item.linkedLearningAims) ? item.linkedLearningAims : [],
      linkedTasks: Array.isArray(item.linkedTasks) ? item.linkedTasks : [],
      commandVerbs: Array.isArray(item.commandVerbs) ? item.commandVerbs : [],
    }))
    .filter(item => /^[PMD]\d+$/i.test(item.code) && item.requirement)
    .filter(item => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    });
}

function cleanRiskFlags(value) {
  return Array.isArray(value) ? value.map(v => String(v).trim()).filter(Boolean) : [];
}

function defaultRecordControl() {
  return {
    recordStatus: RECORD_STATES.DRAFT,
    assessorReviewedAt: "",
    assessorReviewedBy: "",
    assessorSignedOffAt: "",
    assessorSignedOffBy: "",
    assessorInternalNotes: "",
    ivRequired: false,
    ivSampleReason: "",
    ivAssignedTo: "",
    ivStartedAt: "",
    ivDecision: "",
    ivDecisionAt: "",
    ivReviewerName: "",
    ivNotes: "",
    ivOutcomeCodes: [],
    releasedAt: "",
    releasedBy: "",
    releaseVersion: 1
  };
}

function ensureRecordControl(result) {
  if (!result.recordControl) {
    result.recordControl = defaultRecordControl();
  } else {
    result.recordControl = {
      ...defaultRecordControl(),
      ...result.recordControl
    };
  }
  return result;
}

function applyTutorOverride(result, tutorOverrideInput = "") {
  if (!tutorOverrideInput) return result;

  const lines = String(tutorOverrideInput).split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([PMD]\d+)\s*=\s*(.+)$/i);
    if (!match) continue;

    const code = cleanCriterionCode(match[1]);
    const status = normaliseStatus(match[2]);
    const found = (result.audit || []).find(a => cleanCriterionCode(a.id) === code);
    if (found) {
      found.finalStatus = status;
      found.riskFlags = Array.isArray(found.riskFlags) ? found.riskFlags : [];
      if (!found.riskFlags.includes("Tutor override applied")) {
        found.riskFlags.push("Tutor override applied");
      }
    }
  }

  result.grade = calculateOverallGrade(result.audit || []);
  result.tutorOverrideInput = tutorOverrideInput;
  return result;
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
   DATA SHAPES
================================ */
function emptyBriefInterpretation(filename = "") {
  return {
    unitTitle: "",
    unitNumber: "",
    qualificationLevel: "",
    guidedLearningHours: "",
    learningAims: [],
    tasks: [],
    criteria: [],
    commandVerbIndex: [],
    evidenceRequirements: [],
    assignmentContext: "",
    unitContext: "",
    ambiguityFlags: [],
    extractedFrom: filename,
    modelUsed: "",
    schemaVersion: PROMPT_VERSIONS.brief
  };
}

function emptyEvidenceMap() {
  return {
    items: [],
    summary: {
      totalCriteria: 0,
      mappedCriteria: 0,
      weaklyMappedCriteria: 0,
      unmappedCriteria: 0
    },
    modelUsed: "",
    schemaVersion: PROMPT_VERSIONS.evidence
  };
}

function emptyJudgement() {
  return {
    fullName: "Learner Submission",
    audit: [],
    overallBandSummary: {
      P: { achieved: 0, reviewRequired: 0, notAchieved: 0, total: 0 },
      M: { achieved: 0, reviewRequired: 0, notAchieved: 0, total: 0 },
      D: { achieved: 0, reviewRequired: 0, notAchieved: 0, total: 0 }
    },
    developmentalSummary: "",
    internalRisks: [],
    modelUsed: "",
    schemaVersion: PROMPT_VERSIONS.judgement
  };
}

function emptyValidation() {
  return {
    audit: [],
    warnings: [],
    downgradedCriteria: [],
    consistencyFlags: [],
    modelUsed: "",
    schemaVersion: PROMPT_VERSIONS.validation
  };
}

/* ================================
   FILE EXTRACTION
================================ */
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
      sourceType: mimeType === "application/pdf" ? "pdf_inline" : "image_inline",
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
      sourceType: "docx_text",
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
      sourceType: "pptx_text",
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
      sourceType: "txt_text",
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
    sourceType: "metadata_only",
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

  throw new Error(
    `All Gemini models failed: ${attempts.map(a => `${a.model}#${a.try}:${a.error}`).join(" | ")}`
  );
}

/* ================================
   PROMPT BUILDERS
================================ */
async function buildBriefInterpreterRequest(file) {
  const prepared = await toGeminiPart(file);

  return {
    generationConfig: {
      responseMimeType: "application/json"
    },
    contents: [
      {
        parts: [
          {
            text:
              `Interpret this BTEC assignment brief.\n` +
              `Return only JSON in this shape:\n` +
              `{\n` +
              `  "unitTitle":"",\n` +
              `  "unitNumber":"",\n` +
              `  "qualificationLevel":"",\n` +
              `  "guidedLearningHours":"",\n` +
              `  "learningAims":[{"id":"A","title":"","summary":""}],\n` +
              `  "tasks":[{"id":"Task 1","title":"","description":"","linkedLearningAims":["A"],"linkedCriteria":["P1"],"expectedEvidenceTypes":["report"]}],\n` +
              `  "criteria":[{"code":"P1","requirement":"","band":"P","linkedLearningAims":["A"],"linkedTasks":["Task 1"],"commandVerbs":["explain"]}],\n` +
              `  "commandVerbIndex":[{"criterionCode":"P1","verbs":["explain"],"expectedDepth":"explanatory"}],\n` +
              `  "evidenceRequirements":[""],\n` +
              `  "assignmentContext":"",\n` +
              `  "unitContext":"",\n` +
              `  "ambiguityFlags":[""],\n` +
              `  "extractedFrom":"${file.filename}"\n` +
              `}\n\n` +
              `Rules:\n` +
              `- Only valid P/M/D criteria.\n` +
              `- Auto-group criteria into P, M, D bands.\n` +
              `- Link criteria to learning aims where possible.\n` +
              `- Link criteria to tasks where possible.\n` +
              `- Detect command verbs such as explain, analyse, evaluate, justify, compare.\n` +
              `- Set expectedDepth based on the verbs.\n` +
              `- Add ambiguityFlags when mappings are unclear.\n` +
              `- Keep requirement text concise but accurate.\n`
          },
          prepared.part
        ]
      }
    ]
  };
}

async function buildEvidenceMapRequest(payload, briefInterpretation) {
  const preparedFiles = await prepareGeminiFileParts(payload.files || []);
  const fileSummary = preparedFiles.map((f, i) => `${i + 1}. ${f.summary}`).join("\n");

  return {
    generationConfig: {
      responseMimeType: "application/json"
    },
    contents: [
      {
        parts: [
          {
            text:
              `Map learner evidence against each criterion.\n` +
              `Return only JSON in this shape:\n` +
              `{\n` +
              `  "items":[\n` +
              `    {\n` +
              `      "criterionCode":"P1",\n` +
              `      "linkedLearningAims":["A"],\n` +
              `      "linkedTasks":["Task 1"],\n` +
              `      "expectedVerbs":["explain"],\n` +
              `      "evidence":[\n` +
              `        {\n` +
              `          "file":"submission.docx",\n` +
              `          "sourceType":"docx_text",\n` +
              `          "role":"report",\n` +
              `          "locator":"Paragraphs 3-5",\n` +
              `          "snippet":"...",\n` +
              `          "verbMatch":"explain",\n` +
              `          "depthLevel":"explanatory",\n` +
              `          "depthScore":72,\n` +
              `          "relevanceScore":80,\n` +
              `          "confidenceScore":79,\n` +
              `          "issues":[]\n` +
              `        }\n` +
              `      ],\n` +
              `      "gaps":[""],\n` +
              `      "mappingConfidence":75\n` +
              `    }\n` +
              `  ]\n` +
              `}\n\n` +
              `Rules:\n` +
              `- Include one item per criterion.\n` +
              `- Use locators wherever possible.\n` +
              `- Detect command-verb alignment.\n` +
              `- Use conservative confidence scores.\n` +
              `- Note evidence gaps where depth or relevance is weak.\n\n` +
              `Brief interpretation:\n${JSON.stringify(briefInterpretation)}\n\n` +
              `Files:\n${fileSummary}`
          },
          ...preparedFiles.map(f => f.part)
        ]
      }
    ]
  };
}

function buildJudgementRequest(payload, briefInterpretation, evidenceMap) {
  return {
    generationConfig: {
      responseMimeType: "application/json"
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
              `      "requirement":"...",\n` +
              `      "status":"Achieved | Not Achieved | Review Required",\n` +
              `      "finalStatus":"Achieved | Not Achieved | Review Required",\n` +
              `      "linkedLearningAims":["A"],\n` +
              `      "linkedTasks":["Task 1"],\n` +
              `      "commandVerbs":["explain"],\n` +
              `      "evidencePage":"...",\n` +
              `      "evidenceAndDepth":"...",\n` +
              `      "rationale":"...",\n` +
              `      "action":"...",\n` +
              `      "confidenceScore":68,\n` +
              `      "riskFlags":[""],\n` +
              `      "evidenceTrace":[]\n` +
              `    }\n` +
              `  ],\n` +
              `  "developmentalSummary":"",\n` +
              `  "internalRisks":[""]\n` +
              `}\n\n` +
              `Rules:\n` +
              `- Development points must always be written as how the work becomes stronger, deeper, clearer, more convincing, or more secure.\n` +
              `- Do not use direct achievement coaching like "to achieve P1".\n` +
              `- Use professional assessor language.\n` +
              `- If evidence depth does not match the command verb, prefer Review Required.\n` +
              `- Keep judgement evidence-led.\n` +
              `- Use one audit item per criterion.\n\n` +
              `Brief interpretation:\n${JSON.stringify(briefInterpretation)}\n\n` +
              `Evidence map:\n${JSON.stringify(evidenceMap)}\n\n` +
              `Assessment mode: ${payload.assessmentMode || ""}\n` +
              `Mode: ${payload.mode || "assessor"}\n` +
              `Unit info: ${payload.unitInfo || ""}\n` +
              `Tutor notes: ${payload.tutorLedCriteria || ""}\n` +
              `Full unit info: ${payload.fullUnitInfo || ""}`
          }
        ]
      }
    ]
  };
}

function buildValidationRequest(briefInterpretation, judgement) {
  return {
    generationConfig: {
      responseMimeType: "application/json"
    },
    contents: [
      {
        parts: [
          {
            text:
              `Validate this assessor judgement for consistency and overclaim risk.\n` +
              `Return only JSON in this shape:\n` +
              `{\n` +
              `  "audit":[\n` +
              `    {\n` +
              `      "id":"P1",\n` +
              `      "status":"Achieved | Not Achieved | Review Required",\n` +
              `      "finalStatus":"Achieved | Not Achieved | Review Required",\n` +
              `      "confidenceScore":70,\n` +
              `      "rationale":"...",\n` +
              `      "action":"...",\n` +
              `      "evidencePage":"...",\n` +
              `      "evidenceAndDepth":"...",\n` +
              `      "riskFlags":[""],\n` +
              `      "evidenceTrace":[]\n` +
              `    }\n` +
              `  ],\n` +
              `  "warnings":[""],\n` +
              `  "downgradedCriteria":["P1"],\n` +
              `  "consistencyFlags":[""]\n` +
              `}\n\n` +
              `Rules:\n` +
              `- Correct unsupported claims conservatively.\n` +
              `- Flag command-verb mismatch.\n` +
              `- Flag criteria judged too positively for the evidence depth.\n` +
              `- Preserve one item per criterion.\n\n` +
              `Brief interpretation:\n${JSON.stringify(briefInterpretation)}\n\n` +
              `Judgement:\n${JSON.stringify(judgement)}`
          }
        ]
      }
    ]
  };
}

/* ================================
   STAGE RUNNERS
================================ */
async function interpretBriefWithGemini(file) {
  const body = await buildBriefInterpreterRequest(file);
  const { parsed, model } = await runModelCascade(BRIEF_MODELS, body);

  const result = emptyBriefInterpretation(file.filename);
  result.unitTitle = String(parsed.unitTitle || "").trim();
  result.unitNumber = String(parsed.unitNumber || "").trim();
  result.qualificationLevel = String(parsed.qualificationLevel || "").trim();
  result.guidedLearningHours = String(parsed.guidedLearningHours || "").trim();
  result.learningAims = Array.isArray(parsed.learningAims) ? parsed.learningAims : [];
  result.tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  result.criteria = Array.isArray(parsed.criteria) ? parsed.criteria : [];
  result.commandVerbIndex = Array.isArray(parsed.commandVerbIndex) ? parsed.commandVerbIndex : [];
  result.evidenceRequirements = Array.isArray(parsed.evidenceRequirements) ? parsed.evidenceRequirements : [];
  result.assignmentContext = String(parsed.assignmentContext || "").trim();
  result.unitContext = String(parsed.unitContext || "").trim();
  result.ambiguityFlags = Array.isArray(parsed.ambiguityFlags) ? parsed.ambiguityFlags : [];
  result.extractedFrom = parsed.extractedFrom || file.filename;
  result.modelUsed = model;

  result.criteria = dedupeCriteria(result.criteria);
  result.commandVerbIndex = result.criteria.map(c => ({
    criterionCode: c.code,
    verbs: Array.isArray(c.commandVerbs) ? c.commandVerbs : [],
    expectedDepth: detectVerbDepth(c.commandVerbs || [])
  }));

  return result;
}

async function mapEvidenceWithGemini(payload, briefInterpretation) {
  const body = await buildEvidenceMapRequest(payload, briefInterpretation);
  const { parsed, model } = await runModelCascade(MAP_MODELS, body);

  const result = emptyEvidenceMap();
  result.items = Array.isArray(parsed.items) ? parsed.items : [];
  result.modelUsed = model;
  result.summary.totalCriteria = briefInterpretation.criteria.length;
  result.summary.mappedCriteria = result.items.filter(i => Array.isArray(i.evidence) && i.evidence.length).length;
  result.summary.weaklyMappedCriteria = result.items.filter(i => Number(i.mappingConfidence || 0) < 60).length;
  result.summary.unmappedCriteria = Math.max(0, result.summary.totalCriteria - result.summary.mappedCriteria);

  result.items = briefInterpretation.criteria.map(c => {
    const found = result.items.find(i => cleanCriterionCode(i.criterionCode) === c.code) || {};
    return {
      criterionCode: c.code,
      linkedLearningAims: Array.isArray(found.linkedLearningAims) ? found.linkedLearningAims : c.linkedLearningAims,
      linkedTasks: Array.isArray(found.linkedTasks) ? found.linkedTasks : c.linkedTasks,
      expectedVerbs: Array.isArray(found.expectedVerbs) ? found.expectedVerbs : c.commandVerbs,
      evidence: Array.isArray(found.evidence) ? found.evidence.map(ev => ({
        file: String(ev.file || ""),
        sourceType: String(ev.sourceType || ""),
        role: String(ev.role || ""),
        locator: String(ev.locator || ""),
        snippet: String(ev.snippet || ""),
        verbMatch: String(ev.verbMatch || ""),
        depthLevel: String(ev.depthLevel || ""),
        depthScore: Number(ev.depthScore || 0),
        relevanceScore: Number(ev.relevanceScore || 0),
        confidenceScore: Number(ev.confidenceScore || 0),
        issues: Array.isArray(ev.issues) ? ev.issues : []
      })) : [],
      gaps: Array.isArray(found.gaps) ? found.gaps.map(v => String(v).trim()).filter(Boolean) : [],
      mappingConfidence: Number(found.mappingConfidence || 0)
    };
  });

  return result;
}

async function judgeSubmissionWithGemini(payload, briefInterpretation, evidenceMap) {
  const body = buildJudgementRequest(payload, briefInterpretation, evidenceMap);
  const { parsed, model } = await runModelCascade(JUDGE_MODELS, body);

  const result = emptyJudgement();
  result.fullName = parsed.fullName || "Learner Submission";
  result.audit = Array.isArray(parsed.audit) ? parsed.audit : [];
  result.developmentalSummary = String(parsed.developmentalSummary || "").trim();
  result.internalRisks = Array.isArray(parsed.internalRisks) ? parsed.internalRisks : [];
  result.modelUsed = model;

  result.audit = briefInterpretation.criteria.map(c => {
    const found = result.audit.find(a => cleanCriterionCode(a.id) === c.code) || {};
    return {
      id: c.code,
      requirement: c.requirement,
      linkedLearningAims: Array.isArray(found.linkedLearningAims) ? found.linkedLearningAims : c.linkedLearningAims,
      linkedTasks: Array.isArray(found.linkedTasks) ? found.linkedTasks : c.linkedTasks,
      commandVerbs: Array.isArray(found.commandVerbs) ? found.commandVerbs : c.commandVerbs,
      status: normaliseStatus(found.status || "Review Required"),
      finalStatus: normaliseStatus(found.finalStatus || found.status || "Review Required"),
      evidencePage: String(found.evidencePage || "").trim(),
      evidenceAndDepth: String(found.evidenceAndDepth || "").trim(),
      rationale: String(found.rationale || "").trim(),
      action: String(found.action || "").trim(),
      confidenceScore: Number(found.confidenceScore || 50),
      riskFlags: cleanRiskFlags(found.riskFlags),
      evidenceTrace: Array.isArray(found.evidenceTrace) ? found.evidenceTrace : []
    };
  });

  result.overallBandSummary = buildBandSummary(result.audit);
  return result;
}

async function validateJudgementWithGemini(briefInterpretation, judgement) {
  const body = buildValidationRequest(briefInterpretation, judgement);
  const { parsed, model } = await runModelCascade(VALIDATE_MODELS, body);

  const result = emptyValidation();
  result.audit = Array.isArray(parsed.audit) ? parsed.audit : [];
  result.warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  result.downgradedCriteria = Array.isArray(parsed.downgradedCriteria) ? parsed.downgradedCriteria : [];
  result.consistencyFlags = Array.isArray(parsed.consistencyFlags) ? parsed.consistencyFlags : [];
  result.modelUsed = model;
  return result;
}

async function runAssessmentEngine(payload) {
  const briefInterpretation = payload.briefInterpretation && payload.briefInterpretation.criteria
    ? payload.briefInterpretation
    : emptyBriefInterpretation();

  const evidenceMap = await mapEvidenceWithGemini(payload, briefInterpretation);
  const judgement = await judgeSubmissionWithGemini(payload, briefInterpretation, evidenceMap);
  const validation = await validateJudgementWithGemini(briefInterpretation, judgement);

  const validatedAudit = briefInterpretation.criteria.map(c => {
    const judged = (judgement.audit || []).find(a => cleanCriterionCode(a.id) === c.code) || {};
    const checked = (validation.audit || []).find(a => cleanCriterionCode(a.id) === c.code) || {};

    return {
      id: c.code,
      requirement: c.requirement,
      linkedLearningAims: Array.isArray(judged.linkedLearningAims) ? judged.linkedLearningAims : c.linkedLearningAims,
      linkedTasks: Array.isArray(judged.linkedTasks) ? judged.linkedTasks : c.linkedTasks,
      commandVerbs: Array.isArray(judged.commandVerbs) ? judged.commandVerbs : c.commandVerbs,
      status: normaliseStatus(checked.status || judged.status || "Review Required"),
      finalStatus: normaliseStatus(checked.finalStatus || judged.finalStatus || judged.status || "Review Required"),
      evidencePage: String(checked.evidencePage || judged.evidencePage || "").trim(),
      evidenceAndDepth: String(checked.evidenceAndDepth || judged.evidenceAndDepth || "").trim(),
      rationale: String(checked.rationale || judged.rationale || "").trim(),
      action: String(checked.action || judged.action || "").trim(),
      confidenceScore: Number(checked.confidenceScore ?? judged.confidenceScore ?? 50),
      riskFlags: cleanRiskFlags(checked.riskFlags || judged.riskFlags),
      evidenceTrace: Array.isArray(checked.evidenceTrace)
        ? checked.evidenceTrace
        : (Array.isArray(judged.evidenceTrace) ? judged.evidenceTrace : [])
    };
  });

  const result = ensureRecordControl({
    fullName: judgement.fullName || payload.fullName || "Learner Submission",
    grade: calculateOverallGrade(validatedAudit),
    audit: validatedAudit,
    overallBandSummary: buildBandSummary(validatedAudit),
    developmentalSummary: judgement.developmentalSummary || "",
    internalRisks: [
      ...(Array.isArray(judgement.internalRisks) ? judgement.internalRisks : []),
      ...(Array.isArray(validation.warnings) ? validation.warnings : []),
      ...(Array.isArray(validation.consistencyFlags) ? validation.consistencyFlags : [])
    ],
    briefInterpretation,
    evidenceMap,
    validation,
    meta: {
      pipelineVersion: "assessor-hub.v1",
      models: {
        brief: briefInterpretation.modelUsed || "",
        evidence: evidenceMap.modelUsed || "",
        judgement: judgement.modelUsed || "",
        validation: validation.modelUsed || ""
      },
      promptVersions: PROMPT_VERSIONS,
      generatedAt: new Date().toISOString()
    }
  });

  return result;
}

/* ================================
   REVIEW / SIGN-OFF / IV
================================ */
function applyRecordAction(result, action, actorName = "", details = {}) {
  const now = new Date().toISOString();
  const rc = result.recordControl || defaultRecordControl();

  switch (action) {
    case "mark_reviewed":
      rc.recordStatus = RECORD_STATES.REVIEWED;
      rc.assessorReviewedAt = now;
      rc.assessorReviewedBy = actorName;
      if (details.assessorInternalNotes) rc.assessorInternalNotes = String(details.assessorInternalNotes);
      break;

    case "sign_off":
      rc.assessorSignedOffAt = now;
      rc.assessorSignedOffBy = actorName;
      rc.recordStatus = rc.ivRequired ? RECORD_STATES.IV_REQUIRED : RECORD_STATES.SIGNED_OFF;
      break;

    case "require_iv":
      rc.ivRequired = true;
      rc.ivSampleReason = String(details.ivSampleReason || "");
      rc.ivAssignedTo = String(details.ivAssignedTo || "");
      rc.recordStatus = RECORD_STATES.IV_REQUIRED;
      break;

    case "start_iv":
      rc.recordStatus = RECORD_STATES.IV_IN_REVIEW;
      rc.ivStartedAt = now;
      rc.ivReviewerName = actorName || String(details.ivReviewerName || "");
      break;

    case "return_from_iv":
      rc.recordStatus = RECORD_STATES.IV_RETURNED;
      rc.ivDecision = "Returned";
      rc.ivDecisionAt = now;
      rc.ivReviewerName = actorName || rc.ivReviewerName || "";
      rc.ivNotes = String(details.ivNotes || "");
      rc.ivOutcomeCodes = Array.isArray(details.ivOutcomeCodes) ? details.ivOutcomeCodes : [];
      break;

    case "approve_iv":
      rc.recordStatus = RECORD_STATES.IV_APPROVED;
      rc.ivDecision = "Approved";
      rc.ivDecisionAt = now;
      rc.ivReviewerName = actorName || rc.ivReviewerName || "";
      rc.ivNotes = String(details.ivNotes || "");
      rc.ivOutcomeCodes = Array.isArray(details.ivOutcomeCodes) ? details.ivOutcomeCodes : [];
      break;

    case "release":
      if (rc.ivRequired && rc.ivDecision !== "Approved") {
        throw new Error("IV approval is required before release.");
      }
      if (!rc.assessorSignedOffAt) {
        throw new Error("Assessor sign-off is required before release.");
      }
      rc.recordStatus = RECORD_STATES.RELEASED;
      rc.releasedAt = now;
      rc.releasedBy = actorName;
      rc.releaseVersion = Number(rc.releaseVersion || 1);
      break;

    case "reopen":
      rc.recordStatus = RECORD_STATES.DRAFT;
      rc.releasedAt = "";
      rc.releasedBy = "";
      break;

    default:
      throw new Error(`Unsupported action: ${action}`);
  }

  result.recordControl = rc;
  return result;
}

/* ================================
   DATABASE HELPERS
================================ */
async function insertAuditEvent({
  user,
  recordId = null,
  action,
  actorName = "",
  eventType = "",
  fromState = "",
  toState = "",
  reasonCode = "",
  promptVersion = "",
  modelName = "",
  details = {}
}) {
  const { error } = await supabase.from("audit_events").insert([
    {
      user_id: user.id,
      user_email: user.email,
      record_id: recordId,
      action,
      actor_name: actorName,
      event_type: eventType,
      from_state: fromState,
      to_state: toState,
      reason_code: reasonCode,
      prompt_version: promptVersion,
      model_name: modelName,
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

async function replaceEvidenceMapRows(recordId, evidenceMap) {
  await supabase.from("evidence_maps").delete().eq("record_id", recordId);

  const rows = [];
  for (const item of evidenceMap.items || []) {
    for (const ev of item.evidence || []) {
      rows.push({
        record_id: recordId,
        criterion_code: item.criterionCode || "",
        learning_aim_id: (item.linkedLearningAims || [])[0] || "",
        task_id: (item.linkedTasks || [])[0] || "",
        file_name: ev.file || "",
        source_type: ev.sourceType || "",
        file_role: ev.role || "",
        locator: ev.locator || "",
        excerpt: ev.snippet || "",
        verb_match: ev.verbMatch || "",
        depth_level: ev.depthLevel || "",
        depth_score: Number(ev.depthScore || 0),
        relevance_score: Number(ev.relevanceScore || 0),
        confidence_score: Number(ev.confidenceScore || 0),
        issues: Array.isArray(ev.issues) ? ev.issues : []
      });
    }
  }

  if (rows.length) {
    const { error } = await supabase.from("evidence_maps").insert(rows);
    if (error) throw error;
  }
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
        new TableCell({ children: [new Paragraph("Learning Aim")] }),
        new TableCell({ children: [new Paragraph("Task")] }),
        new TableCell({ children: [new Paragraph("Status")] }),
        new TableCell({ children: [new Paragraph("Rationale")] }),
        new TableCell({ children: [new Paragraph("Development")] }),
      ],
    }),
    ...((result.audit || []).map(item =>
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(String(item.id || ""))] }),
          new TableCell({ children: [new Paragraph(String(item.requirement || ""))] }),
          new TableCell({ children: [new Paragraph((item.linkedLearningAims || []).join(", "))] }),
          new TableCell({ children: [new Paragraph((item.linkedTasks || []).join(", "))] }),
          new TableCell({ children: [new Paragraph(String(item.finalStatus || item.status || ""))] }),
          new TableCell({ children: [new Paragraph(String(item.rationale || ""))] }),
          new TableCell({ children: [new Paragraph(String(item.action || ""))] }),
        ],
      })
    )),
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
          new Paragraph(`Record Status: ${result.recordControl?.recordStatus || ""}`),
          new Paragraph(""),
          new Table({ rows }),
          new Paragraph(""),
          new Paragraph({
            children: [new TextRun({ text: "Developmental Summary", bold: true })]
          }),
          new Paragraph(String(result.developmentalSummary || "")),
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

    const result = await interpretBriefWithGemini({ filename, fileBase64 });
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

    const payload = { ...req.body };

    if (!payload.briefInterpretation || !Array.isArray(payload.briefInterpretation.criteria) || !payload.briefInterpretation.criteria.length) {
      payload.briefInterpretation = {
        ...emptyBriefInterpretation(),
        criteria: dedupeCriteria(criteria)
      };
    }

    let result = await runAssessmentEngine(payload);
    result = applyTutorOverride(result, payload.tutorOverrideInput || "");

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

    const payload = { ...req.body };

    if (!payload.briefInterpretation || !Array.isArray(payload.briefInterpretation.criteria) || !payload.briefInterpretation.criteria.length) {
      payload.briefInterpretation = {
        ...emptyBriefInterpretation(),
        criteria: dedupeCriteria(criteria)
      };
    }

    let result = await runAssessmentEngine(payload);
    result = applyTutorOverride(result, payload.tutorOverrideInput || "");

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
          record_status: result.recordControl?.recordStatus || RECORD_STATES.DRAFT,
          pipeline_version: result.meta?.pipelineVersion || "",
          schema_version: result.meta?.promptVersions ? "assessor-hub.v1" : "",
          brief_model: result.meta?.models?.brief || "",
          judge_model: result.meta?.models?.judgement || "",
          validate_model: result.meta?.models?.validation || "",
          release_version: Number(result.recordControl?.releaseVersion || 1),
          data: result,
        },
      ])
      .select("id")
      .single();

    if (error) throw error;

    if (result.evidenceMap) {
      await replaceEvidenceMapRows(data.id, result.evidenceMap);
    }

    await insertAuditEvent({
      user,
      recordId: data.id,
      action: "save",
      actorName: req.body.actorName || "",
      eventType: "record_saved",
      toState: result.recordControl?.recordStatus || RECORD_STATES.DRAFT,
      promptVersion: JSON.stringify(result.meta?.promptVersions || {}),
      modelName: JSON.stringify(result.meta?.models || {}),
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
        record_status: safeResult.recordControl?.recordStatus || RECORD_STATES.DRAFT,
        pipeline_version: safeResult.meta?.pipelineVersion || "",
        schema_version: safeResult.meta?.promptVersions ? "assessor-hub.v1" : "",
        brief_model: safeResult.meta?.models?.brief || "",
        judge_model: safeResult.meta?.models?.judgement || "",
        validate_model: safeResult.meta?.models?.validation || "",
        release_version: Number(safeResult.recordControl?.releaseVersion || 1),
        data: safeResult,
        updated_at: new Date().toISOString(),
      })
      .eq("id", dbId)
      .eq("user_id", user.id);

    if (error) throw error;

    if (safeResult.evidenceMap) {
      await replaceEvidenceMapRows(dbId, safeResult.evidenceMap);
    }

    await insertAuditEvent({
      user,
      recordId: dbId,
      action: "update",
      actorName: req.body.actorName || "",
      eventType: "record_updated",
      toState: safeResult.recordControl?.recordStatus || RECORD_STATES.DRAFT,
      promptVersion: JSON.stringify(safeResult.meta?.promptVersions || {}),
      modelName: JSON.stringify(safeResult.meta?.models || {}),
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

app.post("/api/records/action", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const { dbId, action, actorName = "", details = {} } = req.body || {};
    if (!dbId || !action) return jsonResponse(res, 400, { error: "dbId and action are required" });

    const record = await getRecordByIdForUser(dbId, user.id);
    const result = ensureRecordControl(record.data || {});
    const fromState = result.recordControl.recordStatus || RECORD_STATES.DRAFT;

    applyRecordAction(result, action, actorName, details);

    const { error } = await supabase
      .from("feedback_records")
      .update({
        record_status: result.recordControl.recordStatus,
        release_version: Number(result.recordControl.releaseVersion || 1),
        data: result,
        updated_at: new Date().toISOString()
      })
      .eq("id", dbId)
      .eq("user_id", user.id);

    if (error) throw error;

    await insertAuditEvent({
      user,
      recordId: dbId,
      action,
      actorName,
      eventType: "workflow_transition",
      fromState,
      toState: result.recordControl.recordStatus,
      details
    });

    return res.json({ ok: true, recordStatus: result.recordControl.recordStatus });
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
      ["IV Required", String(Boolean(result.recordControl?.ivRequired))],
      ["IV Decision", result.recordControl?.ivDecision || ""],
      [],
      ["Criterion", "Requirement", "Learning Aim", "Task", "Status", "Rationale", "Development"],
      ...((result.audit || []).map(item => [
        item.id || "",
        item.requirement || "",
        (item.linkedLearningAims || []).join("; "),
        (item.linkedTasks || []).join("; "),
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

    const { data: evidenceRows, error: evidenceError } = await supabase
      .from("evidence_maps")
      .select("*")
      .in("record_id", (records || []).map(r => r.id));

    if (evidenceError) throw evidenceError;

    return res.json({
      user: { id: user.id, email: user.email },
      feedback_records: records || [],
      audit_events: events || [],
      evidence_maps: evidenceRows || [],
    });
  } catch (err) {
    return jsonResponse(res, 500, { error: err.message });
  }
});

app.post("/api/gdpr/delete", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    const { data: records, error: recordsLookupError } = await supabase
      .from("feedback_records")
      .select("id")
      .eq("user_id", user.id);

    if (recordsLookupError) throw recordsLookupError;

    const recordIds = (records || []).map(r => r.id);

    if (recordIds.length) {
      const { error: evidenceError } = await supabase
        .from("evidence_maps")
        .delete()
        .in("record_id", recordIds);

      if (evidenceError) throw evidenceError;
    }

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

/* ================================
   START
================================ */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
