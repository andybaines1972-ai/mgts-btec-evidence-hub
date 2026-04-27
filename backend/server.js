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
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 25000);
const AI_RETRIES = Number(process.env.AI_RETRIES || 2);
const MAX_JSON_MB = process.env.MAX_JSON_MB || "95mb";
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 1);
const MAX_JOB_ATTEMPTS = Number(process.env.MAX_JOB_ATTEMPTS || 2);

const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
let activeJobs = 0;

app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map(v => v.trim()), credentials: true }));
app.use(express.json({ limit: MAX_JSON_MB }));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const clean = v => String(v || "").replace(/\s+/g, " ").trim();
const sha256 = v => crypto.createHash("sha256").update(String(v || "")).digest("hex");
const jsonError = (res, status, message, detail = "") => res.status(status).json({ error: message, detail });

function safeJsonParse(text = "") {
  if (typeof text === "object" && text) return text;
  let raw = String(text || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(raw); } catch {}
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) { try { return JSON.parse(raw.slice(s, e + 1)); } catch {} }
  return null;
}

function withTimeout(promise, ms, label = "operation") {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))]);
}

function retryable(err) {
  const m = String(err?.message || err || "").toLowerCase();
  return ["503", "429", "overloaded", "high demand", "unavailable", "resource exhausted", "try again", "timeout", "timed out", "internal"].some(x => m.includes(x));
}

function fileType(filename = "") {
  const f = filename.toLowerCase();
  if (f.endsWith(".docx")) return "docx";
  if (f.endsWith(".txt")) return "txt";
  if (f.endsWith(".pptx")) return "pptx";
  if (f.endsWith(".pdf")) return "pdf";
  if (f.endsWith(".png")) return "png";
  if (f.endsWith(".jpg") || f.endsWith(".jpeg")) return "jpg";
  if (f.endsWith(".webp")) return "webp";
  if (f.endsWith(".doc")) return "doc";
  if (f.endsWith(".ppt")) return "ppt";
  return "unknown";
}

function geminiMime(filename = "") {
  const t = fileType(filename);
  if (t === "pdf") return "application/pdf";
  if (t === "png") return "image/png";
  if (t === "jpg") return "image/jpeg";
  if (t === "webp") return "image/webp";
  if (t === "txt") return "text/plain";
  return "application/octet-stream";
}

function criterionCode(v = "") { return String(v).toUpperCase().replace(/[^PMD0-9]/g, ""); }
function validCriterion(code = "") { const c = criterionCode(code); return /^[PMD]\d+$/.test(c) && !/^[MD]0$/.test(c); }
function band(code = "") { return criterionCode(code)[0] || ""; }
function commandVerbs(req = "") {
  const l = String(req).toLowerCase();
  return ["identify","describe","explain","analyse","analyze","evaluate","justify","compare","assess","determine","produce","maintain","develop","prepare","implement","review","monitor","record","demonstrate","plan","apply","recommend"].filter(v => l.includes(v));
}

function dedupeCriteria(criteria = []) {
  const seen = new Set();
  return (Array.isArray(criteria) ? criteria : [])
    .map(c => {
      const code = criterionCode(c.code || c.id || "");
      const requirement = clean(c.requirement || c.description || c.text || "");
      return { code, requirement, band: c.band || band(code), linkedLearningAims: c.linkedLearningAims || [], linkedTasks: c.linkedTasks || [], commandVerbs: c.commandVerbs || commandVerbs(requirement) };
    })
    .filter(c => validCriterion(c.code) && c.requirement && c.requirement.toLowerCase() !== "requirement" && !/requirement inferred/i.test(c.requirement))
    .filter(c => { if (seen.has(c.code)) return false; seen.add(c.code); return true; })
    .sort((a,b) => (({P:1,M:2,D:3}[a.code[0]] || 9) - (({P:1,M:2,D:3}[b.code[0]] || 9)) || Number(a.code.slice(1)) - Number(b.code.slice(1))));
}

function fallbackCriteriaFromText(text = "") {
  const lines = String(text).replace(/\r/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);
  const found = [], seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\b([PMD]\d+)\b\s*[:\-–—.]?\s*(.{12,520})/i);
    if (!m) continue;
    const code = criterionCode(m[1]);
    if (!validCriterion(code) || seen.has(code)) continue;
    let requirement = clean(m[2]);
    if (requirement.length < 12 && lines[i+1]) requirement = clean(lines[i+1]).slice(0,520);
    if (requirement.length >= 12 && requirement.toLowerCase() !== "requirement" && !/requirement inferred/i.test(requirement)) {
      seen.add(code); found.push({ code, requirement, band: band(code), commandVerbs: commandVerbs(requirement) });
    }
  }
  return dedupeCriteria(found);
}

function chunkText(text = "", size = 2200, overlap = 300) {
  const chunks = []; let start = 0; const src = String(text || "");
  while (start < src.length) {
    const part = src.slice(start, start + size).trim();
    if (part) chunks.push({ idx: chunks.length, text: part });
    if (start + size >= src.length) break;
    start += Math.max(1, size - overlap);
  }
  return chunks;
}

async function extractDocx(base64) {
  const r = await mammoth.extractRawText({ buffer: Buffer.from(base64, "base64") });
  return r.value || "";
}
async function extractTxt(base64) { return Buffer.from(base64, "base64").toString("utf8"); }
async function extractPptx(base64) {
  const zip = await JSZip.loadAsync(Buffer.from(base64, "base64"));
  const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/i.test(n)).sort((a,b) => Number((a.match(/slide(\d+)/i)||[])[1]||0) - Number((b.match(/slide(\d+)/i)||[])[1]||0));
  const out = [];
  for (const s of slides) {
    const xml = await zip.files[s].async("string");
    const txt = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)].map(m => m[1].replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")).join(" ").replace(/\s+/g," ").trim();
    if (txt) out.push(txt);
  }
  return out.join("\n\n");
}
async function extractTextFromFile(file) {
  const t = fileType(file.filename || "");
  if (t === "docx") return extractDocx(file.fileBase64);
  if (t === "txt") return extractTxt(file.fileBase64);
  if (t === "pptx") return extractPptx(file.fileBase64);
  return "";
}

async function callGeminiBody(model, body, timeoutMs) {
  const response = await withTimeout(fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  }), timeoutMs, `Gemini ${model}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data?.error?.message || `Gemini request failed: ${response.status}`);
  const parsed = safeJsonParse(data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
  if (!parsed) throw new Error("Gemini returned invalid JSON");
  return parsed;
}

async function callGeminiJson(system, user, opts = {}) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing");
  const errors = [];
  for (const model of MODELS) {
    let delay = 900;
    for (let i=1; i<=Number(opts.retries ?? AI_RETRIES); i++) {
      try {
        const parsed = await callGeminiBody(model, {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ parts: [{ text: user }] }],
          generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: opts.maxOutputTokens || 3072, responseMimeType: "application/json" }
        }, opts.timeoutMs || AI_TIMEOUT_MS);
        return { parsed, model };
      } catch (e) {
        errors.push(`${model}#${i}: ${e.message}`);
        if (!retryable(e) || i === Number(opts.retries ?? AI_RETRIES)) break;
        await sleep(delay); delay *= 2;
      }
    }
  }
  throw new Error(`All AI models failed. ${errors.join(" | ")}`);
}

async function callGeminiPartsJson(parts, opts = {}) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing");
  const errors = [];
  for (const model of MODELS) {
    let delay = 900;
    for (let i=1; i<=Number(opts.retries ?? AI_RETRIES); i++) {
      try {
        const parsed = await callGeminiBody(model, {
          contents: [{ parts }],
          generationConfig: { temperature: 0, topP: 0.1, topK: 1, maxOutputTokens: opts.maxOutputTokens || 4096, responseMimeType: "application/json" }
        }, opts.timeoutMs || AI_TIMEOUT_MS);
        return { parsed, model };
      } catch (e) {
        errors.push(`${model}#${i}: ${e.message}`);
        if (!retryable(e) || i === Number(opts.retries ?? AI_RETRIES)) break;
        await sleep(delay); delay *= 2;
      }
    }
  }
  throw new Error(`All AI models failed. ${errors.join(" | ")}`);
}

async function getUser(req) {
  const token = (req.headers.authorization || "").startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  if (!token || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error) return null;
  return data?.user || null;
}

app.get("/", (_req,res) => res.send("MGTS backend v6 running"));
app.get("/health", (_req,res) => res.json({ ok:true, service:"mgts-backend-v6", activeJobs, models:MODELS, env:{ gemini:!!GEMINI_API_KEY, supabaseUrl:!!SUPABASE_URL, supabaseService:!!SUPABASE_SERVICE_ROLE_KEY }}));
app.get("/api/client-config", (_req,res) => res.json({ logoUrl:"https://www.mgts.co.uk/wp-content/themes/mgts/images/svg/logo.svg", organisation:"MGTS", features:{ asyncJobs:true, broadFileSupport:true, twoPassFeedback:true }}));

app.post("/api/brief/scan-file", async (req,res) => {
  try {
    const { filename, fileBase64 } = req.body || {};
    if (!filename || !fileBase64) return jsonError(res, 400, "filename and fileBase64 are required");

    const t = fileType(filename);
    let extractedText = "";
    let parsed = null, modelUsed = "none";

    if (["docx","txt","pptx"].includes(t)) {
      try { extractedText = await extractTextFromFile({ filename, fileBase64 }); }
      catch (e) { console.warn("text extraction failed", e.message); }
    }

    const system = `You are an expert Pearson BTEC assignment brief interpreter.
Return JSON only:
{"unitTitle":"","unitNumber":"","learningAims":[],"tasks":[],"criteria":[{"code":"P1","requirement":"actual criterion wording or exact task-linked requirement"}],"assignmentContext":"","schemaVersion":"brief.v1"}
Rules:
- Extract every actual Pass, Merit and Distinction criterion.
- Criteria codes must be valid P1, P2, M1, D1 etc.
- Do not create M0, D0 or impossible criteria.
- Do not use generic text such as "Requirement" or "Requirement inferred from brief".
- Use the actual wording from the brief.`;

    if (extractedText.trim()) {
      try {
        const r = await callGeminiJson(system, `Filename: ${filename}\n\nExtracted brief text:\n${extractedText.slice(0, 65000)}`, { maxOutputTokens: 4096 });
        parsed = r.parsed; modelUsed = r.model;
      } catch (e) { console.warn("AI text scan failed", e.message); }
    }

    if ((!parsed?.criteria?.length) && ["pdf","png","jpg","webp"].includes(t)) {
      try {
        const r = await callGeminiPartsJson([{ text: `${system}\n\nFilename: ${filename}\nInspect the uploaded file and extract all visible criteria.` }, { inline_data: { mime_type: geminiMime(filename), data: fileBase64 }}], { maxOutputTokens: 4096 });
        parsed = r.parsed; modelUsed = r.model;
      } catch (e) { console.warn("AI multimodal scan failed", e.message); }
    }

    let criteria = dedupeCriteria(parsed?.criteria || []);
    if (!criteria.length && extractedText) { criteria = fallbackCriteriaFromText(extractedText); if (criteria.length) modelUsed = "regex-fallback"; }

    return res.json({ result: {
      unitTitle: parsed?.unitTitle || "", unitNumber: parsed?.unitNumber || "",
      learningAims: Array.isArray(parsed?.learningAims) ? parsed.learningAims : [],
      tasks: Array.isArray(parsed?.tasks) ? parsed.tasks : [],
      criteria,
      assignmentContext: parsed?.assignmentContext || "",
      ambiguityFlags: criteria.length ? [] : ["No valid criteria were extracted. Upload a clearer brief or paste the criteria manually."],
      extractedFrom: filename, modelUsed, schemaVersion:"brief.v1"
    }});
  } catch (e) {
    console.error("SCAN BRIEF ERROR", e);
    return res.status(500).json({ error: e.message, result:{ criteria:[], ambiguityFlags:[`Brief scan failed: ${e.message}`], schemaVersion:"brief.v1" }});
  }
});

function normaliseStatus(v="") {
  const s = String(v).toLowerCase();
  if (s.includes("not")) return "Not Achieved";
  if (s.includes("achieved")) return "Achieved";
  return "Review Required";
}
function expectation(code, req="") {
  const b = band(code), r = req.toLowerCase();
  if (b === "P") return "Pass requires explicit relevant evidence covering the exact task.";
  if (b === "M") return r.includes("analyse") ? "Merit analysis requires developed reasoning beyond description." : "Merit requires developed analysis/application/justification.";
  if (b === "D") return "Distinction requires critical evaluation, judgement and reasoned conclusions.";
  return "Use the exact criterion wording as anchor.";
}
function calculateGrade(audit=[]) {
  if (!audit.length) return "Draft";
  if (audit.some(a => normaliseStatus(a.finalStatus || a.status) === "Not Achieved")) return "Not Achieved";
  if (audit.some(a => normaliseStatus(a.finalStatus || a.status) === "Review Required")) return "Review Required";
  return "Achieved";
}
function bandSummary(audit=[]) {
  const out = { P:{achieved:0,reviewRequired:0,notAchieved:0,total:0}, M:{achieved:0,reviewRequired:0,notAchieved:0,total:0}, D:{achieved:0,reviewRequired:0,notAchieved:0,total:0} };
  audit.forEach(a => { const b=band(a.id); if(!out[b]) return; out[b].total++; const st=normaliseStatus(a.finalStatus || a.status); if(st==="Achieved") out[b].achieved++; else if(st==="Not Achieved") out[b].notAchieved++; else out[b].reviewRequired++; });
  return out;
}
function devSummary(audit=[]) {
  const a = audit.filter(x => normaliseStatus(x.finalStatus || x.status)==="Achieved").length;
  const r = audit.filter(x => normaliseStatus(x.finalStatus || x.status)==="Review Required").length;
  const n = audit.filter(x => normaliseStatus(x.finalStatus || x.status)==="Not Achieved").length;
  return `The submission currently secures ${a}/${audit.length} criteria, with ${r} requiring assessor review and ${n} not yet achieved. Development should focus on clearer evidence location, fuller technical depth, and direct alignment to the command verbs and exact criterion wording.`;
}

async function getOrCreateFileCache(file) {
  const hash = sha256(file.fileBase64 || "");
  const existing = await supabase.from("submission_file_cache").select("*").eq("file_hash", hash).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return existing.data;
  const extracted = await extractTextFromFile(file);
  const row = { file_hash:hash, filename:file.filename||"file", role:file.role||"general", mime_type:fileType(file.filename||""), extracted_text:extracted, chunks_json:chunkText(extracted), text_length:extracted.length };
  const inserted = await supabase.from("submission_file_cache").insert([row]).select("*").single();
  if (inserted.error) throw inserted.error;
  return inserted.data;
}

function retrieveChunks(criterion, cachedFiles) {
  const scored = [];
  cachedFiles.forEach(file => (Array.isArray(file.chunks_json) ? file.chunks_json : []).forEach(chunk => {
    const txt = String(chunk.text||""), hay = txt.toLowerCase();
    const words = `${criterion.code} ${criterion.requirement}`.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length>3);
    let score = 0; words.forEach(w => { if (hay.includes(w)) score++; });
    if (score) scored.push({ file:file.filename, location:`Chunk ${Number(chunk.idx)+1}`, quote:clean(txt).slice(0,1000), score });
  }));
  return scored.sort((a,b)=>b.score-a.score).slice(0,5);
}

async function extractEvidence(criterion, brief, cachedFiles) {
  const chunks = retrieveChunks(criterion, cachedFiles);
  if (!chunks.length) return { evidenceCandidates: [], note:"No relevant text evidence retrieved." };
  try {
    const r = await callGeminiJson(
      `Return JSON only: {"evidenceCandidates":[{"file":"","location":"","quote":"","relevance":"","strength":"strong | partial | weak"}],"note":""}. Extract evidence for ${criterion.code} only. Do not judge achievement.`,
      `Criterion: ${criterion.code}: ${criterion.requirement}\nExpectation: ${expectation(criterion.code, criterion.requirement)}\nBrief:${JSON.stringify(brief||{})}\nChunks:${JSON.stringify(chunks)}`,
      { maxOutputTokens:2048 }
    );
    return { evidenceCandidates: Array.isArray(r.parsed.evidenceCandidates) ? r.parsed.evidenceCandidates.slice(0,4) : [], note: r.parsed.note || "", modelUsed:r.model };
  } catch {
    return { evidenceCandidates: chunks.slice(0,3).map(c => ({ file:c.file, location:c.location, quote:c.quote, relevance:"Fallback retrieved text evidence.", strength:"partial" })), note:"Fallback extraction used.", modelUsed:"fallback" };
  }
}

async function judgeCriterion(criterion, evidence, brief) {
  try {
    const r = await callGeminiJson(
      `You are a senior Pearson BTEC assessor. Return JSON only: {"status":"Achieved | Not Achieved | Review Required","finalStatus":"Achieved | Not Achieved | Review Required","evidencePage":"","evidenceAndDepth":"","rationale":"","action":"","confidenceScore":0,"riskFlags":[],"evidenceTrace":[]}. Use only supplied evidence. No generic repetition. No exact answer signposting.`,
      `Criterion: ${criterion.code}: ${criterion.requirement}\nExpectation:${expectation(criterion.code, criterion.requirement)}\nBrief:${JSON.stringify(brief||{})}\nEvidence:${JSON.stringify(evidence.evidenceCandidates || [])}`,
      { maxOutputTokens:2048 }
    );
    const p = r.parsed || {}, best = (evidence.evidenceCandidates || [])[0];
    return { id:criterion.code, requirement:criterion.requirement, status:normaliseStatus(p.status), finalStatus:normaliseStatus(p.finalStatus || p.status), evidencePage:clean(p.evidencePage || (best ? `${best.file} - ${best.location}` : "Evidence not clearly located.")), evidenceAndDepth:clean(p.evidenceAndDepth) || "Evidence is not yet sufficiently explicit or developed to support a secure judgement.", rationale:clean(p.rationale) || "A secure judgement cannot be made without clearer evidence alignment.", action:clean(p.action) || "Develop clearer, fuller, criterion-linked evidence with identifiable evidence locations and appropriate technical depth.", confidenceScore:Number(p.confidenceScore || 45), commandVerbs:criterion.commandVerbs || [], linkedLearningAims:criterion.linkedLearningAims || [], linkedTasks:criterion.linkedTasks || [], riskFlags:Array.isArray(p.riskFlags) ? p.riskFlags : [], evidenceTrace:Array.isArray(p.evidenceTrace) ? p.evidenceTrace : evidence.evidenceCandidates || [], modelUsed:r.model };
  } catch {
    const best = (evidence.evidenceCandidates || [])[0];
    return { id:criterion.code, requirement:criterion.requirement, status:"Review Required", finalStatus:"Review Required", evidencePage:best ? `${best.file} - ${best.location}` : "Evidence not clearly located.", evidenceAndDepth:best ? `Potential evidence found but assessor review is required: "${clean(best.quote).slice(0,220)}".` : "No securely located evidence was identified.", rationale:"The available evidence does not yet support a secure automated judgement.", action:"Develop clearer, fuller, criterion-linked evidence and provide identifiable evidence locations.", confidenceScore:35, riskFlags:["Assessor review required"], evidenceTrace:evidence.evidenceCandidates || [], modelUsed:"fallback" };
  }
}

async function updateJob(jobId, patch) {
  const r = await supabase.from("grading_jobs").update({ ...patch, updated_at:nowIso() }).eq("id", jobId);
  if (r.error) throw r.error;
}
async function updateJobCriterion(jobId, code, patch) {
  const r = await supabase.from("grading_job_criteria").update({ ...patch, updated_at:nowIso() }).eq("job_id", jobId).eq("criterion_code", code);
  if (r.error) throw r.error;
}

async function processJob(job) {
  activeJobs++;
  try {
    const attempts = Number(job.attempts || 0) + 1;
    await updateJob(job.id, { status:"processing", stage:"extracting files", progress:5, attempts, locked_at:nowIso() });
    const payload = job.input_payload || {}, files = Array.isArray(payload.files) ? payload.files : [], brief = payload.briefInterpretation || {};
    const criteria = dedupeCriteria(brief.criteria?.length ? brief.criteria : payload.criteria || []);
    if (!files.length) throw new Error("No files provided");
    if (!criteria.length) throw new Error("No criteria provided");

    const cachedFiles = [];
    for (let i=0;i<files.length;i++) {
      cachedFiles.push(await getOrCreateFileCache(files[i]));
      await updateJob(job.id, { stage:"extracting files", progress:5+Math.round(((i+1)/files.length)*20) });
    }

    const audit = [];
    for (let i=0;i<criteria.length;i++) {
      const c = criteria[i];
      await updateJob(job.id, { stage:`grading ${c.code}`, progress:30+Math.round((i/criteria.length)*60) });
      await updateJobCriterion(job.id, c.code, { status:"processing", error_message:null });
      const ev = await extractEvidence(c, brief, cachedFiles);
      const judgement = await judgeCriterion(c, ev, brief);
      audit.push(judgement);
      await updateJobCriterion(job.id, c.code, { status:"completed", result_json:judgement });
      await updateJob(job.id, { partial_result:{ fullName:payload.learnerName || "Learner Submission", audit, criteriaComplete:audit.length, criteriaTotal:criteria.length } });
    }

    const result = { fullName:payload.learnerName || "Learner Submission", unitInfo:payload.unitInfo || "", assessorName:payload.assessorName || "", submissionType:payload.submissionType || payload.assessmentMode || "", grade:calculateGrade(audit), audit, overallBandSummary:bandSummary(audit), developmentalSummary:devSummary(audit), briefInterpretation:brief, recordControl:{ recordStatus:"Draft", ivRequired:false }, meta:{ completedAt:nowIso() }};
    await updateJob(job.id, { status:"completed", stage:"completed", progress:100, result_payload:result, partial_result:result, completed_at:nowIso(), error_message:null });
  } catch (e) {
    const attempts = Number(job.attempts || 0) + 1, retry = attempts < MAX_JOB_ATTEMPTS;
    await updateJob(job.id, { status:retry ? "queued" : "failed", stage:retry ? "retry queued" : "failed", progress:retry ? 0 : 100, error_message:e.message, attempts, locked_at:null });
  } finally { activeJobs = Math.max(0, activeJobs-1); }
}

async function pollJobs() {
  if (activeJobs >= MAX_CONCURRENT_JOBS) return;
  const data = await supabase.from("grading_jobs").select("*").eq("status","queued").order("created_at",{ascending:true}).limit(MAX_CONCURRENT_JOBS-activeJobs);
  if (data.error) { console.error("job poll failed", data.error.message); return; }
  for (const job of data.data || []) processJob(job).catch(e => console.error("job error", e));
}
setInterval(() => pollJobs().catch(e => console.error("poll loop failed", e)), 2500);

app.post("/api/jobs/create", async (req,res) => {
  try {
    const user = await getUser(req), payload = req.body || {};
    const criteria = dedupeCriteria(payload?.briefInterpretation?.criteria?.length ? payload.briefInterpretation.criteria : payload.criteria || []);
    if (!Array.isArray(payload.files) || !payload.files.length) return jsonError(res, 400, "No files provided");
    if (!criteria.length) return jsonError(res, 400, "No criteria provided");
    const jobIns = await supabase.from("grading_jobs").insert([{ user_id:user?.id || null, user_email:user?.email || "", status:"queued", stage:"queued", progress:0, input_payload:{ ...payload, criteria, briefInterpretation:{ ...(payload.briefInterpretation || {}), criteria }}}]).select("*").single();
    if (jobIns.error) throw jobIns.error;
    const rows = criteria.map((c,i) => ({ job_id:jobIns.data.id, criterion_code:c.code, sort_order:i, status:"queued" }));
    const critIns = await supabase.from("grading_job_criteria").insert(rows);
    if (critIns.error) throw critIns.error;
    pollJobs().catch(console.error);
    return res.json({ jobId:jobIns.data.id, status:jobIns.data.status, stage:jobIns.data.stage, progress:jobIns.data.progress });
  } catch (e) { console.error("create job failed", e); return jsonError(res, 500, e.message); }
});

app.get("/api/jobs/:jobId", async (req,res) => {
  try {
    const job = await supabase.from("grading_jobs").select("*").eq("id", req.params.jobId).maybeSingle();
    if (job.error) throw job.error;
    if (!job.data) return jsonError(res, 404, "Job not found");
    const crit = await supabase.from("grading_job_criteria").select("*").eq("job_id", job.data.id).order("sort_order",{ascending:true});
    if (crit.error) throw crit.error;
    return res.json({ id:job.data.id, status:job.data.status, stage:job.data.stage, progress:job.data.progress, error:job.data.error_message, partialResult:job.data.partial_result, result:job.data.result_payload, criteria:crit.data || [] });
  } catch (e) { return jsonError(res, 500, e.message); }
});

app.post("/api/records/save", async (req,res) => {
  try {
    const user = await getUser(req), result = req.body?.result || {};
    const row = { user_id:user?.id || null, user_email:user?.email || "", learner_name:result.fullName || "Learner Submission", unit:req.body?.unit || result.unitInfo || "", grade:result.grade || "", record_status:result.recordControl?.recordStatus || "Draft", data:result };
    const r = await supabase.from("feedback_records").insert([row]).select("id").single();
    if (r.error) throw r.error;
    res.json({ id:r.data.id });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/records/update", async (req,res) => {
  try {
    const { dbId, result } = req.body || {};
    if (!dbId) return jsonError(res, 400, "dbId is required");
    const r = await supabase.from("feedback_records").update({ learner_name:result?.fullName || "Learner Submission", unit:result?.unitInfo || "", grade:result?.grade || "", record_status:result?.recordControl?.recordStatus || "Draft", data:result || {}, updated_at:nowIso() }).eq("id", dbId);
    if (r.error) throw r.error;
    res.json({ ok:true });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.get("/api/records/list", async (req,res) => {
  try {
    const user = await getUser(req);
    if (!user) return jsonError(res, 401, "Login required");
    const r = await supabase.from("feedback_records").select("id, learner_name, unit, grade, record_status, created_at, updated_at").eq("user_id", user.id).order("created_at",{ascending:false}).limit(50);
    if (r.error) throw r.error;
    res.json({ records:r.data || [] });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/records/load", async (req,res) => {
  try {
    const user = await getUser(req);
    if (!user) return jsonError(res, 401, "Login required");
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    let q = supabase.from("feedback_records").select("*").eq("user_id", user.id).order("created_at",{ascending:false});
    q = ids.length ? q.in("id", ids) : q.limit(20);
    const r = await q;
    if (r.error) throw r.error;
    res.json({ records:r.data || [] });
  } catch (e) { jsonError(res, 500, e.message); }
});

app.post("/api/records/action", (req,res) => {
  const action = req.body?.action || "";
  let recordStatus = "Draft";
  if (["review","mark-reviewed","mark_reviewed"].includes(action)) recordStatus = "Assessor Reviewed";
  else if (["signoff","sign-off","sign_off"].includes(action)) recordStatus = "Assessor Signed Off";
  else if (["require-iv","require_iv","iv"].includes(action)) recordStatus = "IV Required";
  else if (["start-iv","start_iv"].includes(action)) recordStatus = "IV In Review";
  else if (["approve-iv","approve_iv"].includes(action)) recordStatus = "IV Approved";
  else if (["return-iv","return_from_iv"].includes(action)) recordStatus = "IV Returned";
  else if (action === "release") recordStatus = "Released";
  res.json({ ok:true, recordStatus });
});

function escapeHtml(v="") { return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
app.post("/api/export/feedback-docx", (req,res) => {
  const result = req.body?.result || {}, audit = Array.isArray(result.audit) ? result.audit : [];
  const rows = audit.map(i => `<tr><td style="border:1px solid #000;padding:8px"><b>${escapeHtml(i.id)}</b><br>${escapeHtml(i.requirement)}</td><td style="border:1px solid #000;padding:8px">${escapeHtml(i.finalStatus||i.status)}</td><td style="border:1px solid #000;padding:8px"><b>Evidence location:</b><br>${escapeHtml(i.evidencePage)}<br><br><b>Evidence and depth:</b><br>${escapeHtml(i.evidenceAndDepth)}<br><br><b>Rationale:</b><br>${escapeHtml(i.rationale)}<br><br><b>Development:</b><br>${escapeHtml(i.action)}</td></tr>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:Arial"><h1>BTEC Assessment Feedback Record</h1><p><b>Learner:</b> ${escapeHtml(result.fullName||"")}</p><p><b>Unit:</b> ${escapeHtml(result.unitInfo||"")}</p><p><b>Assessor:</b> ${escapeHtml(result.assessorName||"")}</p><p><b>Status:</b> ${escapeHtml(result.grade||"")}</p><h2>Developmental Summary</h2><p>${escapeHtml(result.developmentalSummary||"")}</p><table style="width:100%;border-collapse:collapse"><tr><th style="border:1px solid #000;padding:8px">Criterion</th><th style="border:1px solid #000;padding:8px">Status</th><th style="border:1px solid #000;padding:8px">Feedback</th></tr>${rows}</table></body></html>`;
  res.setHeader("Content-Type","application/msword");
  res.setHeader("Content-Disposition",`attachment; filename="feedback-record-${Date.now()}.doc"`);
  res.send(Buffer.from("\ufeff"+html,"utf8"));
});

app.post("/api/export/iv-log", (req,res) => {
  const result = req.body?.result || {}, audit = Array.isArray(result.audit) ? result.audit : [];
  const rows = [["Learner","Unit","Grade","Generated"],[result.fullName||"",result.unitInfo||"",result.grade||"",new Date().toLocaleString("en-GB")],[],["Criterion","Status","Evidence location","Confidence"]];
  audit.forEach(i => rows.push([i.id||"",i.finalStatus||i.status||"",i.evidencePage||"",i.confidenceScore||""]));
  const csv = rows.map(row => row.map(cell => `"${String(cell??"").replace(/"/g,'""')}"`).join(",")).join("\n");
  res.setHeader("Content-Type","text/csv;charset=utf-8");
  res.setHeader("Content-Disposition",`attachment; filename="iv-log-${Date.now()}.csv"`);
  res.send("\ufeff"+csv);
});

app.use((error,_req,res,_next) => {
  console.error("Unhandled backend error", error);
  jsonError(res, 500, "Unexpected backend error", error.message);
});

app.listen(PORT, () => console.log(`MGTS backend v6 running on port ${PORT}`));
