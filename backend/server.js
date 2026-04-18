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
app.use(express.json({ limit: "120mb" }));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Origin not allowed by CORS"));
  }
}));

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODELS = (process.env.GEMINI_MODELS || "gemini-2.5-flash,gemini-2.5-pro,gemini-2.5-flash-lite").split(",").map(s => s.trim()).filter(Boolean);
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DATA_RETENTION_NOTE = process.env.DATA_RETENTION_NOTE || "Review retention schedule before production use.";

const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
const supabaseAuth = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;

console.log("Server booting...");
console.log("SUPABASE_URL:", !!SUPABASE_URL, "SUPABASE_ANON_KEY:", !!SUPABASE_ANON_KEY, "SUPABASE_SERVICE_KEY:", !!SUPABASE_SERVICE_KEY);
console.log("GEMINI_API_KEY:", !!GEMINI_API_KEY, "GEMINI_MODELS:", GEMINI_MODELS.join(","));
console.log("DATA_RETENTION_NOTE:", DATA_RETENTION_NOTE);

const safe = (v = "") => String(v ?? "").trim();
const nowIso = () => new Date().toISOString();
const nowUk = () => new Date().toLocaleString("en-GB");
const normalize = (t = "") => safe(t).replace(/\r/g, "\n").replace(/\t/g, " ").replace(/[ ]{2,}/g, " ");
const splitParagraphs = (t = "") => normalize(t).split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
const tokenize = (t = "") => normalize(t).toLowerCase().replace(/[^a-z0-9\s\-]/g, " ").split(/\s+/).map(s => s.trim()).filter(Boolean);
const summarize = (t = "", n = 240) => { const c = normalize(t).replace(/\n/g, " "); return c.length <= n ? c : `${c.slice(0, n - 1).trim()}…`; };
const normalizeCode = (c = "") => safe(c).toUpperCase().replace(/\s+/g, "");
const ensureRecordControl = (result = {}) => ({
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
  markedForReviewReason: "",
  ...(result.recordControl || {})
});
const auditEvent = (action, actor = "", notes = "", payload = {}) => ({
  action, actor_name: safe(actor), notes: safe(notes), payload_json: payload, created_at: nowIso()
});
function inferFileRole(name = "") {
  const n = name.toLowerCase();
  if (n.endsWith(".pptx") || n.includes("presentation") || n.includes("slides")) return "presentation";
  if (n.includes("notes") || n.includes("speaker")) return "notes";
  if (n.includes("report")) return "report";
  if (n.includes("appendix")) return "appendix";
  if (n.includes("evidence")) return "evidence";
  if (n.includes("brief")) return "brief";
  return "general";
}
async function getUserFromRequest(req) {
  try {
    if (!supabaseAuth) return null;
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return null;
    const { data, error } = await supabaseAuth.auth.getUser(token);
    if (error) return null;
    return data?.user || null;
  } catch { return null; }
}
function requireAuth(handler) {
  return async (req, res) => {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: "Authentication required" });
    req.user = user;
    return handler(req, res);
  };
}
function normalizeStatus(status = "") {
  const s = safe(status).toLowerCase();
  if (["achieved","met","satisfied","pass","passed"].includes(s)) return "Achieved";
  if (["review required","partial","some evidence","satisfactory"].includes(s)) return "Review Required";
  if (["not yet achieved","not achieved","insufficient"].includes(s)) return "Not Yet Achieved";
  return "Review Required";
}
function normalizeConfidence(score, status = "") {
  let n = Number(score);
  if (Number.isNaN(n)) n = 50;
  const s = normalizeStatus(status);
  if (s === "Achieved" && n < 65) n = 72;
  if (s === "Review Required" && n > 79) n = 68;
  if (s === "Not Yet Achieved" && n > 55) n = 45;
  return Math.max(15, Math.min(95, Math.round(n)));
}

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  const text = normalize(result.value || "");
  return { text, sections: splitParagraphs(text).map((t, i) => ({ locator: `paragraph ${i+1}`, text: t })) };
}
async function extractPdf(buffer) {
  const result = await pdf(buffer);
  const text = normalize(result.text || "");
  return { text, sections: splitParagraphs(text).map((t, i) => ({ locator: `section ${i+1}`, text: t })) };
}
function decodeXmlText(xml = "") {
  return xml.replace(/<a:br\/>/g, "\n").replace(/<\/a:p>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}
async function extractPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const sections = [];
  const slideFiles = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a,b)=>Number(a.match(/slide(\d+)/)?.[1]||0)-Number(b.match(/slide(\d+)/)?.[1]||0));
  for (const slidePath of slideFiles) {
    const slideNum = Number(slidePath.match(/slide(\d+)/)?.[1] || 0);
    const slideText = decodeXmlText(await zip.files[slidePath].async("text"));
    if (slideText) sections.push({ locator: `slide ${slideNum}`, text: slideText });
    const notesPath = `ppt/notesSlides/notesSlide${slideNum}.xml`;
    if (zip.files[notesPath]) {
      const notesText = decodeXmlText(await zip.files[notesPath].async("text"));
      if (notesText) sections.push({ locator: `slide ${slideNum} notes`, text: notesText });
    }
  }
  return { text: sections.map(s => `[${s.locator}] ${s.text}`).join("\n\n"), sections };
}
async function extractTxt(buffer) {
  const text = normalize(buffer.toString("utf-8"));
  return { text, sections: splitParagraphs(text).map((t, i) => ({ locator: `section ${i+1}`, text: t })) };
}
async function extractImage(buffer) {
  const result = await Tesseract.recognize(buffer, "eng");
  const text = normalize(result.data?.text || "");
  return { text, sections: splitParagraphs(text).map((t, i) => ({ locator: `ocr block ${i+1}`, text: t })) };
}
async function extractTextFromFile(file) {
  const buffer = Buffer.from(file.fileBase64, "base64");
  const filename = safe(file.filename);
  const lower = filename.toLowerCase();
  const role = safe(file.role).toLowerCase() || inferFileRole(filename);
  try {
    if (lower.endsWith(".docx")) return { filename, role, kind: "docx", ...(await extractDocx(buffer)) };
    if (lower.endsWith(".pdf")) return { filename, role, kind: "pdf", ...(await extractPdf(buffer)) };
    if (lower.endsWith(".pptx")) return { filename, role, kind: "pptx", ...(await extractPptx(buffer)) };
    if (lower.endsWith(".txt")) return { filename, role, kind: "txt", ...(await extractTxt(buffer)) };
    if (/\.(png|jpg|jpeg|webp)$/i.test(lower)) return { filename, role, kind: "image", ...(await extractImage(buffer)) };
    return { filename, role, kind: "unsupported", text: "", sections: [] };
  } catch (error) {
    console.error(`Extraction failed for ${filename}:`, error);
    return { filename, role, kind: "error", text: "", sections: [] };
  }
}
function parseCriteriaFromText(text = "") {
  const lines = normalize(text).split(/\n+/).map(s => s.trim()).filter(Boolean);
  const seen = new Set(); const out = [];
  for (const line of lines) {
    const match = line.match(/^([PMD]\d+)\s*[:\-–—]?\s+(.+)$/i);
    if (!match) continue;
    const code = normalizeCode(match[1]);
    const requirement = safe(match[2]);
    const looksLikeGuidance = requirement.length > 220 || /\b(learners|evidence will come from|might best be obtained|logbook|written report itself|to achieve|criterion\.)\b/i.test(requirement);
    if (!code || !requirement || looksLikeGuidance || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, requirement });
  }
  return out;
}
function chunkSectionText(sectionText = "", maxSentences = 3) {
  const sentences = normalize(sectionText).split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  if (!sentences.length) return [];
  if (sentences.length <= maxSentences) return [sectionText];
  const out = [];
  for (let i = 0; i < sentences.length; i += maxSentences) out.push(sentences.slice(i, i + maxSentences).join(" "));
  return out;
}
function buildEvidenceIndex(extractedFiles = []) {
  const chunks = [];
  for (const file of extractedFiles) {
    if (!file.sections?.length && file.text) {
      chunkSectionText(file.text, 4).forEach((chunkText, i) => chunks.push({ file: file.filename, role: file.role, locator: `block ${i+1}`, text: chunkText, tokens: tokenize(chunkText) }));
      continue;
    }
    (file.sections || []).forEach(section => {
      const parts = chunkSectionText(section.text, 3);
      parts.forEach((chunkText, i) => chunks.push({ file: file.filename, role: file.role, locator: parts.length > 1 ? `${section.locator}, part ${i+1}` : section.locator, text: chunkText, tokens: tokenize(chunkText) }));
    });
  }
  return chunks;
}
function unique(arr) { return [...new Set(arr)]; }
function intersectionCount(a, b) { const bSet = new Set(b); let count = 0; for (const token of a) if (bSet.has(token)) count++; return count; }
function clamp(num, min, max) { return Math.max(min, Math.min(max, num)); }
function roleBonus(requirement = "", role = "") {
  const req = requirement.toLowerCase();
  if (role === "presentation" && /(tool|technique|business performance|justify|presentation)/i.test(req)) return 10;
  if (role === "notes" && /(justify|explain|analysis|discussion)/i.test(req)) return 7;
  if (role === "report" && /(cost|costing|process|plan|develop|report)/i.test(req)) return 10;
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
function selectTopEvidenceForCriterion(chunks, criterion, maxItems = 6) {
  return chunks.map(chunk => ({ ...chunk, score: scoreChunkAgainstCriterion(chunk, criterion) }))
    .filter(item => item.score >= 12)
    .sort((a,b) => b.score - a.score)
    .slice(0, maxItems);
}
async function callGeminiJson(systemPrompt, userPrompt) {
  if (!GEMINI_API_KEY || !GEMINI_MODELS.length) return null;
  let lastError = null;
  for (const model of GEMINI_MODELS) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
        })
      });
      if (!response.ok) { lastError = new Error(await response.text()); continue; }
      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!text) { lastError = new Error(`No Gemini response from ${model}`); continue; }
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}
function fallbackJudgement(evidence, mode = "assessor") {
  const best = evidence[0] || null;
  const rawConfidence = evidence.length ? Math.round(evidence.reduce((s, e) => s + e.score, 0) / evidence.length) : 0;
  const status = rawConfidence >= 70 ? "Achieved" : rawConfidence >= 40 ? "Review Required" : "Not Yet Achieved";
  return {
    status: mode === "student" ? (status === "Achieved" ? "Strong evidence" : status === "Review Required" ? "Some evidence" : "Needs attention") : status,
    confidenceScore: normalizeConfidence(rawConfidence, status),
    evidenceAndDepth: best ? `Matched evidence was found in ${best.file} at ${best.locator}. ${summarize(best.text, 420)}` : "No securely matched evidence was located across the submitted files.",
    rationale: best ? "This provisional judgement is based on the strongest matched evidence chunk and supporting related matches across the submission pack." : "A secure judgement could not be confirmed from the extracted evidence across the submitted files.",
    action: rawConfidence < 40 ? "Tutor review required. Check slides, notes, diagrams, tables, and appendices for missed evidence." : "Where relevant, add greater depth, clearer justification, or stronger evaluative commentary."
  };
}
async function gradeAgainstCriteria({ criteria = [], extractedFiles = [], mode = "assessor" }) {
  const evidenceIndex = buildEvidenceIndex(extractedFiles);
  const audit = [];
  for (const rawCriterion of criteria) {
    const criterion = { code: normalizeCode(rawCriterion.code), requirement: safe(rawCriterion.requirement) };
    const evidence = selectTopEvidenceForCriterion(evidenceIndex, criterion, 6);
    let judgement = fallbackJudgement(evidence, mode);
    try {
      const systemPrompt = `You generate assessor-facing BTEC feedback.
Return valid JSON only with keys:
status, confidenceScore, evidenceAndDepth, rationale, action.
Allowed statuses for assessor mode: Achieved, Review Required, Not Yet Achieved.
Rules:
- Base judgement only on the evidence provided.
- Do not invent files, pages, or facts.
- Use professional BTEC assessor language.
- If evidence is partial or unclear, say so explicitly.`;
      const evidenceText = evidence.map((e, i) => `Evidence ${i+1}\nFile: ${e.file}\nRole: ${e.role}\nLocation: ${e.locator}\nScore: ${e.score}\nText: ${summarize(e.text, 1200)}`).join("\n\n");
      const userPrompt = `Criterion: ${criterion.code} - ${criterion.requirement}\nMode: ${mode}\n\nEvidence:\n${evidenceText}`;
      const ai = await callGeminiJson(systemPrompt, userPrompt);
      if (ai && typeof ai === "object") {
        const finalStatus = normalizeStatus(ai.status);
        judgement = {
          status: finalStatus,
          confidenceScore: normalizeConfidence(ai.confidenceScore ?? judgement.confidenceScore, finalStatus),
          evidenceAndDepth: safe(ai.evidenceAndDepth) || judgement.evidenceAndDepth,
          rationale: safe(ai.rationale) || judgement.rationale,
          action: safe(ai.action) || judgement.action
        };
      }
    } catch (error) {
      console.warn(`Gemini fallback for ${criterion.code}:`, error.message);
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
      evidenceTrace: evidence.map(e => ({ file: e.file, role: e.role, locator: e.locator, score: e.score, snippet: summarize(e.text, 220) }))
    });
  }
  return audit;
}
function buildOverallGrade(audit = [], mode = "assessor") {
  if (mode === "student") return "Pre-submission guidance";
  const pass = audit.filter(a => a.id.startsWith("P")).map(a => a.finalStatus || a.status);
  const merit = audit.filter(a => a.id.startsWith("M")).map(a => a.finalStatus || a.status);
  const distinction = audit.filter(a => a.id.startsWith("D")).map(a => a.finalStatus || a.status);
  const allAchieved = arr => arr.length > 0 && arr.every(s => s === "Achieved");
  const anyReview = arr => arr.some(s => s !== "Achieved");
  if (pass.length && anyReview(pass)) return "Pass Pending Review";
  if (distinction.length && allAchieved(pass) && allAchieved(merit) && allAchieved(distinction)) return "Distinction";
  if (merit.length && allAchieved(pass) && allAchieved(merit)) return "Merit";
  if (pass.length && allAchieved(pass)) return "Pass";
  return "Pass Pending Review";
}
async function saveRecord(userId, unit, result) {
  if (!supabaseAdmin) throw new Error("Supabase admin is not configured");
  const payload = {
    user_id: userId,
    learner_name: safe(result.fullName) || "Unnamed learner",
    unit: safe(unit),
    grade: safe(result.grade),
    record_status: ensureRecordControl(result).recordStatus,
    data_json: result,
    updated_at: nowIso()
  };
  console.log("INSERT feedback_records payload:", JSON.stringify(payload).slice(0, 500));
  const { data, error } = await supabaseAdmin.from("feedback_records").insert([payload]).select().single();
  if (error) {
    console.error("feedback_records insert error:", error);
    throw error;
  }
  const auditPayload = { record_id: data.id, user_id: userId, ...auditEvent("record_created", "", "", { status: payload.record_status }) };
  const { error: auditError } = await supabaseAdmin.from("feedback_audit_events").insert([auditPayload]);
  if (auditError) {
    console.error("feedback_audit_events insert error:", auditError);
    throw auditError;
  }
  return data.id;
}
async function updateRecord(userId, dbId, result) {
  if (!supabaseAdmin) throw new Error("Supabase admin is not configured");
  const payload = {
    learner_name: safe(result.fullName) || "Unnamed learner",
    grade: safe(result.grade),
    record_status: ensureRecordControl(result).recordStatus,
    data_json: result,
    updated_at: nowIso()
  };
  const { error } = await supabaseAdmin.from("feedback_records").update(payload).eq("id", dbId).eq("user_id", userId);
  if (error) throw error;
}
async function logAuditEvent(userId, recordId, action, actorName = "", notes = "", payload = {}) {
  if (!supabaseAdmin) throw new Error("Supabase admin is not configured");
  const { error } = await supabaseAdmin.from("feedback_audit_events").insert([{ record_id: recordId, user_id: userId, ...auditEvent(action, actorName, notes, payload) }]);
  if (error) throw error;
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    supabase_url: !!SUPABASE_URL,
    supabase_anon_key: !!SUPABASE_ANON_KEY,
    supabase_service_key: !!SUPABASE_SERVICE_KEY,
    gemini_key: !!GEMINI_API_KEY,
    gemini_models: GEMINI_MODELS,
    gdpr_controls: true,
    security_controls: ["cors", "auth", "audit_trail", "gdpr_export", "gdpr_delete", "retention_note"]
  });
});

app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { filename, fileBase64 } = req.body;
    if (!filename || !fileBase64) return res.status(400).json({ error: "filename and fileBase64 are required" });
    const extracted = await extractTextFromFile({ filename, fileBase64, role: "brief" });
    res.json({
      result: {
        criteria: parseCriteriaFromText(extracted.text),
        unit_context: normalize(extracted.text).split(/\n+/).filter(line => /^LO\d+/i.test(line.trim())).slice(0, 10).join("\n"),
        assignment_context: splitParagraphs(extracted.text).filter(p => /(task|scenario|brief|submission format|written report|presentation)/i.test(p)).slice(0, 8).join("\n\n"),
        evidence_requirements: normalize(extracted.text).split(/\n+/).map(l => l.trim()).filter(line => /(presentation|report|notes|research|references|citation|evidence|diagram|example|process|plan)/i.test(line)).slice(0, 12),
        extraction_trace: { file: extracted.filename, role: extracted.role, kind: extracted.kind, sections: extracted.sections.slice(0, 20).map(s => ({ locator: s.locator, snippet: summarize(s.text, 180) })) }
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Brief scan failed" });
  }
});

app.post("/api/grade/submission-multi", requireAuth(async (req, res) => {
  const { submissionLabel = "Combined Submission", files = [], criteria = [], mode = "assessor" } = req.body;
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: "At least one file is required" });
  const extractedFiles = [];
  for (const file of files) extractedFiles.push(await extractTextFromFile(file));
  const audit = await gradeAgainstCriteria({ criteria, extractedFiles, mode });
  const result = {
    fullName: submissionLabel,
    grade: buildOverallGrade(audit, mode),
    audit,
    evidenceTrace: extractedFiles.map(f => ({ file: f.filename, role: f.role, kind: f.kind, sectionCount: f.sections.length })),
    recordControl: ensureRecordControl(),
    auditTrail: []
  };
  res.json({ result });
}));

app.post("/api/records/save", requireAuth(async (req, res) => {
  try {
    console.log("SAVE REQUEST START", req.user?.id, req.body.result?.fullName || "");
    const id = await saveRecord(req.user.id, req.body.unit || "", req.body.result || {});
    res.json({ id });
  } catch (error) {
    console.error("SAVE REQUEST FAILED:", error);
    res.status(500).json({ error: "Could not save record", detail: error?.message || String(error) });
  }
}));

app.post("/api/records/update", requireAuth(async (req, res) => {
  try {
    await updateRecord(req.user.id, req.body.dbId, req.body.result || {});
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not update record", detail: error?.message || String(error) });
  }
}));

app.post("/api/records/load", requireAuth(async (req, res) => {
  try {
    if (!supabaseAdmin) throw new Error("Supabase admin is not configured");
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    let query = supabaseAdmin.from("feedback_records").select("id, unit, learner_name, grade, record_status, created_at, updated_at, data_json").eq("user_id", req.user.id).order("updated_at", { ascending: false });
    if (ids.length) query = query.in("id", ids);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ records: (data || []).map(r => ({ ...r, data: r.data_json })) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load records", detail: error?.message || String(error) });
  }
}));

app.post("/api/records/action", requireAuth(async (req, res) => {
  try {
    if (!supabaseAdmin) throw new Error("Supabase admin is not configured");
    const { dbId, action, actorName = "", notes = "" } = req.body;
    const { data: record, error } = await supabaseAdmin.from("feedback_records").select("id, user_id, data_json").eq("id", dbId).eq("user_id", req.user.id).single();
    if (error || !record) return res.status(404).json({ error: "Record not found" });
    const dataJson = record.data_json || {};
    const rc = ensureRecordControl(dataJson);
    switch (action) {
      case "sign_off": rc.assessorSignedOffBy = safe(actorName); rc.assessorSignedOffAt = nowUk(); rc.recordStatus = "Assessor Signed Off"; break;
      case "request_iv": rc.ivRequired = true; rc.ivStartedAt = nowUk(); rc.recordStatus = "IV In Progress"; break;
      case "iv_approve": rc.ivRequired = true; rc.ivReviewerName = safe(actorName); rc.ivDecision = "Approved"; rc.ivDecisionAt = nowUk(); rc.recordStatus = "IV Approved"; break;
      case "iv_return": rc.ivRequired = true; rc.ivReviewerName = safe(actorName); rc.ivDecision = "Returned"; rc.ivDecisionAt = nowUk(); rc.recordStatus = "IV Returned"; break;
      case "release": rc.releasedBy = safe(actorName); rc.releasedAt = nowUk(); rc.recordStatus = "Released"; break;
      default: return res.status(400).json({ error: "Unknown action" });
    }
    const updated = { ...dataJson, recordControl: rc, auditTrail: [...(Array.isArray(dataJson.auditTrail) ? dataJson.auditTrail : []), auditEvent(action, actorName, notes, { status: rc.recordStatus })] };
    await updateRecord(req.user.id, dbId, updated);
    await logAuditEvent(req.user.id, dbId, action, actorName, notes, { status: rc.recordStatus });
    const { data: fresh } = await supabaseAdmin.from("feedback_records").select("id, data_json").eq("id", dbId).single();
    res.json({ success: true, record: { id: fresh.id, data: fresh.data_json } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not apply action", detail: error?.message || String(error) });
  }
}));

app.get("/api/gdpr/export", requireAuth(async (req, res) => {
  try {
    if (!supabaseAdmin) throw new Error("Supabase admin is not configured");
    const { data: records, error: recordsError } = await supabaseAdmin.from("feedback_records").select("*").eq("user_id", req.user.id).order("updated_at", { ascending: false });
    if (recordsError) throw recordsError;
    const { data: events, error: eventsError } = await supabaseAdmin.from("feedback_audit_events").select("*").eq("user_id", req.user.id).order("created_at", { ascending: false });
    if (eventsError) throw eventsError;
    res.json({ exported_at: nowIso(), retention_note: DATA_RETENTION_NOTE, user_id: req.user.id, feedback_records: records || [], feedback_audit_events: events || [] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not export GDPR data", detail: error?.message || String(error) });
  }
}));

app.post("/api/gdpr/delete", requireAuth(async (req, res) => {
  try {
    if (!supabaseAdmin) throw new Error("Supabase admin is not configured");
    const { error: evError } = await supabaseAdmin.from("feedback_audit_events").delete().eq("user_id", req.user.id);
    if (evError) throw evError;
    const { error: recError } = await supabaseAdmin.from("feedback_records").delete().eq("user_id", req.user.id);
    if (recError) throw recError;
    res.json({ success: true, deleted_at: nowIso() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not delete GDPR data", detail: error?.message || String(error) });
  }
}));

app.listen(PORT, () => console.log(`MGTS Feedback Server running on port ${PORT}`));
