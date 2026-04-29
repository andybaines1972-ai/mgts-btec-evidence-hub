require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const mammoth = require("mammoth");
const JSZip = require("jszip");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const MAX_JSON_MB = process.env.MAX_JSON_MB || "90mb";
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 1);
const MAX_JOB_ATTEMPTS = Number(process.env.MAX_JOB_ATTEMPTS || 2);
const STUCK_JOB_MINUTES = Number(process.env.STUCK_JOB_MINUTES || 20);
const JOB_POLL_MS = Number(process.env.JOB_POLL_MS || 2500);
const CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 2600);
const CHUNK_OVERLAP = Number(process.env.CHUNK_OVERLAP || 350);

const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
let activeJobs = 0;

app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map(v => v.trim()), credentials: true }));
app.use(express.json({ limit: MAX_JSON_MB }));

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function jsonError(res, status, message, detail) { return res.status(status).json({ error: message, detail: detail || "" }); }
function sha256(value = "") { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function clean(value = "") { return String(value || "").replace(/\s+/g, " ").trim(); }
function safeJsonParse(text = "") { try { return JSON.parse(text); } catch { const s = text.indexOf("{"); const e = text.lastIndexOf("}"); if (s >= 0 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch {} } return null; } }
function retryableAiError(error) { const msg = String(error?.message || error || "").toLowerCase(); return ["503", "429", "overloaded", "high demand", "unavailable", "resource exhausted", "try again", "deadline", "timeout"].some(v => msg.includes(v)); }
function criterionCode(value = "") { return String(value).toUpperCase().replace(/[^PMD0-9]/g, ""); }
function criterionBand(value = "") { return criterionCode(value)[0] || ""; }
function normaliseStatus(value = "") { const text = String(value || "").toLowerCase(); if (text.includes("not")) return "Not Achieved"; if (text.includes("achieved")) return "Achieved"; return "Review Required"; }
function commandVerbs(requirement = "") { const lower = String(requirement || "").toLowerCase(); return ["identify", "describe", "explain", "analyse", "analyze", "evaluate", "justify", "compare", "assess", "determine", "produce", "maintain", "develop", "prepare", "implement", "review", "monitor", "record"].filter(v => lower.includes(v)); }
function dedupeCriteria(criteria = []) { const seen = new Set(); return criteria.map(item => { const code = criterionCode(item.code || item.id || ""); const requirement = clean(item.requirement || item.description || ""); return { code, requirement, band: item.band || criterionBand(code), linkedLearningAims: Array.isArray(item.linkedLearningAims) ? item.linkedLearningAims : [], linkedTasks: Array.isArray(item.linkedTasks) ? item.linkedTasks : [], commandVerbs: Array.isArray(item.commandVerbs) && item.commandVerbs.length ? item.commandVerbs : commandVerbs(requirement) }; }).filter(item => /^[PMD]\d+$/.test(item.code) && item.requirement).filter(item => { if (seen.has(item.code)) return false; seen.add(item.code); return true; }).sort((a, b) => { const order = { P: 1, M: 2, D: 3 }; const bandDiff = (order[a.code[0]] || 9) - (order[b.code[0]] || 9); if (bandDiff) return bandDiff; return Number(a.code.slice(1)) - Number(b.code.slice(1)); }); }
function fallbackCriteriaFromText(text = "") { const lines = String(text || "").replace(/\r/g, "\n").split("\n").map(line => line.trim()).filter(Boolean); const found = []; const seen = new Set(); for (let i = 0; i < lines.length; i++) { const match = lines[i].match(/\b([PMD]\d+)\b\s*[:\-–—.]?\s*(.{8,320})/i); if (!match) continue; const code = criterionCode(match[1]); if (seen.has(code)) continue; let requirement = clean(match[2]); if (requirement.length < 10 && lines[i + 1]) requirement = clean(lines[i + 1]).slice(0, 320); if (requirement.length >= 8) { seen.add(code); found.push({ code, requirement, band: criterionBand(code), linkedLearningAims: [], linkedTasks: [], commandVerbs: commandVerbs(requirement) }); } } return dedupeCriteria(found); }
function chunkText(text = "", size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) { const source = String(text || ""); const chunks = []; let start = 0; while (start < source.length) { const part = source.slice(start, start + size).trim(); if (part) chunks.push({ idx: chunks.length, text: part }); if (start + size >= source.length) break; start += Math.max(1, size - overlap); } return chunks; }
function expectationForCriterion(code, requirement = "") { const b = criterionBand(code); const req = String(requirement || "").toLowerCase(); if (b === "P") return "Pass criteria require explicit, relevant evidence that covers the exact task and can be located by the assessor."; if (b === "M") { if (req.includes("analyse") || req.includes("analyze")) return "Merit analysis requires developed reasoning, relationships, implications and depth beyond description."; if (req.includes("justify")) return "Merit justification requires reasoned support, not unsupported assertion."; return "Merit requires developed analysis, application, comparison or justification beyond pass-level coverage."; } if (b === "D") { if (req.includes("evaluate")) return "Distinction evaluation requires critical judgement, strengths, limitations and reasoned conclusions."; return "Distinction requires critical, evaluative or independent higher-level performance."; } return "Use the exact criterion wording as the assessment anchor."; }
function buildBandSummary(audit = []) { const summary = { P: { achieved: 0, reviewRequired: 0, notAchieved: 0, total: 0 }, M: { achieved: 0, reviewRequired: 0, notAchieved: 0, total: 0 }, D: { achieved: 0, reviewRequired: 0, notAchieved: 0, total: 0 } }; for (const item of audit) { const b = criterionBand(item.id || item.code || ""); if (!summary[b]) continue; summary[b].total += 1; const st = normaliseStatus(item.finalStatus || item.status); if (st === "Achieved") summary[b].achieved += 1; else if (st === "Not Achieved") summary[b].notAchieved += 1; else summary[b].reviewRequired += 1; } return summary; }
function calculateGrade(audit = []) { if (!audit.length) return "Draft"; if (audit.some(item => normaliseStatus(item.finalStatus || item.status) === "Not Achieved")) return "Not Achieved"; if (audit.some(item => normaliseStatus(item.finalStatus || item.status) === "Review Required")) return "Review Required"; return "Achieved"; }
function buildDevelopmentalSummary(audit = []) { if (!audit.length) return "No criterion-level results were generated."; const achieved = audit.filter(a => normaliseStatus(a.finalStatus || a.status) === "Achieved").length; const review = audit.filter(a => normaliseStatus(a.finalStatus || a.status) === "Review Required").length; const not = audit.filter(a => normaliseStatus(a.finalStatus || a.status) === "Not Achieved").length; return `The submission currently secures ${achieved}/${audit.length} criteria, with ${review} requiring assessor review and ${not} not yet achieved. Development should focus on clearer evidence location, fuller technical depth, and direct alignment to the command verbs and exact criterion wording.`; }

async function callGeminiJson(system, user, options = {}) { if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing from backend environment variables."); const errors = []; for (const model of MODELS) { let delay = Number(options.initialDelayMs || 900); const retries = Number(options.retries || 2); for (let attempt = 1; attempt <= retries; attempt++) { try { const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ parts: [{ text: user }] }], generationConfig: { temperature: options.temperature ?? 0, topP: 0.1, topK: 1, maxOutputTokens: options.maxOutputTokens || 3072, responseMimeType: "application/json" } }) }); const data = await response.json().catch(() => ({})); if (!response.ok || data.error) throw new Error(data?.error?.message || `Gemini request failed: ${response.status}`); const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}"; const parsed = safeJsonParse(raw); if (!parsed) throw new Error("Gemini returned invalid JSON."); return { parsed, model }; } catch (error) { errors.push(`${model} attempt ${attempt}: ${error.message}`); if (!retryableAiError(error) || attempt === retries) break; await sleep(delay); delay *= 2; } } } throw new Error(`All AI models failed. ${errors.join(" | ")}`); }
async function callGeminiPartsJson(parts, options = {}) { if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing from backend environment variables."); const errors = []; for (const model of MODELS) { let delay = Number(options.initialDelayMs || 900); const retries = Number(options.retries || 2); for (let attempt = 1; attempt <= retries; attempt++) { try { const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: options.temperature ?? 0, topP: 0.1, topK: 1, maxOutputTokens: options.maxOutputTokens || 4096, responseMimeType: "application/json" } }) }); const data = await response.json().catch(() => ({})); if (!response.ok || data.error) throw new Error(data?.error?.message || `Gemini request failed: ${response.status}`); const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}"; const parsed = safeJsonParse(raw); if (!parsed) throw new Error("Gemini returned invalid JSON."); return { parsed, model }; } catch (error) { errors.push(`${model} attempt ${attempt}: ${error.message}`); if (!retryableAiError(error) || attempt === retries) break; await sleep(delay); delay *= 2; } } } throw new Error(`All AI models failed. ${errors.join(" | ")}`); }

function fileType(filename = "") { const lower = filename.toLowerCase(); if (lower.endsWith(".docx")) return "docx"; if (lower.endsWith(".doc")) return "doc"; if (lower.endsWith(".txt")) return "txt"; if (lower.endsWith(".pptx")) return "pptx"; if (lower.endsWith(".ppt")) return "ppt"; if (lower.endsWith(".pdf")) return "pdf"; if (lower.endsWith(".png")) return "png"; if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "jpg"; if (lower.endsWith(".webp")) return "webp"; return "unknown"; }
function geminiMime(filename = "") { const type = fileType(filename); if (type === "pdf") return "application/pdf"; if (type === "png") return "image/png"; if (type === "jpg") return "image/jpeg"; if (type === "webp") return "image/webp"; if (type === "txt") return "text/plain"; if (type === "pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation"; if (type === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; return "application/octet-stream"; }
async function extractDocx(base64) { const result = await mammoth.extractRawText({ buffer: Buffer.from(base64, "base64") }); return result.value || ""; }
async function extractTxt(base64) { return Buffer.from(base64, "base64").toString("utf8"); }
async function extractPptx(base64) { const zip = await JSZip.loadAsync(Buffer.from(base64, "base64")); const slideFiles = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort((a, b) => Number((a.match(/slide(\d+)\.xml/i) || [])[1] || 0) - Number((b.match(/slide(\d+)\.xml/i) || [])[1] || 0)); const slides = []; for (const slide of slideFiles) { const xml = await zip.files[slide].async("string"); const text = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)].map(match => match[1]).join(" ").replace(/\s+/g, " ").trim(); if (text) slides.push(text); } return slides.join("\n\n"); }
async function extractTextFromFile(file) { const type = fileType(file.filename || ""); if (type === "docx") return extractDocx(file.fileBase64); if (type === "txt") return extractTxt(file.fileBase64); if (type === "pptx") return extractPptx(file.fileBase64); return ""; }
async function getOrCreateFileCache(file) { const hash = sha256(file.fileBase64 || ""); const { data: existing, error: existingError } = await supabase.from("submission_file_cache").select("*").eq("file_hash", hash).maybeSingle(); if (existingError) throw existingError; if (existing) return existing; const extractedText = await extractTextFromFile(file); const row = { file_hash: hash, filename: file.filename || "file", role: file.role || "general", mime_type: fileType(file.filename || ""), extracted_text: extractedText, chunks_json: chunkText(extractedText), text_length: extractedText.length }; const { data, error } = await supabase.from("submission_file_cache").insert([row]).select("*").single(); if (error) throw error; return data; }
async function getUser(req) { const header = req.headers.authorization || ""; const token = header.startsWith("Bearer ") ? header.slice(7) : ""; if (!token || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null; const { data, error } = await supabase.auth.getUser(token); if (error) return null; return data?.user || null; }

app.get("/", (_req, res) => res.send("MGTS BTEC Feedback backend running"));
app.get("/health", (_req, res) => res.json({ ok: true, activeJobs, models: MODELS, env: { gemini: Boolean(GEMINI_API_KEY), supabaseUrl: Boolean(SUPABASE_URL), supabaseService: Boolean(SUPABASE_SERVICE_ROLE_KEY) } }));
app.get("/api/client-config", (_req, res) => res.json({ logoUrl: "https://www.mgts.co.uk/wp-content/themes/mgts/images/svg/logo.svg", organisation: "MGTS" }));

app.post("/api/brief/scan-file", async (req, res) => { try { const { filename, fileBase64 } = req.body || {}; if (!filename || !fileBase64) return jsonError(res, 400, "filename and fileBase64 are required"); const type = fileType(filename); let text = ""; let parsed = { criteria: [] }; let modelUsed = "fallback"; if (["docx", "txt", "pptx"].includes(type)) { try { text = await extractTextFromFile({ filename, fileBase64 }); } catch (error) { console.warn("Text extraction failed; trying multimodal scan:", error.message); } } const briefSystem = "You are a BTEC assignment brief interpreter. Return JSON only with unitTitle, unitNumber, qualificationLevel, guidedLearningHours, learningAims, tasks, criteria[{code,requirement,band,linkedLearningAims,linkedTasks,commandVerbs}], commandVerbIndex, evidenceRequirements, assignmentContext, unitContext, ambiguityFlags, extractedFrom, schemaVersion. Extract every P/M/D criterion and do not invent criteria."; if (text && text.trim().length > 20) { try { const result = await callGeminiJson(briefSystem, `Brief filename: ${filename}\n\nBrief text:\n${text.slice(0, 65000)}`, { maxOutputTokens: 4096, retries: 2 }); parsed = result.parsed || parsed; modelUsed = result.model; } catch (error) { console.warn("Text AI brief scan failed, using regex fallback:", error.message); } } else { try { const result = await callGeminiPartsJson([{ text: `${briefSystem}\n\nFile name: ${filename}\n\nInspect the uploaded file and extract all visible P/M/D criteria.` }, { inline_data: { mime_type: geminiMime(filename), data: fileBase64 } }], { maxOutputTokens: 4096, retries: 2 }); parsed = result.parsed || parsed; modelUsed = result.model; } catch (error) { console.warn("Multimodal AI brief scan failed:", error.message); } } let criteria = dedupeCriteria(parsed.criteria || []); if (!criteria.length && text) { criteria = fallbackCriteriaFromText(text); if (criteria.length) modelUsed = "regex-fallback"; } if (!criteria.length) return jsonError(res, 422, "No criteria could be extracted from this file. Upload a clearer brief or paste the criteria manually.", `File type: ${type}`); res.json({ result: { unitTitle: parsed.unitTitle || "", unitNumber: parsed.unitNumber || "", qualificationLevel: parsed.qualificationLevel || "", guidedLearningHours: parsed.guidedLearningHours || "", learningAims: Array.isArray(parsed.learningAims) ? parsed.learningAims : [], tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [], criteria, commandVerbIndex: Array.isArray(parsed.commandVerbIndex) ? parsed.commandVerbIndex : [], evidenceRequirements: Array.isArray(parsed.evidenceRequirements) ? parsed.evidenceRequirements : [], assignmentContext: parsed.assignmentContext || "", unitContext: parsed.unitContext || "", ambiguityFlags: Array.isArray(parsed.ambiguityFlags) ? parsed.ambiguityFlags : [], extractedFrom: filename, modelUsed, schemaVersion: "brief.v1" } }); } catch (error) { console.error("scan-file failed:", error); jsonError(res, 500, error.message); } });
app.post("/api/jobs/create", async (req, res) => {
  try {
    const user = await getUser(req);
    const payload = req.body || {};
    const criteria = dedupeCriteria(payload?.briefInterpretation?.criteria?.length ? payload.briefInterpretation.criteria : payload.criteria || []);
    if (!Array.isArray(payload.files) || !payload.files.length) return jsonError(res, 400, "No files provided");
    if (!criteria.length) return jsonError(res, 400, "No criteria provided");
    const { data: job, error } = await supabase.from("grading_jobs").insert([{ user_id: user?.id || null, user_email: user?.email || "", status: "queued", stage: "queued", progress: 0, input_payload: payload }]).select("*").single();
    if (error) throw error;
    const rows = criteria.map((criterion, index) => ({ job_id: job.id, criterion_code: criterion.code, sort_order: index, status: "queued" }));
    const { error: criteriaError } = await supabase.from("grading_job_criteria").insert(rows);
    if (criteriaError) throw criteriaError;
    pollJobs().catch(err => console.error("Immediate poll failed:", err));
    res.json({ jobId: job.id, status: job.status, stage: job.stage, progress: job.progress });
  } catch (error) { console.error("create job failed:", error); jsonError(res, 500, error.message); }
});

app.get("/api/jobs/:jobId", async (req, res) => {
  try {
    const user = await getUser(req);
    const { data: job, error } = await supabase.from("grading_jobs").select("*").eq("id", req.params.jobId).maybeSingle();
    if (error) throw error;
    if (!job) return jsonError(res, 404, "Job not found");
    if (user?.id && job.user_id && user.id !== job.user_id) return jsonError(res, 403, "Forbidden");
    const { data: criteriaRows, error: criteriaError } = await supabase.from("grading_job_criteria").select("*").eq("job_id", job.id).order("sort_order", { ascending: true });
    if (criteriaError) throw criteriaError;
    res.json({ id: job.id, status: job.status, stage: job.stage, progress: job.progress, error: job.error_message, partialResult: job.partial_result, result: job.result_payload, criteria: criteriaRows || [] });
  } catch (error) { console.error("get job failed:", error); jsonError(res, 500, error.message); }
});

app.post("/api/records/save", async (req, res) => {
  try {
    const user = await getUser(req);
    const { result, unit } = req.body || {};
    const row = { user_id: user?.id || null, user_email: user?.email || "", learner_name: result?.fullName || result?.full_name || "Learner Submission", unit: unit || result?.unitInfo || "", grade: result?.grade || "", record_status: result?.recordControl?.recordStatus || "Draft", data: result || {} };
    const { data, error } = await supabase.from("feedback_records").insert([row]).select("id").single();
    if (error) throw error;
    res.json({ id: data.id });
  } catch (error) { console.error("save record failed:", error); jsonError(res, 500, error.message); }
});

app.post("/api/records/update", async (req, res) => {
  try {
    const user = await getUser(req);
    const { dbId, result } = req.body || {};
    if (!dbId) return jsonError(res, 400, "dbId is required");
    let query = supabase.from("feedback_records").update({ learner_name: result?.fullName || result?.full_name || "Learner Submission", unit: result?.unitInfo || "", grade: result?.grade || "", record_status: result?.recordControl?.recordStatus || "Draft", data: result || {}, updated_at: new Date().toISOString() }).eq("id", dbId);
    if (user?.id) query = query.eq("user_id", user.id);
    const { error } = await query;
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) { console.error("update record failed:", error); jsonError(res, 500, error.message); }
});

app.get("/api/records/list", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return jsonError(res, 401, "Login required");
    const { data, error } = await supabase.from("feedback_records").select("id, learner_name, unit, grade, record_status, created_at, updated_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ records: data || [] });
  } catch (error) { console.error("records list failed:", error); jsonError(res, 500, error.message); }
});

app.post("/api/records/load", async (req, res) => {
  try {
    const user = await getUser(req);
    if (!user) return jsonError(res, 401, "Login required");
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    let query = supabase.from("feedback_records").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
    if (ids.length) query = query.in("id", ids);
    else query = query.limit(20);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ records: data || [] });
  } catch (error) { console.error("records load failed:", error); jsonError(res, 500, error.message); }
});

app.post("/api/records/action", async (req, res) => {
  try {
    const { action } = req.body || {};
    let recordStatus = "Draft";
    if (action === "review" || action === "mark-reviewed") recordStatus = "Assessor Reviewed";
    else if (action === "signoff" || action === "sign-off") recordStatus = "Assessor Signed Off";
    else if (action === "require-iv" || action === "iv") recordStatus = "IV Required";
    else if (action === "start-iv") recordStatus = "IV In Review";
    else if (action === "approve-iv") recordStatus = "IV Approved";
    else if (action === "return-iv") recordStatus = "IV Returned";
    else if (action === "release") recordStatus = "Released";
    res.json({ ok: true, recordStatus });
  } catch (error) { jsonError(res, 500, error.message); }
});

function retrieveChunks(criterion, cachedFiles) {
  const scored = [];
  for (const file of cachedFiles) {
    const chunks = Array.isArray(file.chunks_json) ? file.chunks_json : [];
    for (const chunk of chunks) {
      const text = String(chunk.text || "");
      const haystack = text.toLowerCase();
      const words = `${criterion.code} ${criterion.requirement}`.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 3);
      let score = 0;
      for (const word of words) if (haystack.includes(word)) score++;
      if (score) scored.push({ file: file.filename, role: file.role, location: `Chunk ${Number(chunk.idx) + 1}`, quote: clean(text).slice(0, 1200), score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 7);
}

async function extractEvidence(criterion, brief, cachedFiles) {
  const chunks = retrieveChunks(criterion, cachedFiles);
  if (!chunks.length) return { evidenceCandidates: [], note: "No relevant text evidence was retrieved. Non-text files may still require assessor review." };
  try {
    const result = await callGeminiJson(`You are an evidence extraction engine. Return JSON only: {"evidenceCandidates":[{"file":"","location":"","quote":"","relevance":"","strength":"strong | partial | weak"}],"note":""}. Extract evidence for ${criterion.code} only. Do not judge achievement.`, `Criterion: ${criterion.code}: ${criterion.requirement}\nExpectation: ${expectationForCriterion(criterion.code, criterion.requirement)}\nBrief context: ${JSON.stringify(brief || {})}\nRetrieved chunks: ${JSON.stringify(chunks)}`, { maxOutputTokens: 3072, retries: 2 });
    return { evidenceCandidates: Array.isArray(result.parsed.evidenceCandidates) ? result.parsed.evidenceCandidates : [], note: result.parsed.note || "" };
  } catch (error) {
    return { evidenceCandidates: chunks.slice(0, 3).map(item => ({ file: item.file, location: item.location, quote: item.quote, relevance: "Fallback retrieved text evidence for assessor review.", strength: "partial" })), note: `Fallback extraction used because AI evidence extraction failed: ${error.message}` };
  }
}

async function judgeCriterion(criterion, evidence, brief) {
  try {
    const result = await callGeminiJson('You are a senior Pearson BTEC assessor. Return JSON only: {"status":"Achieved | Not Achieved | Review Required","finalStatus":"Achieved | Not Achieved | Review Required","evidencePage":"","evidenceAndDepth":"","rationale":"","action":"","confidenceScore":0,"riskFlags":[],"evidenceTrace":[]}. Use only supplied evidence. No generic repetition. No signposting exact answers. Feedback must be specific to the criterion and evidence.', `Criterion: ${criterion.code}: ${criterion.requirement}\nExpectation: ${expectationForCriterion(criterion.code, criterion.requirement)}\nCommand verbs: ${JSON.stringify(criterion.commandVerbs || [])}\nBrief: ${JSON.stringify(brief || {})}\nEvidence: ${JSON.stringify(evidence.evidenceCandidates || [])}`, { maxOutputTokens: 3072, retries: 2 });
    const parsed = result.parsed || {};
    const best = (evidence.evidenceCandidates || [])[0];
    return { id: criterion.code, requirement: criterion.requirement, status: normaliseStatus(parsed.status), finalStatus: normaliseStatus(parsed.finalStatus || parsed.status), evidencePage: clean(parsed.evidencePage || (best ? `${best.file} - ${best.location}` : "Evidence not clearly located.")), evidenceAndDepth: clean(parsed.evidenceAndDepth) || "Evidence is not yet sufficiently explicit or developed to support a secure judgement.", rationale: clean(parsed.rationale) || "A secure judgement cannot be made without clearer evidence alignment.", action: clean(parsed.action) || "Develop clearer, fuller, criterion-linked evidence with identifiable evidence locations and appropriate technical depth.", confidenceScore: Number(parsed.confidenceScore || 45), commandVerbs: criterion.commandVerbs || [], linkedLearningAims: criterion.linkedLearningAims || [], linkedTasks: criterion.linkedTasks || [], riskFlags: Array.isArray(parsed.riskFlags) ? parsed.riskFlags : [], evidenceTrace: Array.isArray(parsed.evidenceTrace) ? parsed.evidenceTrace : evidence.evidenceCandidates || [] };
  } catch (error) {
    const best = (evidence.evidenceCandidates || [])[0];
    return { id: criterion.code, requirement: criterion.requirement, status: "Review Required", finalStatus: "Review Required", evidencePage: best ? `${best.file} - ${best.location}` : "Evidence not clearly located.", evidenceAndDepth: best ? `Potential evidence was found but assessor review is required: "${clean(best.quote).slice(0, 220)}".` : "No securely located text evidence was identified.", rationale: "The available evidence does not yet support a secure automated judgement.", action: "Develop clearer, fuller, criterion-linked evidence and provide identifiable evidence locations.", confidenceScore: 35, commandVerbs: criterion.commandVerbs || [], linkedLearningAims: criterion.linkedLearningAims || [], linkedTasks: criterion.linkedTasks || [], riskFlags: ["Assessor review required"], evidenceTrace: evidence.evidenceCandidates || [] };
  }
}

async function updateJob(jobId, patch) { const { error } = await supabase.from("grading_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", jobId); if (error) throw error; }
async function updateJobCriterion(jobId, code, patch) { const { error } = await supabase.from("grading_job_criteria").update({ ...patch, updated_at: new Date().toISOString() }).eq("job_id", jobId).eq("criterion_code", code); if (error) throw error; }

async function processJob(job) {
  activeJobs += 1;
  try {
    const attempts = Number(job.attempts || 0) + 1;
    await updateJob(job.id, { status: "processing", stage: "extracting files", progress: 5, attempts, locked_at: new Date().toISOString() });
    const payload = job.input_payload || {};
    const files = Array.isArray(payload.files) ? payload.files : [];
    const brief = payload.briefInterpretation || {};
    const criteria = dedupeCriteria(brief.criteria?.length ? brief.criteria : payload.criteria || []);
    if (!files.length) throw new Error("No files provided");
    if (!criteria.length) throw new Error("No criteria provided");
    const cachedFiles = [];
    for (let i = 0; i < files.length; i++) {
      cachedFiles.push(await getOrCreateFileCache(files[i]));
      await updateJob(job.id, { stage: "extracting files", progress: 5 + Math.round(((i + 1) / files.length) * 20) });
    }
    const audit = [];
    for (let i = 0; i < criteria.length; i++) {
      const criterion = criteria[i];
      await updateJob(job.id, { stage: `grading ${criterion.code}`, progress: 30 + Math.round((i / criteria.length) * 60) });
      await updateJobCriterion(job.id, criterion.code, { status: "processing", error_message: null });
      const evidence = await extractEvidence(criterion, brief, cachedFiles);
      const judgement = await judgeCriterion(criterion, evidence, brief);
      audit.push(judgement);
      await updateJobCriterion(job.id, criterion.code, { status: "completed", result_json: judgement });
      await updateJob(job.id, { partial_result: { fullName: payload.learnerName || "Learner Submission", audit } });
    }
    const result = { fullName: payload.learnerName || "Learner Submission", unitInfo: payload.unitInfo || "", assessorName: payload.assessorName || "", submissionType: payload.submissionType || payload.assessmentMode || "", internalVerifierName: payload.internalVerifierName || "", cohortName: payload.cohortName || "", assessmentMode: payload.assessmentMode || "", qualificationLevel: payload.qualificationLevel || "", programmePathway: payload.programmePathway || payload.pathway || "", grade: calculateGrade(audit), audit, overallBandSummary: buildBandSummary(audit), developmentalSummary: buildDevelopmentalSummary(audit), briefInterpretation: brief, recordControl: { recordStatus: "Draft", ivRequired: false, assessorReviewedAt: null, assessorSignedOffAt: null }, completedAt: new Date().toISOString() };
    await updateJob(job.id, { status: "completed", stage: "completed", progress: 100, result_payload: result, partial_result: result, completed_at: new Date().toISOString(), error_message: null });
  } catch (error) {
    console.error(`Job ${job.id} failed:`, error);
    const attempts = Number(job.attempts || 0) + 1;
    const retry = attempts < MAX_JOB_ATTEMPTS;
    await updateJob(job.id, { status: retry ? "queued" : "failed", stage: retry ? "retry queued" : "failed", progress: retry ? 0 : 100, error_message: error.message, attempts, locked_at: null });
  } finally { activeJobs = Math.max(0, activeJobs - 1); }
}

async function recoverStuckJobs() { const cutoff = new Date(Date.now() - STUCK_JOB_MINUTES * 60 * 1000).toISOString(); const { error } = await supabase.from("grading_jobs").update({ status: "queued", stage: "recovered", locked_at: null, updated_at: new Date().toISOString() }).eq("status", "processing").lt("locked_at", cutoff); if (error) console.error("recover stuck jobs failed:", error.message); }
async function pollJobs() { if (activeJobs >= MAX_CONCURRENT_JOBS) return; await recoverStuckJobs(); const { data, error } = await supabase.from("grading_jobs").select("*").eq("status", "queued").order("created_at", { ascending: true }).limit(MAX_CONCURRENT_JOBS - activeJobs); if (error) { console.error("job poll failed:", error.message); return; } for (const job of data || []) processJob(job).catch(error => console.error("unhandled job error:", error)); }
setInterval(() => pollJobs().catch(error => console.error("poll loop failed:", error)), JOB_POLL_MS);

app.use((error, _req, res, _next) => { console.error("Unhandled backend error:", error); jsonError(res, 500, "Unexpected backend error", error.message); });
app.listen(PORT, () => console.log(`MGTS corrected backend running on port ${PORT}`));
