const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const mammoth = require("mammoth");
const JSZip = require("jszip");
const { createClient } = require("@supabase/supabase-js");
const {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType
} = require("docx");

const app = express();
function noCache(res) { res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate"); res.setHeader("Pragma","no-cache"); res.setHeader("Expires","0"); }
app.use(cors());
app.use(express.json({ limit: "60mb" }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const MODEL_CASCADE = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
const JOB_POLL_INTERVAL_MS = Number(process.env.JOB_POLL_INTERVAL_MS || 2500);
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 1);
const EXTRACTION_CHUNK_SIZE = Number(process.env.EXTRACTION_CHUNK_SIZE || 2400);
const EXTRACTION_CHUNK_OVERLAP = Number(process.env.EXTRACTION_CHUNK_OVERLAP || 350);

let activeJobs = 0;

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeParse(text = "") {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch {}
    }
    return {};
  }
}

function cleanText(s = "") {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function sha256(text = "") {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function isRetryableGeminiError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  return msg.includes("503") || msg.includes("429") || msg.includes("overloaded") || msg.includes("high demand") || msg.includes("unavailable") || msg.includes("try again later");
}

async function callGeminiModel(model, parts, temperature = 0.0) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        generationConfig: {
          temperature,
          topP: 0.1,
          topK: 1,
          responseMimeType: "application/json",
          maxOutputTokens: 3072
        },
        contents: [{ parts }]
      })
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Gemini request failed with status ${response.status}`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return safeParse(text);
}

async function runGeminiWithFallback(parts, options = {}) {
  const { temperature = 0.0, maxRetriesPerModel = 2, initialDelayMs = 900 } = options;
  const errors = [];

  for (const model of MODEL_CASCADE) {
    let delay = initialDelayMs;
    for (let attempt = 1; attempt <= maxRetriesPerModel; attempt += 1) {
      try {
        const parsed = await callGeminiModel(model, parts, temperature);
        return { parsed, model };
      } catch (error) {
        errors.push({ model, attempt, message: error.message });
        if (!isRetryableGeminiError(error) || attempt === maxRetriesPerModel) break;
        await sleep(delay);
        delay *= 2;
      }
    }
  }

  const summary = errors.map(e => `${e.model}#${e.attempt}: ${e.message}`).join(" | ");
  throw new Error(`All Gemini model attempts failed. ${summary}`);
}

function normaliseCriterionCode(code = "") {
  return String(code).toUpperCase().replace(/[^PMD0-9]/g, "");
}

function normaliseStatus(value = "") {
  const v = String(value).trim().toLowerCase();
  if (v === "achieved") return "Achieved";
  if (v === "not achieved") return "Not Achieved";
  if (v === "review required") return "Review Required";
  if (v.includes("not")) return "Not Achieved";
  if (v.includes("review")) return "Review Required";
  if (v.includes("ach")) return "Achieved";
  return "Review Required";
}

function deriveBandFromCode(code = "") {
  const c = normaliseCriterionCode(code);
  if (c.startsWith("P")) return "P";
  if (c.startsWith("M")) return "M";
  if (c.startsWith("D")) return "D";
  return "";
}

function commandVerbHintsFromRequirement(text = "") {
  const lower = String(text).toLowerCase();
  const verbs = [];
  ["identify", "describe", "explain", "analyse", "analyze", "evaluate", "justify", "compare", "assess", "determine", "produce", "maintain", "develop"].forEach(v => {
    if (lower.includes(v)) verbs.push(v);
  });
  return verbs;
}

function bandExpectationText(code = "", requirement = "") {
  const band = deriveBandFromCode(code);
  const req = String(requirement || "").toLowerCase();
  if (band === "P") return "Pass criteria require clear coverage of the stated requirement through accurate explanation, application, production, or completion of the required task.";
  if (band === "M") {
    if (req.includes("analyse") || req.includes("analyze")) return "Merit criteria at analyse level require developed analysis, not simple description. The learner should break down factors, relationships, and implications with clear technical depth.";
    if (req.includes("justify")) return "Merit criteria at justify level require supported reasoning rather than simple assertion.";
    return "Merit criteria require stronger depth, analytical value, comparison, application, or reasoned support beyond pass-level coverage.";
  }
  if (band === "D") {
    if (req.includes("evaluate")) return "Distinction criteria at evaluate level require critical judgement, balanced consideration, strengths and limitations, and reasoned conclusions.";
    if (req.includes("justify")) return "Distinction criteria at justify level require well-supported, independent reasoning that is clearly argued and defensible.";
    return "Distinction criteria require critical, evaluative, or independent higher-level performance rather than basic explanation.";
  }
  return "";
}

function dedupeCriteria(criteria = []) {
  const seen = new Set();
  return criteria
    .map(item => ({
      code: normaliseCriterionCode(item.code || ""),
      requirement: String(item.requirement || "").trim(),
      band: String(item.band || "").trim().toUpperCase() || deriveBandFromCode(item.code || ""),
      linkedLearningAims: Array.isArray(item.linkedLearningAims) ? item.linkedLearningAims : [],
      linkedTasks: Array.isArray(item.linkedTasks) ? item.linkedTasks : [],
      commandVerbs: Array.isArray(item.commandVerbs) ? item.commandVerbs : commandVerbHintsFromRequirement(item.requirement || "")
    }))
    .filter(item => /^[PMD]\d+$/.test(item.code) && item.requirement)
    .filter(item => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    });
}

function detectConfidenceClass(score) {
  const num = Number(score || 0);
  if (num >= 85) return "high";
  if (num >= 60) return "medium";
  return "low";
}

function buildCriterionAwareFallback(requirement, type) {
  const req = String(requirement || "this criterion").trim();
  if (type === "evidence") return `The submission contains some potentially relevant material, but the evidence for "${req}" is not yet explicit enough, sufficiently developed, or securely identifiable to support a confident judgement.`;
  if (type === "rationale") return `The current response does not yet demonstrate "${req}" with enough clarity, depth, or direct alignment to confirm consistent performance against this criterion.`;
  return `Further development should focus on producing clearer, more explicit evidence for "${req}", with fuller explanation, stronger application, and material that can be clearly identified in the submitted work.`;
}

function normaliseEvidenceLocation(loc, requirement) {
  const value = String(loc || "").trim();
  if (value.length >= 4) return value;
  return `Evidence for "${requirement}" is not yet clearly identified in the submitted files`;
}

function calculateGrade(audit = []) {
  const hasNotAchieved = audit.some(a => normaliseStatus(a.finalStatus || a.status) === "Not Achieved");
  const hasReview = audit.some(a => normaliseStatus(a.finalStatus || a.status) === "Review Required");
  if (hasNotAchieved) return "Not Achieved";
  if (hasReview) return "Review Required";
  return "Achieved";
}

function buildBandSummary(audit = []) {
  const summary = {
    P: { achieved: 0, reviewRequired: 0, notAchieved: 0, total: 0 },
    M: { achieved: 0, reviewRequired: 0, notAchieved: 0, total: 0 },
    D: { achieved: 0, reviewRequired: 0, notAchieved: 0, total: 0 }
  };
  audit.forEach(item => {
    const band = deriveBandFromCode(item.id || "");
    if (!summary[band]) return;
    summary[band].total += 1;
    const status = normaliseStatus(item.finalStatus || item.status);
    if (status === "Achieved") summary[band].achieved += 1;
    else if (status === "Not Achieved") summary[band].notAchieved += 1;
    else summary[band].reviewRequired += 1;
  });
  return summary;
}

function buildOverallSummary(audit = []) {
  const achieved = audit.filter(a => normaliseStatus(a.finalStatus || a.status) === "Achieved").length;
  const review = audit.filter(a => normaliseStatus(a.finalStatus || a.status) === "Review Required").length;
  const notAchieved = audit.filter(a => normaliseStatus(a.finalStatus || a.status) === "Not Achieved").length;
  if (review === 0 && notAchieved === 0) return "The submission demonstrates secure coverage across the assessed criteria, with evidence that is generally identifiable, relevant, and aligned to the assignment requirements. Further development should focus on consolidating depth, precision, and higher-order reasoning where appropriate.";
  if (achieved > 0 && (review > 0 || notAchieved > 0)) return "The submission contains some relevant and potentially creditworthy material, but criterion coverage is uneven and several judgements remain limited by weak, partial, or insufficiently explicit evidence. The next stage of development should focus on making evidence easier to identify, deepening technical explanation, and ensuring each criterion is addressed directly and convincingly.";
  return "At present, the submission does not yet provide sufficiently secure, consistent, and clearly identifiable evidence across the assessed criteria. Priority should be given to producing more explicit criterion-linked material, fuller technical explanation, and stronger evidence that can be judged confidently against the assessment requirements.";
}

function ensureRecordControl(result = {}) {
  result.recordControl = { recordStatus: "Draft", ivRequired: false, ...result.recordControl };
  return result;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function getOptionalUserFromRequest(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

function inferMimeType(filename = "") {
  const f = filename.toLowerCase();
  if (f.endsWith(".pdf")) return "application/pdf";
  if (f.endsWith(".png")) return "image/png";
  if (f.endsWith(".jpg") || f.endsWith(".jpeg")) return "image/jpeg";
  if (f.endsWith(".webp")) return "image/webp";
  if (f.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (f.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (f.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

async function extractDocx(base64) {
  const buffer = Buffer.from(base64, "base64");
  const result = await mammoth.extractRawText({ buffer });
  return String(result.value || "").trim();
}

async function extractTxt(base64) {
  return Buffer.from(base64, "base64").toString("utf8");
}

async function extractPptx(base64) {
  const buffer = Buffer.from(base64, "base64");
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const aNum = Number((a.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      const bNum = Number((b.match(/slide(\d+)\.xml/i) || [])[1] || 0);
      return aNum - bNum;
    });
  const out = [];
  for (const slide of slides) {
    const xml = await zip.files[slide].async("string");
    const matches = [...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)];
    const text = matches.map(m => m[1]).join(" ").replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  return out.join("\n\n");
}

function chunkText(text = "", size = EXTRACTION_CHUNK_SIZE, overlap = EXTRACTION_CHUNK_OVERLAP) {
  const clean = String(text || "").replace(/\r/g, "");
  if (!clean.trim()) return [];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(clean.length, start + size);
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

async function getOrCreateExtractionCache(file) {
  const filename = file.filename || "file";
  const role = file.role || "general";
  const mimeType = inferMimeType(filename);
  const fileHash = sha256(file.fileBase64 || "");

  const { data: existing, error: selectErr } = await supabase
    .from("submission_file_cache")
    .select("*")
    .eq("file_hash", fileHash)
    .maybeSingle();
  if (selectErr) throw selectErr;
  if (existing) return existing;

  let extractedText = "";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") extractedText = await extractDocx(file.fileBase64);
  else if (mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") extractedText = await extractPptx(file.fileBase64);
  else if (mimeType === "text/plain") extractedText = await extractTxt(file.fileBase64);

  const chunks = chunkText(extractedText).map((chunk, idx) => ({ idx, text: chunk }));
  const row = {
    file_hash: fileHash,
    filename,
    role,
    mime_type: mimeType,
    extracted_text: extractedText || "",
    chunks_json: chunks,
    text_length: extractedText.length
  };

  const { data: inserted, error: insertErr } = await supabase
    .from("submission_file_cache")
    .insert([row])
    .select("*")
    .single();
  if (insertErr) throw insertErr;
  return inserted;
}

app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { filename, fileBase64 } = req.body || {};
    if (!filename || !fileBase64) return jsonError(res, 400, "filename and fileBase64 are required");

    const lower = filename.toLowerCase();
    let text = "";
    if (lower.endsWith(".docx")) text = await extractDocx(fileBase64);
    else if (lower.endsWith(".txt")) text = await extractTxt(fileBase64);
    else return jsonError(res, 400, "Brief scan currently supports DOCX and TXT reliably in this build.");

    const prompt = `
You are extracting BTEC assignment brief criteria and context.

Return ONLY JSON:
{
  "unitTitle":"",
  "unitNumber":"",
  "learningAims":[],
  "tasks":[],
  "criteria":[
    {
      "code":"P1",
      "requirement":"",
      "band":"P",
      "linkedLearningAims":[],
      "linkedTasks":[],
      "commandVerbs":[]
    }
  ],
  "commandVerbIndex":[],
  "assignmentContext":"",
  "unitContext":"",
  "evidenceRequirements":[],
  "ambiguityFlags":[],
  "extractedFrom":"${filename}",
  "schemaVersion":"brief.v1"
}

Rules:
- Extract all valid P, M, D criteria.
- Normalise codes.
- Remove duplicates.
- Return JSON only.

Brief text:
${text}
`;

    let parsed = {};
    let modelUsed = "";
    try {
      const result = await runGeminiWithFallback([{ text: prompt }], { temperature: 0.05, maxRetriesPerModel: 2, initialDelayMs: 1000 });
      parsed = result.parsed || {};
      modelUsed = result.model || "";
    } catch {
      parsed = {};
    }

    let criteria = dedupeCriteria(Array.isArray(parsed.criteria) ? parsed.criteria : []);
    if (!criteria.length) {
      const fallback = [];
      const seen = new Set();
      const regex = /\b([PMD]\d+)\b[\s:.\-–—]+([^\n\r]+)/gi;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const code = normaliseCriterionCode(match[1]);
        const requirement = String(match[2] || "").trim();
        if (/^[PMD]\d+$/.test(code) && requirement && !seen.has(code)) {
          seen.add(code);
          fallback.push({
            code,
            requirement,
            band: deriveBandFromCode(code),
            linkedLearningAims: [],
            linkedTasks: [],
            commandVerbs: commandVerbHintsFromRequirement(requirement)
          });
        }
      }
      criteria = fallback;
    }

    return res.json({
      result: {
        unitTitle: String(parsed.unitTitle || "").trim(),
        unitNumber: String(parsed.unitNumber || "").trim(),
        learningAims: Array.isArray(parsed.learningAims) ? parsed.learningAims : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        criteria,
        commandVerbIndex: Array.isArray(parsed.commandVerbIndex) ? parsed.commandVerbIndex : [],
        assignmentContext: String(parsed.assignmentContext || "").trim(),
        unitContext: String(parsed.unitContext || "").trim(),
        evidenceRequirements: Array.isArray(parsed.evidenceRequirements) ? parsed.evidenceRequirements : [],
        ambiguityFlags: Array.isArray(parsed.ambiguityFlags) ? parsed.ambiguityFlags : [],
        extractedFrom: parsed.extractedFrom || filename,
        schemaVersion: parsed.schemaVersion || "brief.v1",
        modelUsed
      }
    });
  } catch (err) {
    console.error("scan-file failed:", err);
    return jsonError(res, 500, err.message);
  }
});

function simpleKeywordScore(criterion, chunk) {
  const req = `${criterion.code} ${criterion.requirement}`.toLowerCase();
  const words = req.split(/[^a-z0-9]+/).filter(w => w.length > 3);
  const text = String(chunk || "").toLowerCase();
  let score = 0;
  for (const w of words) if (text.includes(w)) score += 1;
  return score;
}

async function retrieveTopChunksForCriterion(criterion, cacheRows) {
  const scored = [];
  for (const file of cacheRows) {
    const chunks = Array.isArray(file.chunks_json) ? file.chunks_json : [];
    for (const chunk of chunks) {
      const score = simpleKeywordScore(criterion, chunk.text || "");
      if (score > 0) {
        scored.push({
          file: file.filename,
          role: file.role,
          location: `Chunk ${Number(chunk.idx) + 1}`,
          text: cleanText(chunk.text).slice(0, 1200),
          score
        });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 6);
}

async function assessCriterionSinglePass(criterion, brief, cacheRows) {
  const topChunks = await retrieveTopChunksForCriterion(criterion, cacheRows);
  const chunkBlock = topChunks.length
    ? topChunks.map((c, i) => `MATCH ${i + 1}\nFILE: ${c.file}\nROLE: ${c.role}\nLOCATION: ${c.location}\nTEXT: ${c.text}`).join("\n\n")
    : "[No strong text matches were retrieved.]";

  const prompt = `
You are a strict, highly consistent Pearson BTEC assessor.

Assess ONLY this one criterion.

Return ONLY JSON:
{
  "id":"${criterion.code}",
  "status":"Achieved | Not Achieved | Review Required",
  "finalStatus":"Achieved | Not Achieved | Review Required",
  "evidencePage":"best file/location reference",
  "evidenceAndDepth":"2 to 4 sentences. Evidence-led. Criterion-specific. No boilerplate.",
  "rationale":"2 to 4 sentences. Explain why the evidence does or does not securely support the criterion.",
  "action":"2 to 3 sentences. Specific development needed. No prohibited signposting.",
  "confidenceScore":65
}

STRICT RULES:
- Assess ONLY this criterion.
- Use the retrieved evidence first.
- Default to a conservative judgement where evidence is weak, partial, implied, or not securely identifiable.
- Do not infer generous achievement.
- Distinguish clearly between pass-level coverage and merit/distinction depth.
- Use the exact criterion requirement as your anchor.
- Do not repeat stock wording.
- If a criterion appears only partially addressed, use Review Required or Not Achieved.
- If no secure evidence location exists, say so.
- Keep wording professional, compact, and commercially credible.
- Return JSON only.

Criterion:
${criterion.code}: ${criterion.requirement}

Band expectation:
${bandExpectationText(criterion.code, criterion.requirement)}

Command verbs:
${JSON.stringify(criterion.commandVerbs || [])}

Brief context:
${JSON.stringify({
  tasks: brief.tasks || [],
  learningAims: brief.learningAims || [],
  assignmentContext: brief.assignmentContext || "",
  evidenceRequirements: brief.evidenceRequirements || [],
  ambiguityFlags: brief.ambiguityFlags || []
})}

Retrieved evidence candidates:
${chunkBlock}
`;

  const result = await runGeminiWithFallback([{ text: prompt }], { temperature: 0.0, maxRetriesPerModel: 2, initialDelayMs: 1200 });
  const parsed = result.parsed || {};

  return {
    id: criterion.code,
    requirement: criterion.requirement,
    status: normaliseStatus(parsed.status || "Review Required"),
    finalStatus: normaliseStatus(parsed.finalStatus || parsed.status || "Review Required"),
    evidencePage: normaliseEvidenceLocation(parsed.evidencePage || (topChunks[0] ? `${topChunks[0].file} - ${topChunks[0].location}` : ""), criterion.requirement),
    evidenceAndDepth: cleanText(parsed.evidenceAndDepth).length > 20 ? cleanText(parsed.evidenceAndDepth) : buildCriterionAwareFallback(criterion.requirement, "evidence"),
    rationale: cleanText(parsed.rationale).length > 20 ? cleanText(parsed.rationale) : buildCriterionAwareFallback(criterion.requirement, "rationale"),
    action: cleanText(parsed.action).length > 20 ? cleanText(parsed.action) : buildCriterionAwareFallback(criterion.requirement, "action"),
    confidenceScore: Number(parsed.confidenceScore || 40),
    confidenceClass: detectConfidenceClass(parsed.confidenceScore || 40),
    topEvidence: topChunks,
    modelUsed: result.model || ""
  };
}

async function updateJob(jobId, patch) {
  const { error } = await supabase.from("grading_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", jobId);
  if (error) throw error;
}

async function updateJobCriterion(jobId, criterionCode, patch) {
  const { error } = await supabase
    .from("grading_job_criteria")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("job_id", jobId)
    .eq("criterion_code", criterionCode);
  if (error) throw error;
}


async function waitIfPausedOrCancelled(jobId) {
  while (true) {
    const { data, error } = await supabase.from("grading_jobs").select("status").eq("id", jobId).maybeSingle();
    if (error) throw error;
    const status = data?.status || "";
    if (status === "cancelled") return "cancelled";
    if (status !== "paused") return status;
    await updateJob(jobId, { stage: "paused" });
    await new Promise(resolve => setTimeout(resolve, Number(process.env.PAUSE_CHECK_MS || 2500)));
  }
}

async function processJob(job) {
  activeJobs += 1;
  try {
    const payload = job.input_payload || {};
    const files = Array.isArray(payload.files) ? payload.files : [];
    const criteria = Array.isArray(payload.criteria) ? payload.criteria : [];
    const brief = payload.briefInterpretation || {};

    const criteriaSource = Array.isArray(brief.criteria) && brief.criteria.length ? dedupeCriteria(brief.criteria) : dedupeCriteria(criteria);
    if (!criteriaSource.length) throw new Error("No criteria provided");

    await updateJob(job.id, { status: "processing", stage: "extracting", progress: 5 });

    if ((await waitIfPausedOrCancelled(job.id)) === "cancelled") return;

    const meta = {
      learnerName: String(payload.learnerName || "").trim(),
      submissionType: String(payload.submissionType || "First submission").trim(),
      internalVerifierName: String(payload.internalVerifierName || "").trim(),
      cohortName: String(payload.cohortName || "").trim(),
      assessmentMode: String(payload.assessmentMode || "").trim(),
      qualificationLevel: String(payload.qualificationLevel || "").trim(),
      unitInfo: String(payload.unitInfo || "").trim(),
      assessorName: String(payload.assessorName || "").trim(),
      programmePathway: String(payload.programmePathway || "").trim()
    };

    const cacheRows = [];
    for (let i = 0; i < files.length; i += 1) {
      if ((await waitIfPausedOrCancelled(job.id)) === "cancelled") return;
      const row = await getOrCreateExtractionCache(files[i]);
      cacheRows.push(row);
      const progress = 5 + Math.round(((i + 1) / Math.max(files.length, 1)) * 20);
      await updateJob(job.id, { stage: "extracting", progress });
    }

    const gradingModels = [];
    const audit = [];
    await updateJob(job.id, { stage: "grading", progress: 30 });

    for (let i = 0; i < criteriaSource.length; i += 1) {
      if ((await waitIfPausedOrCancelled(job.id)) === "cancelled") return;
      const criterion = criteriaSource[i];
      await updateJobCriterion(job.id, criterion.code, { status: "processing" });

      const assessed = await assessCriterionSinglePass(criterion, brief, cacheRows);
      if ((await waitIfPausedOrCancelled(job.id)) === "cancelled") return;
      if (assessed.modelUsed) gradingModels.push(assessed.modelUsed);
      audit.push(assessed);

      await updateJobCriterion(job.id, criterion.code, { status: "completed", result_json: assessed });

      const progress = 30 + Math.round(((i + 1) / Math.max(criteriaSource.length, 1)) * 60);
      await updateJob(job.id, {
        stage: "grading",
        progress,
        partial_result: { fullName: meta.learnerName || "Learner Submission", audit }
      });
    }

    const finalAudit = criteriaSource.map(c => {
      const found = audit.find(a => normaliseCriterionCode(a.id) === normaliseCriterionCode(c.code)) || {};
      return {
        id: normaliseCriterionCode(c.code),
        requirement: c.requirement,
        status: normaliseStatus(found.status || "Review Required"),
        finalStatus: normaliseStatus(found.finalStatus || found.status || "Review Required"),
        evidencePage: normaliseEvidenceLocation(found.evidencePage, c.requirement),
        evidenceAndDepth: cleanText(found.evidenceAndDepth).length > 20 ? cleanText(found.evidenceAndDepth) : buildCriterionAwareFallback(c.requirement, "evidence"),
        rationale: cleanText(found.rationale).length > 20 ? cleanText(found.rationale) : buildCriterionAwareFallback(c.requirement, "rationale"),
        action: cleanText(found.action).length > 20 ? cleanText(found.action) : buildCriterionAwareFallback(c.requirement, "action"),
        confidenceScore: Number(found.confidenceScore || 40),
        confidenceClass: detectConfidenceClass(found.confidenceScore || 40),
        topEvidence: Array.isArray(found.topEvidence) ? found.topEvidence : []
      };
    });

    const result = ensureRecordControl({
      fullName: meta.learnerName || "Learner Submission",
      submissionType: meta.submissionType,
      internalVerifierName: meta.internalVerifierName,
      cohortName: meta.cohortName,
      qualificationLevel: meta.qualificationLevel,
      assessorName: meta.assessorName,
      unitInfo: meta.unitInfo,
      assessmentMode: meta.assessmentMode,
      programmePathway: meta.programmePathway,
      audit: finalAudit,
      grade: calculateGrade(finalAudit),
      overallBandSummary: buildBandSummary(finalAudit),
      developmentalSummary: buildOverallSummary(finalAudit),
      briefInterpretation: brief,
      meta: {
        generatedAt: new Date().toISOString(),
        gradingModelsUsed: [...new Set(gradingModels)]
      }
    });

    await updateJob(job.id, {
      status: "completed",
      stage: "completed",
      progress: 100,
      result_payload: result,
      partial_result: result,
      error_message: null
    });
  } catch (err) {
    console.error(`Job ${job.id} failed:`, err);
    await updateJob(job.id, { status: "failed", stage: "failed", error_message: err.message, progress: 100 });
  } finally {
    activeJobs = Math.max(0, activeJobs - 1);
  }
}

async function pollForQueuedJobs() {
  if (activeJobs >= MAX_CONCURRENT_JOBS) return;
  const { data, error } = await supabase
    .from("grading_jobs")
    .select("*")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(10);
  if (error) {
    console.error("pollForQueuedJobs:", error.message);
    return;
  }
  for (const job of data || []) {
    if (activeJobs >= MAX_CONCURRENT_JOBS) break;
    processJob(job).catch(err => console.error("processJob unhandled:", err));
  }
}

setInterval(() => { pollForQueuedJobs().catch(err => console.error("job poll loop:", err)); }, JOB_POLL_INTERVAL_MS);


async function getJobStatus(jobId) {
  const { data, error } = await supabase
    .from("grading_jobs")
    .select("status")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  return data?.status || "";
}

app.post("/api/jobs/create", async (req, res) => {
  try {
    const user = await getOptionalUserFromRequest(req);
    const payload = req.body || {};
    const brief = payload.briefInterpretation || {};
    const criteria = Array.isArray(brief.criteria) && brief.criteria.length ? dedupeCriteria(brief.criteria) : dedupeCriteria(Array.isArray(payload.criteria) ? payload.criteria : []);

    if (!Array.isArray(payload.files) || !payload.files.length) return jsonError(res, 400, "No files provided");
    if (!criteria.length) return jsonError(res, 400, "No criteria provided");

    const payloadHash = sha256(JSON.stringify({
      learnerName: payload.learnerName || "",
      unitInfo: payload.unitInfo || "",
      criteria,
      files: payload.files.map(f => ({ filename: f.filename, role: f.role || "general", hash: sha256(f.fileBase64 || "") }))
    }));

    const { data: job, error: jobErr } = await supabase
      .from("grading_jobs")
      .insert([{
        user_id: user?.id || null,
        user_email: user?.email || "",
        status: "queued",
        stage: "queued",
        progress: 0,
        payload_hash: payloadHash,
        input_payload: payload,
        partial_result: null,
        result_payload: null,
        error_message: null
      }])
      .select("*")
      .single();
    if (jobErr) throw jobErr;

    const rows = criteria.map((c, idx) => ({
      job_id: job.id,
      criterion_code: c.code,
      sort_order: idx,
      status: "queued",
      result_json: null
    }));

    const { error: critErr } = await supabase.from("grading_job_criteria").insert(rows);
    if (critErr) throw critErr;

    pollForQueuedJobs().catch(err => console.error("poll start:", err));

    return res.json({ jobId: job.id, status: job.status, stage: job.stage, progress: job.progress });
  } catch (err) {
    console.error("jobs/create failed:", err);
    return jsonError(res, 500, err.message);
  }
});

app.get("/api/jobs/:jobId", async (req, res) => {
  noCache(res);
  try {
    const user = await getOptionalUserFromRequest(req);
    const { jobId } = req.params;

    const { data: job, error } = await supabase.from("grading_jobs").select("*").eq("id", jobId).maybeSingle();
    if (error) throw error;
    if (!job) return jsonError(res, 404, "Job not found");
    if (user?.id && job.user_id && job.user_id !== user.id) return jsonError(res, 403, "Forbidden");

    const { data: criteriaRows, error: critErr } = await supabase
      .from("grading_job_criteria")
      .select("*")
      .eq("job_id", jobId)
      .order("sort_order", { ascending: true });
    if (critErr) throw critErr;

    return res.json({
      id: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      error: job.error_message,
      partialResult: job.partial_result,
      result: job.result_payload,
      criteria: criteriaRows || []
    });
  } catch (err) {
    console.error("jobs/get failed:", err);
    return jsonError(res, 500, err.message);
  }
});

app.post("/api/grade/submission-multi", async (req, res) => {
  req.url = "/api/jobs/create";
  return app._router.handle(req, res, () => {});
});

app.post("/api/grade/submission", async (req, res) => {
  req.url = "/api/jobs/create";
  return app._router.handle(req, res, () => {});
});


app.post("/api/jobs/:jobId/cancel", async (req, res) => {
  noCache(res);
  try {
    await updateJob(req.params.jobId, {
      status: "cancelled",
      stage: "cancelled",
      progress: 100,
      error_message: "Job cancelled by user",
      locked_at: null,
      completed_at: new Date().toISOString()
    });
    return res.json({ ok: true, status: "cancelled" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/jobs/:jobId/pause", async (req, res) => {
  noCache(res);
  try {
    const status = await getJobStatus(req.params.jobId);
    if (["completed", "failed", "cancelled"].includes(status)) {
      return res.status(400).json({ error: `Cannot pause job with status ${status}` });
    }
    await updateJob(req.params.jobId, { status: "paused", stage: "paused" });
    return res.json({ ok: true, status: "paused" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/jobs/:jobId/resume", async (req, res) => {
  noCache(res);
  try {
    const status = await getJobStatus(req.params.jobId);
    if (status !== "paused") {
      return res.status(400).json({ error: `Cannot resume job with status ${status}` });
    }
    await updateJob(req.params.jobId, { status: "queued", stage: "resume queued", locked_at: null });
    if (typeof pollJobs === "function") pollJobs().catch(console.error);
    return res.json({ ok: true, status: "queued" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post("/api/records/save", async (req, res) => {
  try {
    const user = await getOptionalUserFromRequest(req);
    const { result } = req.body || {};
    const { data, error } = await supabase
      .from("feedback_records")
      .insert([{
        user_id: user?.id || null,
        user_email: user?.email || "",
        learner_name: result?.fullName || "Learner Submission",
        grade: result?.grade || "",
        record_status: result?.recordControl?.recordStatus || "Draft",
        data: ensureRecordControl(result || {})
      }])
      .select("id")
      .single();
    if (error) throw error;
    return res.json({ id: data.id });
  } catch (err) {
    console.error("records/save failed:", err);
    return jsonError(res, 500, err.message);
  }
});

app.post("/api/records/update", async (req, res) => {
  try {
    const user = await getOptionalUserFromRequest(req);
    const { dbId, result } = req.body || {};
    if (!dbId || !result) return jsonError(res, 400, "dbId and result are required");

    let query = supabase
      .from("feedback_records")
      .update({
        learner_name: result.fullName || "Learner Submission",
        grade: result.grade || "",
        record_status: result?.recordControl?.recordStatus || "Draft",
        data: ensureRecordControl(result),
        updated_at: new Date().toISOString()
      })
      .eq("id", dbId);

    if (user?.id) query = query.eq("user_id", user.id);
    const { error } = await query;
    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error("records/update failed:", err);
    return jsonError(res, 500, err.message);
  }
});

app.get("/api/records/list", async (req, res) => {
  try {
    const user = await getOptionalUserFromRequest(req);
    let query = supabase.from("feedback_records").select("*").order("created_at", { ascending: false }).limit(50);
    if (user?.id) query = query.eq("user_id", user.id);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ records: data || [] });
  } catch (err) {
    console.error("records/list failed:", err);
    return jsonError(res, 500, err.message);
  }
});

app.post("/api/records/load", async (req, res) => {
  try {
    const user = await getOptionalUserFromRequest(req);
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    let query = supabase.from("feedback_records").select("*").order("created_at", { ascending: false });
    if (ids.length) query = query.in("id", ids);
    if (user?.id) query = query.eq("user_id", user.id);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ records: data || [] });
  } catch (err) {
    console.error("records/load failed:", err);
    return jsonError(res, 500, err.message);
  }
});

app.post("/api/records/action", async (req, res) => {
  try {
    const { record, action } = req.body || {};
    if (!record || !action) return jsonError(res, 400, "record and action are required");

    const updated = ensureRecordControl({ ...record });
    const rc = updated.recordControl;
    if (action === "review") rc.recordStatus = "Reviewed";
    if (action === "signoff") rc.recordStatus = "Signed Off";
    if (action === "iv") { rc.recordStatus = "IV Required"; rc.ivRequired = true; }
    if (action === "release") rc.recordStatus = "Released";
    updated.recordControl = rc;

    return res.json({ ok: true, record: updated });
  } catch (err) {
    console.error("records/action failed:", err);
    return jsonError(res, 500, err.message);
  }
});

app.post("/api/export/feedback-docx", async (req, res) => {
  try {
    const result = req.body?.result || {};
    const learnerName = result.fullName || "Learner Submission";
    const band = result.overallBandSummary || { P: { achieved: 0, total: 0 }, M: { achieved: 0, total: 0 }, D: { achieved: 0, total: 0 } };

    const infoTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: [new TableCell({ children: [new Paragraph("Learner")] }), new TableCell({ children: [new Paragraph(String(learnerName))] }), new TableCell({ children: [new Paragraph("Submission type")] }), new TableCell({ children: [new Paragraph(String(result.submissionType || ""))] })] }),
        new TableRow({ children: [new TableCell({ children: [new Paragraph("Unit")] }), new TableCell({ children: [new Paragraph(String(result.unitInfo || ""))] }), new TableCell({ children: [new Paragraph("Qualification")] }), new TableCell({ children: [new Paragraph(String(result.qualificationLevel || ""))] })] }),
        new TableRow({ children: [new TableCell({ children: [new Paragraph("Assessor")] }), new TableCell({ children: [new Paragraph(String(result.assessorName || ""))] }), new TableCell({ children: [new Paragraph("Assessment mode")] }), new TableCell({ children: [new Paragraph(String(result.assessmentMode || ""))] })] }),
        new TableRow({ children: [new TableCell({ children: [new Paragraph("Programme")] }), new TableCell({ children: [new Paragraph(String(result.programmePathway || ""))] }), new TableCell({ children: [new Paragraph("Internal verifier")] }), new TableCell({ children: [new Paragraph(String(result.internalVerifierName || ""))] })] }),
        new TableRow({ children: [new TableCell({ children: [new Paragraph("Overall judgement")] }), new TableCell({ children: [new Paragraph(String(result.grade || ""))] }), new TableCell({ children: [new Paragraph("Generated")] }), new TableCell({ children: [new Paragraph(String(result.meta?.generatedAt || ""))] })] }),
        new TableRow({ children: [new TableCell({ children: [new Paragraph("Band summary")] }), new TableCell({ children: [new Paragraph(`P ${band.P.achieved}/${band.P.total}`)] }), new TableCell({ children: [new Paragraph("")] }), new TableCell({ children: [new Paragraph(`M ${band.M.achieved}/${band.M.total}   D ${band.D.achieved}/${band.D.total}`)] })] })
      ]
    });

    const auditRows = [
      new TableRow({ children: [new TableCell({ children: [new Paragraph("Criterion")] }), new TableCell({ children: [new Paragraph("Requirement")] }), new TableCell({ children: [new Paragraph("Status")] }), new TableCell({ children: [new Paragraph("Evidence location")] }), new TableCell({ children: [new Paragraph("Evidence and depth")] }), new TableCell({ children: [new Paragraph("Rationale")] }), new TableCell({ children: [new Paragraph("Development")] })] }),
      ...((result.audit || []).map(item => new TableRow({ children: [new TableCell({ children: [new Paragraph(String(item.id || ""))] }), new TableCell({ children: [new Paragraph(String(item.requirement || ""))] }), new TableCell({ children: [new Paragraph(String(item.finalStatus || item.status || ""))] }), new TableCell({ children: [new Paragraph(String(item.evidencePage || ""))] }), new TableCell({ children: [new Paragraph(String(item.evidenceAndDepth || ""))] }), new TableCell({ children: [new Paragraph(String(item.rationale || ""))] }), new TableCell({ children: [new Paragraph(String(item.action || ""))] })] })))
    ];

    const auditTable = new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: auditRows });
    const workflowTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({ children: [new TableCell({ children: [new Paragraph("Record status")] }), new TableCell({ children: [new Paragraph(String(result.recordControl?.recordStatus || "Draft"))] }), new TableCell({ children: [new Paragraph("IV required")] }), new TableCell({ children: [new Paragraph(String(result.recordControl?.ivRequired ? "Yes" : "No"))] })] }),
        new TableRow({ children: [new TableCell({ children: [new Paragraph("Assessor sign-off")] }), new TableCell({ children: [new Paragraph("________________")] }), new TableCell({ children: [new Paragraph("IV sign-off")] }), new TableCell({ children: [new Paragraph("________________")] })] })
      ]
    });

    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ text: "MGTS Assessor Feedback Record", heading: HeadingLevel.TITLE }),
          new Paragraph(""),
          infoTable,
          new Paragraph(""),
          new Paragraph({ text: "Developmental Summary", heading: HeadingLevel.HEADING_1 }),
          new Paragraph(String(result.developmentalSummary || "No summary available.")),
          new Paragraph(""),
          new Paragraph({ text: "Criterion-Level Feedback", heading: HeadingLevel.HEADING_1 }),
          auditTable,
          new Paragraph(""),
          new Paragraph({ text: "Workflow and Sign-off", heading: HeadingLevel.HEADING_1 }),
          workflowTable
        ]
      }]
    });

    const buffer = await Packer.toBuffer(doc);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${learnerName.replace(/[^a-z0-9-_ ]/gi, "").trim() || "feedback"}-feedback.docx"`);
    return res.send(buffer);
  } catch (err) {
    console.error("export/feedback-docx failed:", err);
    return jsonError(res, 500, err.message);
  }
});

app.post("/api/export/iv-log", async (req, res) => {
  try {
    const result = req.body?.result || {};
    const rows = [
      ["Learner", result.fullName || ""],
      ["Grade", result.grade || ""],
      ["Record Status", result.recordControl?.recordStatus || ""],
      [],
      ["Criterion", "Status", "Evidence Location", "Evidence and Depth", "Rationale", "Development"],
      ...((result.audit || []).map(item => [item.id || "", item.finalStatus || item.status || "", item.evidencePage || "", item.evidenceAndDepth || "", item.rationale || "", item.action || ""]))
    ];
    const csv = rows.map(row => row.map(csvEscape).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=iv-log.csv");
    return res.send(csv);
  } catch (err) {
    console.error("export/iv-log failed:", err);
    return jsonError(res, 500, err.message);
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, activeJobs });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
