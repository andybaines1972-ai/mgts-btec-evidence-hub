import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mammoth from "mammoth";
import pdf from "pdf-parse";
import JSZip from "jszip";
import Tesseract from "tesseract.js";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "120mb" }));

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "";

const LOGO_URL =
  process.env.LOGO_URL ||
  "https://www.mgts.co.uk/wp-content/themes/mgts/images/svg/logo.svg";

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      })
    : null;

const supabaseAuth =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      })
    : null;

/* =========================================================
   STARTUP INFO
========================================================= */

console.log("Server booting...");
console.log("SUPABASE_URL:", SUPABASE_URL ? "set" : "missing");
console.log("SUPABASE_ANON_KEY:", SUPABASE_ANON_KEY ? "set" : "missing");
console.log("SUPABASE_SERVICE_KEY:", SUPABASE_SERVICE_KEY ? "set" : "missing");
console.log("OPENAI_API_KEY:", OPENAI_API_KEY ? "set" : "missing");

/* =========================================================
   GENERAL HELPERS
========================================================= */

function safeString(value = "") {
  return String(value ?? "").trim();
}

function normalizeWhitespace(text = "") {
  return safeString(text)
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ");
}

function splitParagraphs(text = "") {
  return normalizeWhitespace(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function normalizeCriterionCode(code = "") {
  return safeString(code).toUpperCase().replace(/\s+/g, "");
}

function tokenize(text = "") {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
}

function unique(arr) {
  return [...new Set(arr)];
}

function intersectionCount(a, b) {
  const bSet = new Set(b);
  let count = 0;
  for (const token of a) {
    if (bSet.has(token)) count++;
  }
  return count;
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function sentenceSplit(text = "") {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function summarizeSnippet(text = "", maxLen = 240) {
  const clean = normalizeWhitespace(text).replace(/\n/g, " ");
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen - 1).trim()}…`;
}

function nowIso() {
  return new Date().toISOString();
}

function nowUkString() {
  return new Date().toLocaleString("en-GB");
}

function inferFileRole(filename = "") {
  const name = filename.toLowerCase();
  if (name.endsWith(".pptx") || name.includes("presentation") || name.includes("slides")) return "presentation";
  if (name.includes("notes") || name.includes("speaker")) return "notes";
  if (name.includes("report")) return "report";
  if (name.includes("appendix")) return "appendix";
  if (name.includes("evidence")) return "evidence";
  if (name.includes("brief")) return "brief";
  return "general";
}

function inferFileRoleFromMeta(file = {}) {
  const explicit = safeString(file.role).toLowerCase();
  if (explicit && explicit !== "auto") return explicit;
  return inferFileRole(safeString(file.filename));
}

function getDefaultRecordControl() {
  return {
    recordStatus: "Draft",
    assessorSignedOffBy: "",
    assessorSignedOffAt: "",
    assessorInternalNotes: "",
    ivRequired: false,
    ivStartedAt: "",
    ivReviewerName: "",
    ivDecision: "",
    ivDecisionAt: "",
    ivInternalNotes: "",
    releasedAt: "",
    releasedBy: "",
    markedForReview: false,
    markedForReviewAt: "",
    markedForReviewReason: ""
  };
}

function ensureRecordControl(result = {}) {
  return {
    ...getDefaultRecordControl(),
    ...(result.recordControl || {})
  };
}

function buildAuditEvent(action, actorName = "", notes = "", payload = {}) {
  return {
    action,
    actor_name: safeString(actorName),
    notes: safeString(notes),
    payload_json: payload,
    created_at: nowIso()
  };
}

/* =========================================================
   AUTH
========================================================= */

async function getUserFromRequest(req) {
  try {
    if (!supabaseAuth) return null;
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return null;

    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error) return null;
    return data?.user || null;
  } catch {
    return null;
  }
}

function requireAuth(handler) {
  return async (req, res) => {
    const user = await getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    req.user = user;
    return handler(req, res);
  };
}

/* =========================================================
   FILE EXTRACTION
========================================================= */

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return {
    text: normalizeWhitespace(result.value || ""),
    sections: splitParagraphs(result.value || "").map((text, idx) => ({
      locator: `paragraph ${idx + 1}`,
      text
    }))
  };
}

async function extractPdf(buffer) {
  const result = await pdf(buffer);
  const text = normalizeWhitespace(result.text || "");
  return {
    text,
    sections: splitParagraphs(text).map((text, idx) => ({
      locator: `section ${idx + 1}`,
      text
    }))
  };
}

function decodeXmlText(xml = "") {
  return xml
    .replace(/<a:br\/>/g, "\n")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const sections = [];

  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const an = Number(a.match(/slide(\d+)/)?.[1] || 0);
      const bn = Number(b.match(/slide(\d+)/)?.[1] || 0);
      return an - bn;
    });

  for (const slidePath of slideFiles) {
    const slideNum = Number(slidePath.match(/slide(\d+)/)?.[1] || 0);
    const slideXml = await zip.files[slidePath].async("text");
    const slideText = decodeXmlText(slideXml);

    if (slideText) {
      sections.push({ locator: `slide ${slideNum}`, text: slideText });
    }

    const notesPath = `ppt/notesSlides/notesSlide${slideNum}.xml`;
    if (zip.files[notesPath]) {
      const notesXml = await zip.files[notesPath].async("text");
      const notesText = decodeXmlText(notesXml);
      if (notesText) {
        sections.push({ locator: `slide ${slideNum} notes`, text: notesText });
      }
    }
  }

  return {
    text: sections.map((s) => `[${s.locator}] ${s.text}`).join("\n\n"),
    sections
  };
}

async function extractTxt(buffer) {
  const text = normalizeWhitespace(buffer.toString("utf-8"));
  return {
    text,
    sections: splitParagraphs(text).map((text, idx) => ({
      locator: `section ${idx + 1}`,
      text
    }))
  };
}

async function extractImage(buffer) {
  const result = await Tesseract.recognize(buffer, "eng");
  const text = normalizeWhitespace(result.data?.text || "");
  return {
    text,
    sections: splitParagraphs(text).map((text, idx) => ({
      locator: `ocr block ${idx + 1}`,
      text
    }))
  };
}

async function extractTextFromFile(file) {
  const buffer = Buffer.from(file.fileBase64, "base64");
  const filename = safeString(file.filename);
  const lower = filename.toLowerCase();
  const role = inferFileRoleFromMeta(file);

  try {
    if (lower.endsWith(".docx")) {
      const out = await extractDocx(buffer);
      return { filename, role, kind: "docx", ...out };
    }
    if (lower.endsWith(".pdf")) {
      const out = await extractPdf(buffer);
      return { filename, role, kind: "pdf", ...out };
    }
    if (lower.endsWith(".pptx")) {
      const out = await extractPptx(buffer);
      return { filename, role, kind: "pptx", ...out };
    }
    if (lower.endsWith(".txt")) {
      const out = await extractTxt(buffer);
      return { filename, role, kind: "txt", ...out };
    }
    if (/\.(png|jpg|jpeg|webp)$/i.test(lower)) {
      const out = await extractImage(buffer);
      return { filename, role, kind: "image", ...out };
    }

    return { filename, role, kind: "unsupported", text: "", sections: [] };
  } catch (error) {
    console.error(`Extraction failed for ${filename}:`, error);
    return { filename, role, kind: "error", text: "", sections: [] };
  }
}

/* =========================================================
   BRIEF SCAN / CRITERIA PARSING
========================================================= */

function parseCriteriaFromText(text = "") {
  const lines = normalizeWhitespace(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const results = [];
  const seen = new Set();

  for (const line of lines) {
    const match = line.match(/^([PMD]\d+)\s*[:\-–—]?\s+(.+)$/i);
    if (!match) continue;

    const code = normalizeCriterionCode(match[1]);
    const requirement = safeString(match[2]);

    const looksLikeGuidance =
      requirement.length > 220 ||
      /\b(learners|evidence will come from|might best be obtained|logbook|written report itself|to achieve|criterion\.)\b/i.test(requirement);

    if (!code || !requirement || looksLikeGuidance || seen.has(code)) continue;

    seen.add(code);
    results.push({ code, requirement });
  }

  return results;
}

function inferUnitContext(text = "") {
  return normalizeWhitespace(text)
    .split(/\n+/)
    .filter((line) => /^LO\d+/i.test(line.trim()))
    .slice(0, 10)
    .join("\n");
}

function inferEvidenceRequirements(text = "") {
  return normalizeWhitespace(text)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((line) =>
      /(presentation|report|notes|research|references|citation|evidence|diagram|example|process|plan)/i.test(line)
    )
    .slice(0, 12);
}

/* =========================================================
   EVIDENCE INDEX
========================================================= */

function chunkSectionText(sectionText = "", maxSentences = 3) {
  const sentences = sentenceSplit(sectionText);
  if (!sentences.length) return [];
  if (sentences.length <= maxSentences) return [sectionText];

  const chunks = [];
  for (let i = 0; i < sentences.length; i += maxSentences) {
    chunks.push(sentences.slice(i, i + maxSentences).join(" "));
  }
  return chunks;
}

function buildEvidenceIndex(extractedFiles = []) {
  const chunks = [];

  for (const file of extractedFiles) {
    if (!file.sections?.length && file.text) {
      chunkSectionText(file.text, 4).forEach((chunkText, idx) => {
        chunks.push({
          file: file.filename,
          role: file.role,
          locator: `block ${idx + 1}`,
          text: chunkText,
          tokens: tokenize(chunkText)
        });
      });
      continue;
    }

    (file.sections || []).forEach((section) => {
      const parts = chunkSectionText(section.text, 3);
      parts.forEach((chunkText, idx) => {
        chunks.push({
          file: file.filename,
          role: file.role,
          locator: parts.length > 1 ? `${section.locator}, part ${idx + 1}` : section.locator,
          text: chunkText,
          tokens: tokenize(chunkText)
        });
      });
    });
  }

  return chunks;
}

function roleBonus(requirement = "", role = "") {
  const req = requirement.toLowerCase();
  if (role === "presentation" && /(tool|technique|business performance|justify|presentation)/i.test(req)) return 10;
  if (role === "notes" && /(justify|explain|analysis|verbal|discussion)/i.test(req)) return 7;
  if (role === "report" && /(cost|costing|process|plan|develop|taguchi|report)/i.test(req)) return 10;
  if (role === "appendix" && /(evidence|support|example)/i.test(req)) return 4;
  return 0;
}

function scoreChunkAgainstCriterion(chunk, criterion) {
  const criterionTokens = unique(tokenize(criterion.requirement));
  const overlap = intersectionCount(criterionTokens, chunk.tokens);
  const coverage = criterionTokens.length ? overlap / criterionTokens.length : 0;
  const exactBonus = chunk.text.toLowerCase().includes(criterion.requirement.toLowerCase().slice(0, 16)) ? 12 : 0;
  return clamp(Math.round(coverage * 76 + exactBonus + roleBonus(criterion.requirement, chunk.role)), 0, 100);
}

function selectTopEvidenceForCriterion(chunks, criterion, maxItems = 4) {
  return chunks
    .map((chunk) => ({ ...chunk, score: scoreChunkAgainstCriterion(chunk, criterion) }))
    .filter((item) => item.score >= 15)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems);
}

/* =========================================================
   AI GRADING
========================================================= */

async function gradeCriterionWithAI({ criterion, evidence, mode = "assessor" }) {
  if (!OPENAI_API_KEY) return null;

  const evidenceText = evidence
    .map(
      (e, i) => `Evidence ${i + 1}
File: ${e.file}
Role: ${e.role}
Location: ${e.locator}
Score: ${e.score}
Text: ${summarizeSnippet(e.text, 1200)}`
    )
    .join("\n\n");

  const system = `You generate assessor-facing BTEC feedback.
Return valid JSON only with keys:
status, confidenceScore, evidenceAndDepth, rationale, action.

Rules:
- Base judgement only on the evidence provided.
- Do not invent files, pages, or facts.
- Use professional BTEC assessor language.
- Distinguish description, analysis, justification, and evaluation when relevant.
- If evidence is partial or unclear, say so explicitly.`;

  const user = `Criterion: ${criterion.code} - ${criterion.requirement}
Mode: ${mode}

Evidence:
${evidenceText}`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI grading failed: ${text}`);
  }

  const data = await response.json();
  return JSON.parse(data.choices?.[0]?.message?.content || "{}");
}

function fallbackJudgement({ evidence, mode }) {
  const best = evidence[0] || null;
  const confidenceScore = evidence.length
    ? Math.round(evidence.reduce((sum, e) => sum + e.score, 0) / evidence.length)
    : 0;

  let status =
    mode === "student"
      ? confidenceScore >= 82
        ? "Strong evidence"
        : confidenceScore >= 60
          ? "Some evidence"
          : "Needs attention"
      : confidenceScore >= 82
        ? "Achieved"
        : "Review Required";

  if (mode !== "student" && confidenceScore < 40) {
    status = "Review Required";
  }

  return {
    status,
    confidenceScore,
    evidenceAndDepth: best
      ? `Matched evidence was found in ${best.file} at ${best.locator}. ${summarizeSnippet(best.text, 420)}`
      : "No securely matched evidence was located across the submitted files.",
    rationale: best
      ? "This provisional judgement is based on the strongest matched evidence chunk and supporting related matches across the submission pack."
      : "A secure judgement could not be confirmed from the extracted evidence across the submitted files.",
    action:
      confidenceScore < 40
        ? mode === "student"
          ? "Add clearer direct evidence and signpost exactly where the criterion is met."
          : "Tutor review required. Check slides, notes, diagrams, tables, and appendices for missed evidence."
        : mode === "student"
          ? "Strengthen this area with more explicit evidence and tighter links to the criterion wording."
          : "Where relevant, add greater depth, clearer justification, or stronger evaluative commentary."
  };
}

async function gradeAgainstCriteria({ criteria = [], extractedFiles = [], mode = "assessor" }) {
  const evidenceIndex = buildEvidenceIndex(extractedFiles);
  const audit = [];

  for (const rawCriterion of criteria) {
    const criterion = {
      code: normalizeCriterionCode(rawCriterion.code),
      requirement: safeString(rawCriterion.requirement)
    };

    const evidence = selectTopEvidenceForCriterion(evidenceIndex, criterion, 4);
    let judgement = fallbackJudgement({ evidence, mode });

    try {
      const ai = await gradeCriterionWithAI({ criterion, evidence, mode });
      if (ai && typeof ai === "object") {
        judgement = {
          status: safeString(ai.status) || judgement.status,
          confidenceScore: clamp(Number(ai.confidenceScore ?? judgement.confidenceScore), 0, 100),
          evidenceAndDepth: safeString(ai.evidenceAndDepth) || judgement.evidenceAndDepth,
          rationale: safeString(ai.rationale) || judgement.rationale,
          action: safeString(ai.action) || judgement.action
        };
      }
    } catch (error) {
      console.warn(`AI grading fallback for ${criterion.code}:`, error.message);
    }

    const best = evidence[0] || null;

    audit.push({
      id: criterion.code,
      requirement: criterion.requirement,
      status: judgement.status,
      finalStatus: judgement.status,
      confidenceScore: judgement.confidenceScore,
      evidencePage: best ? `${best.file} - ${best.locator}` : "Evidence location not identified",
      evidenceAndDepth: judgement.evidenceAndDepth,
      rationale: judgement.rationale,
      action: judgement.action,
      evidenceTrace: evidence.map((e) => ({
        file: e.file,
        role: e.role,
        locator: e.locator,
        score: e.score,
        snippet: summarizeSnippet(e.text, 220)
      }))
    });
  }

  return audit;
}

function buildOverallGrade(audit = [], mode = "assessor") {
  if (mode === "student") return "Pre-submission guidance";

  const pass = audit.filter((a) => a.id.startsWith("P")).map((a) => a.finalStatus || a.status);
  const merit = audit.filter((a) => a.id.startsWith("M")).map((a) => a.finalStatus || a.status);
  const distinction = audit.filter((a) => a.id.startsWith("D")).map((a) => a.finalStatus || a.status);

  const allAchieved = (items) => items.length > 0 && items.every((s) => s === "Achieved");
  const anyReview = (items) => items.some((s) => s === "Review Required");

  if (pass.length && anyReview(pass)) return "Pass Pending Review";
  if (distinction.length && allAchieved(pass) && allAchieved(merit) && allAchieved(distinction)) return "Distinction";
  if (merit.length && allAchieved(pass) && allAchieved(merit)) return "Merit";
  if (pass.length && allAchieved(pass)) return "Pass";
  return "Pass Pending Review";
}

function buildTutorSummary(audit = [], mode = "assessor") {
  const strong = audit.filter((a) => ["Achieved", "Strong evidence"].includes(a.finalStatus || a.status)).map((a) => a.id);
  const weak = audit.filter((a) => ["Review Required", "Needs attention", "Not Yet Achieved", "Some evidence"].includes(a.finalStatus || a.status)).map((a) => a.id);

  if (mode === "student") {
    return strong.length
      ? `The submission appears strongest in ${strong.slice(0, 3).join(", ")}. Further review is still needed for ${weak.slice(0, 3).join(", ") || "remaining criteria"}.`
      : "The submission currently needs further development. Add clearer direct evidence and stronger signposting to the criterion wording.";
  }

  return strong.length
    ? `The strongest evidence was matched for ${strong.slice(0, 3).join(", ")}. Tutor review remains important for ${weak.slice(0, 3).join(", ") || "criteria with weaker matches"}.`
    : "No criteria were matched with high confidence. Tutor review of the full evidence pack is required.";
}

/* =========================================================
   STORAGE
========================================================= */

async function saveRecord(userId, unit, result) {
  if (!supabaseAdmin) throw new Error("Supabase admin is not configured");

  const payload = {
    user_id: userId,
    learner_name: safeString(result.fullName) || "Unnamed learner",
    unit: safeString(unit),
    grade: safeString(result.grade),
    record_status: ensureRecordControl(result).recordStatus,
    data_json: result,
    updated_at: nowIso()
  };

  const { data, error } = await supabaseAdmin
    .from("feedback_records")
    .insert([payload])
    .select()
    .single();

  if (error) throw error;

  await supabaseAdmin.from("feedback_audit_events").insert([
    {
      record_id: data.id,
      user_id: userId,
      ...buildAuditEvent("record_created", "", "", { status: payload.record_status })
    }
  ]);

  return data.id;
}

async function updateRecord(userId, dbId, result) {
  if (!supabaseAdmin) throw new Error("Supabase admin is not configured");

  const payload = {
    learner_name: safeString(result.fullName) || "Unnamed learner",
    grade: safeString(result.grade),
    record_status: ensureRecordControl(result).recordStatus,
    data_json: result,
    updated_at: nowIso()
  };

  const { error } = await supabaseAdmin
    .from("feedback_records")
    .update(payload)
    .eq("id", dbId)
    .eq("user_id", userId);

  if (error) throw error;

  await supabaseAdmin.from("feedback_audit_events").insert([
    {
      record_id: dbId,
      user_id: userId,
      ...buildAuditEvent("record_updated", "", "", { status: payload.record_status })
    }
  ]);
}

async function logAuditEvent(userId, recordId, action, actorName = "", notes = "", payload = {}) {
  if (!supabaseAdmin) throw new Error("Supabase admin is not configured");

  const { error } = await supabaseAdmin.from("feedback_audit_events").insert([
    {
      record_id: recordId,
      user_id: userId,
      ...buildAuditEvent(action, actorName, notes, payload)
    }
  ]);

  if (error) throw error;
}

/* =========================================================
   API
========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    supabase_url: !!SUPABASE_URL,
    supabase_anon_key: !!SUPABASE_ANON_KEY,
    supabase_service_key: !!SUPABASE_SERVICE_KEY,
    openai_key: !!OPENAI_API_KEY
  });
});

app.get("/api/client-config", (req, res) => {
  res.json({ logoUrl: LOGO_URL });
});

/* -------- PUBLIC BRIEF SCAN -------- */
app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { filename, fileBase64 } = req.body;
    if (!filename || !fileBase64) {
      return res.status(400).json({ error: "filename and fileBase64 are required" });
    }

    const extracted = await extractTextFromFile({ filename, fileBase64, role: "brief" });

    res.json({
      result: {
        criteria: parseCriteriaFromText(extracted.text),
        unit_context: inferUnitContext(extracted.text),
        assignment_context: splitParagraphs(extracted.text)
          .filter((p) => /(task|scenario|brief|submission format|written report|presentation)/i.test(p))
          .slice(0, 8)
          .join("\n\n"),
        evidence_requirements: inferEvidenceRequirements(extracted.text),
        extraction_trace: {
          file: extracted.filename,
          role: extracted.role,
          kind: extracted.kind,
          sections: extracted.sections.slice(0, 20).map((s) => ({
            locator: s.locator,
            snippet: summarizeSnippet(s.text, 180)
          }))
        }
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Brief scan failed" });
  }
});

/* -------- AUTH REQUIRED BELOW -------- */

app.post("/api/grade/submission", requireAuth(async (req, res) => {
  const { filename, fileBase64, criteria = [], mode = "assessor" } = req.body;

  if (!filename || !fileBase64) {
    return res.status(400).json({ error: "filename and fileBase64 are required" });
  }

  const extracted = await extractTextFromFile({ filename, fileBase64 });
  const audit = await gradeAgainstCriteria({
    criteria,
    extractedFiles: [extracted],
    mode
  });

  const result = {
    fullName: filename.replace(/\.[^.]+$/, ""),
    grade: buildOverallGrade(audit, mode),
    audit,
    tutorSummary: buildTutorSummary(audit, mode),
    evidenceTrace: [
      {
        file: extracted.filename,
        role: extracted.role,
        kind: extracted.kind,
        sectionCount: extracted.sections.length
      }
    ],
    recordControl: getDefaultRecordControl(),
    auditTrail: []
  };

  res.json({ result });
}));

app.post("/api/grade/submission-multi", requireAuth(async (req, res) => {
  const {
    submissionLabel = "Combined Submission",
    files = [],
    criteria = [],
    mode = "assessor"
  } = req.body;

  if (!Array.isArray(files) || !files.length) {
    return res.status(400).json({ error: "At least one file is required" });
  }

  const extractedFiles = [];
  for (const file of files) {
    extractedFiles.push(await extractTextFromFile(file));
  }

  const audit = await gradeAgainstCriteria({
    criteria,
    extractedFiles,
    mode
  });

  const result = {
    fullName: submissionLabel,
    grade: buildOverallGrade(audit, mode),
    audit,
    tutorSummary: buildTutorSummary(audit, mode),
    evidenceTrace: extractedFiles.map((f) => ({
      file: f.filename,
      role: f.role,
      kind: f.kind,
      sectionCount: f.sections.length
    })),
    recordControl: getDefaultRecordControl(),
    auditTrail: []
  };

  res.json({ result });
}));

app.post("/api/records/save", requireAuth(async (req, res) => {
  try {
    const id = await saveRecord(req.user.id, req.body.unit || "", req.body.result || {});
    res.json({ id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not save record" });
  }
}));

app.post("/api/records/update", requireAuth(async (req, res) => {
  try {
    await updateRecord(req.user.id, req.body.dbId, req.body.result || {});
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not update record" });
  }
}));

app.get("/api/records/list", requireAuth(async (req, res) => {
  try {
    if (!supabaseAdmin) throw new Error("Supabase admin is not configured");

    const { data, error } = await supabaseAdmin
      .from("feedback_records")
      .select("id, unit, learner_name, grade, record_status, created_at, updated_at")
      .eq("user_id", req.user.id)
      .order("updated_at", { ascending: false });

    if (error) throw error;
    res.json({ records: data || [] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load record list" });
  }
}));

app.post("/api/records/load", requireAuth(async (req, res) => {
  try {
    if (!supabaseAdmin) throw new Error("Supabase admin is not configured");

    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    let query = supabaseAdmin
      .from("feedback_records")
      .select("id, unit, learner_name, grade, record_status, created_at, updated_at, data_json")
      .eq("user_id", req.user.id)
      .order("updated_at", { ascending: false });

    if (ids.length) {
      query = query.in("id", ids);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({
      records: (data || []).map((r) => ({
        ...r,
        data: r.data_json
      }))
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load records" });
  }
}));

app.post("/api/records/action", requireAuth(async (req, res) => {
  try {
    if (!supabaseAdmin) throw new Error("Supabase admin is not configured");

    const { dbId, action, actorName = "", notes = "" } = req.body;

    const { data: record, error } = await supabaseAdmin
      .from("feedback_records")
      .select("id, user_id, data_json")
      .eq("id", dbId)
      .eq("user_id", req.user.id)
      .single();

    if (error || !record) {
      return res.status(404).json({ error: "Record not found" });
    }

    const dataJson = record.data_json || {};
    const rc = ensureRecordControl(dataJson);

    switch (action) {
      case "mark_review":
        rc.markedForReview = true;
        rc.markedForReviewAt = nowUkString();
        rc.markedForReviewReason = safeString(notes);
        rc.recordStatus = "Review Required";
        break;

      case "clear_review":
        rc.markedForReview = false;
        rc.markedForReviewAt = "";
        rc.markedForReviewReason = "";
        if (rc.recordStatus === "Review Required") rc.recordStatus = "Draft";
        break;

      case "sign_off":
        rc.assessorSignedOffBy = safeString(actorName);
        rc.assessorSignedOffAt = nowUkString();
        rc.assessorInternalNotes = safeString(notes) || rc.assessorInternalNotes;
        rc.recordStatus = "Assessor Signed Off";
        break;

      case "request_iv":
        rc.ivRequired = true;
        rc.ivStartedAt = nowUkString();
        rc.ivInternalNotes = safeString(notes) || rc.ivInternalNotes;
        rc.recordStatus = "IV In Progress";
        break;

      case "iv_approve":
        rc.ivRequired = true;
        rc.ivReviewerName = safeString(actorName);
        rc.ivDecision = "Approved";
        rc.ivDecisionAt = nowUkString();
        rc.ivInternalNotes = safeString(notes) || rc.ivInternalNotes;
        rc.recordStatus = "IV Approved";
        break;

      case "iv_return":
        rc.ivRequired = true;
        rc.ivReviewerName = safeString(actorName);
        rc.ivDecision = "Returned";
        rc.ivDecisionAt = nowUkString();
        rc.ivInternalNotes = safeString(notes) || rc.ivInternalNotes;
        rc.recordStatus = "IV Returned";
        break;

      case "release":
        rc.releasedBy = safeString(actorName);
        rc.releasedAt = nowUkString();
        rc.recordStatus = "Released";
        break;

      default:
        return res.status(400).json({ error: "Unknown action" });
    }

    const updated = {
      ...dataJson,
      recordControl: rc,
      auditTrail: [
        ...(Array.isArray(dataJson.auditTrail) ? dataJson.auditTrail : []),
        buildAuditEvent(action, actorName, notes, { status: rc.recordStatus })
      ]
    };

    await updateRecord(req.user.id, dbId, updated);
    await logAuditEvent(req.user.id, dbId, action, actorName, notes, { status: rc.recordStatus });

    const { data: fresh } = await supabaseAdmin
      .from("feedback_records")
      .select("id, data_json")
      .eq("id", dbId)
      .single();

    res.json({
      success: true,
      record: {
        id: fresh.id,
        data: fresh.data_json
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not apply action" });
  }
}));

/* =========================================================
   START
========================================================= */

app.listen(PORT, () => {
  console.log(`MGTS Feedback Server running on port ${PORT}`);
});
