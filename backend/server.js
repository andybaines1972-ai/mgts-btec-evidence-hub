const express = require("express");
const cors = require("cors");
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
app.use(cors());
app.use(express.json({ limit: "60mb" }));

/* =========================
   ENV
========================= */
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GEMINI_API_KEY) console.warn("Missing GEMINI_API_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) console.warn("Missing Supabase config");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const MODEL_CASCADE = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite"
];

/* =========================
   HELPERS
========================= */
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
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {}
    }
    return {};
  }
}

function isRetryableGeminiError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  return (
    msg.includes("503") ||
    msg.includes("429") ||
    msg.includes("overloaded") ||
    msg.includes("high demand") ||
    msg.includes("unavailable") ||
    msg.includes("try again later")
  );
}

async function callGeminiModel(model, parts, temperature = 0.05) {
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
          responseMimeType: "application/json"
        },
        contents: [{ parts }]
      })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message || `Gemini request failed with status ${response.status}`;
    throw new Error(message);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return safeParse(text);
}

async function runGeminiWithFallback(parts, options = {}) {
  const {
    temperature = 0.05,
    maxRetriesPerModel = 2,
    initialDelayMs = 1200
  } = options;

  const errors = [];

  for (const model of MODEL_CASCADE) {
    let delay = initialDelayMs;

    for (let attempt = 1; attempt <= maxRetriesPerModel; attempt += 1) {
      try {
        const parsed = await callGeminiModel(model, parts, temperature);
        return { parsed, model };
      } catch (error) {
        errors.push({ model, attempt, message: error.message });

        if (!isRetryableGeminiError(error) || attempt === maxRetriesPerModel) {
          break;
        }

        await sleep(delay);
        delay *= 2;
      }
    }
  }

  const summary = errors.map(e => `${e.model}#${e.attempt}: ${e.message}`).join(" | ");
  throw new Error(`All Gemini model attempts failed. ${summary}`);
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

function normaliseCriterionCode(code = "") {
  return String(code).toUpperCase().replace(/[^PMD0-9]/g, "");
}

function deriveBandFromCode(code = "") {
  const c = normaliseCriterionCode(code);
  if (c.startsWith("P")) return "P";
  if (c.startsWith("M")) return "M";
  if (c.startsWith("D")) return "D";
  return "";
}

function bandExpectationText(code = "", requirement = "") {
  const band = deriveBandFromCode(code);
  const req = String(requirement || "").toLowerCase();

  const contains = word => req.includes(word);

  if (band === "P") {
    return "Pass criteria require clear coverage of the stated requirement, usually through accurate description, explanation, application, or completion of the required task.";
  }
  if (band === "M") {
    if (contains("analyse") || contains("analyze")) {
      return "Merit criteria at analyse level require developed analytical treatment, not simple description. The learner should break down factors, relationships, implications, and reasoning with clear technical depth.";
    }
    if (contains("justify")) {
      return "Merit criteria at justify level require supported reasoning, not assertion. The learner should explain why a choice, method, or judgement is appropriate using relevant evidence or rationale.";
    }
    return "Merit criteria require stronger depth, analytical value, comparison, application, or reasoned support beyond basic pass-level description.";
  }
  if (band === "D") {
    if (contains("evaluate")) {
      return "Distinction criteria at evaluate level require critical judgement, balanced consideration, strengths and limitations, and reasoned conclusions.";
    }
    if (contains("justify")) {
      return "Distinction criteria at justify level require well-supported, independent reasoning that is clearly argued and defensible.";
    }
    return "Distinction criteria require critical, evaluative, or independent higher-level performance rather than basic explanation.";
  }
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

function detectConfidenceClass(score) {
  const num = Number(score || 0);
  if (num >= 85) return "high";
  if (num >= 60) return "medium";
  return "low";
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

  if (review === 0 && notAchieved === 0) {
    return "The submission demonstrates secure coverage across the assessed criteria, with evidence that is generally identifiable, relevant, and aligned to the assignment requirements. Further development should focus on consolidating depth, precision, and higher-order reasoning where appropriate.";
  }

  if (achieved > 0 && (review > 0 || notAchieved > 0)) {
    return "The submission contains some relevant and potentially creditworthy material, but criterion coverage is uneven and several judgements remain limited by weak, partial, or insufficiently explicit evidence. The next stage of development should focus on making evidence easier to identify, deepening technical explanation, and ensuring each criterion is addressed directly and convincingly.";
  }

  return "At present, the submission does not yet provide sufficiently secure, consistent, and clearly identifiable evidence across the assessed criteria. Priority should be given to producing more explicit criterion-linked material, fuller technical explanation, and stronger evidence that can be judged confidently against the assessment requirements.";
}

function ensureRecordControl(result = {}) {
  result.recordControl = {
    recordStatus: "Draft",
    ivRequired: false,
    ...result.recordControl
  };
  return result;
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

function chunkArray(arr, size = 1) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
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

function buildCriterionAwareFallback(requirement, type) {
  const req = String(requirement || "this criterion").trim();

  if (type === "evidence") {
    return `The submission contains some potentially relevant material, but the evidence for "${req}" is not yet explicit enough, sufficiently developed, or securely identifiable to support a confident judgement.`;
  }

  if (type === "rationale") {
    return `The current response does not yet demonstrate "${req}" with enough clarity, depth, or direct alignment to confirm consistent performance against this criterion.`;
  }

  return `Further development should focus on producing clearer, more explicit evidence for "${req}", with fuller explanation, stronger application, and material that can be clearly identified in the submitted work.`;
}

function normaliseEvidenceLocation(loc, requirement) {
  const value = String(loc || "").trim();
  if (value.length >= 4) return value;
  return `Evidence for "${requirement}" is not yet clearly identified in the submitted files`;
}

function cleanText(s = "") {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

/* =========================
   AUTH
========================= */
async function getOptionalUserFromRequest(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

/* =========================
   FILE EXTRACTION
========================= */
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

async function prepareFileMaterial(file) {
  const mime = inferMimeType(file.filename || "");
  const role = file.role || "general";
  const filename = file.filename || "file";

  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const text = await extractDocx(file.fileBase64);
    return {
      filename,
      role,
      type: "docx",
      text,
      part: { text: `FILE: ${filename}\nROLE: ${role}\nTYPE: DOCX\n\n${text || "[No text extracted]"}` }
    };
  }

  if (mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    const text = await extractPptx(file.fileBase64);
    return {
      filename,
      role,
      type: "pptx",
      text,
      part: { text: `FILE: ${filename}\nROLE: ${role}\nTYPE: PPTX\n\n${text || "[No text extracted]"}` }
    };
  }

  if (mime === "text/plain") {
    const text = await extractTxt(file.fileBase64);
    return {
      filename,
      role,
      type: "txt",
      text,
      part: { text: `FILE: ${filename}\nROLE: ${role}\nTYPE: TXT\n\n${text || "[Empty text file]"}` }
    };
  }

  if (mime === "application/pdf" || mime.startsWith("image/")) {
    return {
      filename,
      role,
      type: mime === "application/pdf" ? "pdf" : "image",
      text: "",
      part: {
        inline_data: {
          mime_type: mime,
          data: file.fileBase64
        }
      }
    };
  }

  return {
    filename,
    role,
    type: "unknown",
    text: "",
    part: { text: `FILE: ${filename}\nROLE: ${role}\nTYPE: unsupported` }
  };
}

/* =========================
   HEALTH
========================= */
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/* =========================
   BRIEF SCAN
========================= */
app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { filename, fileBase64 } = req.body || {};
    if (!filename || !fileBase64) {
      return jsonError(res, 400, "filename and fileBase64 are required");
    }

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
      const result = await runGeminiWithFallback(
        [{ text: prompt }],
        { temperature: 0.05, maxRetriesPerModel: 2, initialDelayMs: 1000 }
      );
      parsed = result.parsed || {};
      modelUsed = result.model || "";
    } catch (err) {
      console.error("Brief scan Gemini fallback exhausted:", err.message);
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

/* =========================
   STAGE 1: EVIDENCE RETRIEVAL
========================= */
async function retrieveEvidenceForCriterion(criterion, brief, preparedFiles, meta) {
  const textualFiles = preparedFiles.filter(f => f.text && f.text.trim().length);
  const fileTextBlob = textualFiles
    .map(f => `FILE: ${f.filename}\nROLE: ${f.role}\n\n${f.text.slice(0, 120000)}`)
    .join("\n\n====================\n\n");

  const prompt = `
You are an evidence retrieval engine for assessor review.

Return ONLY JSON:
{
  "id":"${criterion.code}",
  "matches":[
    {
      "file":"submission.docx",
      "location":"page / section / slide / area if identifiable",
      "snippet":"short direct excerpt or paraphrase of the relevant material",
      "relevance":"why this may relate to the criterion"
    }
  ]
}

Rules:
- Retrieve up to 5 best candidate evidence matches for this criterion.
- Prefer explicit, substantive evidence over vague mentions.
- If evidence is weak or unclear, still return the best weak matches rather than inventing strong evidence.
- Do not judge the criterion yet.
- Return JSON only.

Criterion:
${criterion.code}: ${criterion.requirement}

Band expectation:
${bandExpectationText(criterion.code, criterion.requirement)}

Command verbs:
${JSON.stringify(criterion.commandVerbs || [])}

Brief interpretation:
${JSON.stringify({
  tasks: brief.tasks || [],
  learningAims: brief.learningAims || [],
  assignmentContext: brief.assignmentContext || "",
  evidenceRequirements: brief.evidenceRequirements || []
})}

Learner submission text:
${fileTextBlob || "[No extracted text available from text-based files]"}
`;

  try {
    const result = await runGeminiWithFallback(
      [{ text: prompt }],
      { temperature: 0.0, maxRetriesPerModel: 2, initialDelayMs: 900 }
    );
    const parsed = result.parsed || {};
    const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
    return {
      id: criterion.code,
      matches: matches.slice(0, 5).map(m => ({
        file: cleanText(m.file),
        location: cleanText(m.location),
        snippet: cleanText(m.snippet),
        relevance: cleanText(m.relevance)
      })),
      modelUsed: result.model || ""
    };
  } catch (err) {
    console.error(`retrieveEvidenceForCriterion failed for ${criterion.code}:`, err.message);
    return { id: criterion.code, matches: [], modelUsed: "" };
  }
}

/* =========================
   STAGE 2: CRITERION JUDGEMENT
========================= */
async function judgeCriterion(criterion, evidencePack, brief, preparedFiles, meta) {
  const evidenceText = evidencePack.matches.length
    ? evidencePack.matches.map((m, i) =>
        `MATCH ${i + 1}
FILE: ${m.file}
LOCATION: ${m.location}
SNIPPET: ${m.snippet}
WHY RELEVANT: ${m.relevance}`
      ).join("\n\n")
    : "No clear evidence matches were retrieved.";

  const hasVisualFiles = preparedFiles.some(f => f.type === "pdf" || f.type === "image");

  const prompt = `
You are a strict, highly consistent Pearson BTEC assessor.

Assess ONLY this one criterion.

Return ONLY JSON:
{
  "id":"${criterion.code}",
  "status":"Achieved | Not Achieved | Review Required",
  "finalStatus":"Achieved | Not Achieved | Review Required",
  "evidencePage":"best file/location reference",
  "justificationAndEvidence":"2 to 4 sentences. Evidence-led. Criterion-specific. No boilerplate.",
  "actionPlan":"2 to 3 sentences. Specific development needed. No prohibited signposting.",
  "confidenceScore":65
}

STRICT RULES:
- Default to a conservative judgement where evidence is weak, partial, implied, or not securely identifiable.
- Do not infer generous achievement.
- Distinguish clearly between pass-level coverage and merit/distinction depth.
- Use the exact criterion requirement as your anchor.
- Do not repeat stock wording.
- If a criterion appears only partially addressed, use Review Required or Not Achieved.
- If no secure evidence location exists, say so.
- Keep wording professional, compact, and commercially credible.
- Do not mention being an AI.
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
  ambiguityFlags: brief.ambiguityFlags || []
})}

Retrieved evidence candidates:
${evidenceText}

Additional note:
${hasVisualFiles ? "There are visual/PDF files in the submission set. If textual evidence is weak, remain conservative rather than inventing certainty." : "Assessment should rely on the retrieved evidence and criterion wording."}
`;

  const result = await runGeminiWithFallback(
    [{ text: prompt }],
    { temperature: 0.0, maxRetriesPerModel: 2, initialDelayMs: 1200 }
  );

  const parsed = result.parsed || {};
  return {
    id: criterion.code,
    requirement: criterion.requirement,
    status: normaliseStatus(parsed.status || "Review Required"),
    finalStatus: normaliseStatus(parsed.finalStatus || parsed.status || "Review Required"),
    evidencePage: normaliseEvidenceLocation(parsed.evidencePage, criterion.requirement),
    evidenceAndDepth:
      cleanText(parsed.justificationAndEvidence).length > 30
        ? cleanText(parsed.justificationAndEvidence)
        : buildCriterionAwareFallback(criterion.requirement, "evidence"),
    rationale:
      cleanText(parsed.justificationAndEvidence).length > 30
        ? cleanText(parsed.justificationAndEvidence)
        : buildCriterionAwareFallback(criterion.requirement, "rationale"),
    action:
      cleanText(parsed.actionPlan).length > 20
        ? cleanText(parsed.actionPlan)
        : buildCriterionAwareFallback(criterion.requirement, "action"),
    confidenceScore: Number(parsed.confidenceScore || 40),
    retrieval: evidencePack.matches || [],
    modelUsed: result.model || ""
  };
}

/* =========================
   STAGE 3: ANTI-REPETITION EDITOR
========================= */
async function editorialPolishAudit(audit, meta) {
  const prompt = `
You are an editorial assessor-quality rewriter.

You must lightly improve wording quality across the audit array without changing:
- judgement
- evidence location
- meaning
- criterion coverage

Return ONLY JSON:
{
  "audit":[
    {
      "id":"P1",
      "evidenceAndDepth":"",
      "rationale":"",
      "action":""
    }
  ],
  "developmentalSummary":""
}

RULES:
- Remove repeated sentence openings and repeated stock phrasing.
- Keep each criterion distinct.
- Preserve evidence-led tone.
- Do not make text longer just for style.
- Do not alter status or judgement logic.
- Do not add unsupported claims.
- Do not signpost exact answers.
- Maintain a commercially credible assessor tone.
- Return one item for each criterion ID supplied.

Current audit:
${JSON.stringify(audit)}

Current developmental summary:
${buildOverallSummary(audit)}
`;

  try {
    const result = await runGeminiWithFallback(
      [{ text: prompt }],
      { temperature: 0.15, maxRetriesPerModel: 1, initialDelayMs: 800 }
    );

    const parsed = result.parsed || {};
    const polished = Array.isArray(parsed.audit) ? parsed.audit : [];
    const byId = new Map(polished.map(p => [normaliseCriterionCode(p.id), p]));

    const merged = audit.map(item => {
      const p = byId.get(normaliseCriterionCode(item.id)) || {};
      return {
        ...item,
        evidenceAndDepth: cleanText(p.evidenceAndDepth).length > 20 ? cleanText(p.evidenceAndDepth) : item.evidenceAndDepth,
        rationale: cleanText(p.rationale).length > 20 ? cleanText(p.rationale) : item.rationale,
        action: cleanText(p.action).length > 20 ? cleanText(p.action) : item.action
      };
    });

    return {
      audit: merged,
      developmentalSummary:
        cleanText(parsed.developmentalSummary).length > 30
          ? cleanText(parsed.developmentalSummary)
          : buildOverallSummary(audit),
      modelUsed: result.model || ""
    };
  } catch (err) {
    console.error("editorialPolishAudit failed:", err.message);
    return {
      audit,
      developmentalSummary: buildOverallSummary(audit),
      modelUsed: ""
    };
  }
}

/* =========================
   GRADING
========================= */
app.post("/api/grade/submission-multi", async (req, res) => {
  try {
    const payload = req.body || {};
    const files = Array.isArray(payload.files) ? payload.files : [];
    const criteria = Array.isArray(payload.criteria) ? payload.criteria : [];
    const brief = payload.briefInterpretation || {};

    if (!files.length) return jsonError(res, 400, "No files provided");

    const criteriaSource =
      Array.isArray(brief.criteria) && brief.criteria.length
        ? dedupeCriteria(brief.criteria)
        : dedupeCriteria(criteria);

    if (!criteriaSource.length) return jsonError(res, 400, "No criteria provided");

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

    const preparedFiles = [];
    for (const file of files) {
      preparedFiles.push(await prepareFileMaterial(file));
    }

    const retrievalModels = [];
    const judgementModels = [];

    const evidencePacks = [];
    for (const criterion of criteriaSource) {
      const retrieved = await retrieveEvidenceForCriterion(criterion, brief, preparedFiles, meta);
      if (retrieved.modelUsed) retrievalModels.push(retrieved.modelUsed);
      evidencePacks.push(retrieved);
    }

    const evidenceMap = new Map(evidencePacks.map(p => [normaliseCriterionCode(p.id), p]));
    let audit = [];

    const criterionBatches = chunkArray(criteriaSource, 1);
    for (const batch of criterionBatches) {
      const criterion = batch[0];
      const evidencePack = evidenceMap.get(normaliseCriterionCode(criterion.code)) || { id: criterion.code, matches: [] };
      const judged = await judgeCriterion(criterion, evidencePack, brief, preparedFiles, meta);
      if (judged.modelUsed) judgementModels.push(judged.modelUsed);
      audit.push(judged);
    }

    audit = criteriaSource.map(c => {
      const found = audit.find(a => normaliseCriterionCode(a.id) === normaliseCriterionCode(c.code)) || {};
      return {
        id: normaliseCriterionCode(c.code),
        requirement: c.requirement,
        status: normaliseStatus(found.status || "Review Required"),
        finalStatus: normaliseStatus(found.finalStatus || found.status || "Review Required"),
        evidencePage: normaliseEvidenceLocation(found.evidencePage, c.requirement),
        evidenceAndDepth:
          cleanText(found.evidenceAndDepth).length > 20
            ? cleanText(found.evidenceAndDepth)
            : buildCriterionAwareFallback(c.requirement, "evidence"),
        rationale:
          cleanText(found.rationale).length > 20
            ? cleanText(found.rationale)
            : buildCriterionAwareFallback(c.requirement, "rationale"),
        action:
          cleanText(found.action).length > 20
            ? cleanText(found.action)
            : buildCriterionAwareFallback(c.requirement, "action"),
        confidenceScore: Number(found.confidenceScore || 40),
        confidenceClass: detectConfidenceClass(found.confidenceScore || 40),
        retrieval: Array.isArray(found.retrieval) ? found.retrieval : []
      };
    });

    const editorial = await editorialPolishAudit(audit, meta);
    audit = editorial.audit || audit;

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
      audit,
      grade: calculateGrade(audit),
      overallBandSummary: buildBandSummary(audit),
      developmentalSummary: editorial.developmentalSummary || buildOverallSummary(audit),
      briefInterpretation: brief,
      meta: {
        generatedAt: new Date().toISOString(),
        retrievalModelsUsed: [...new Set(retrievalModels)],
        judgementModelsUsed: [...new Set(judgementModels)],
        editorialModelUsed: editorial.modelUsed || ""
      }
    });

    return res.json({ result });
  } catch (err) {
    console.error("grade/submission-multi failed:", err);
    return jsonError(res, 500, err.message);
  }
});

app.post("/api/grade/submission", async (req, res) => {
  try {
    return app._router.handle(
      { ...req, url: "/api/grade/submission-multi", method: "POST", body: req.body },
      res,
      () => {}
    );
  } catch (err) {
    console.error("grade/submission failed:", err);
    return jsonError(res, 500, err.message);
  }
});

/* =========================
   RECORDS
========================= */
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

    let query = supabase
      .from("feedback_records")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

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

    let query = supabase
      .from("feedback_records")
      .select("*")
      .order("created_at", { ascending: false });

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
    if (action === "iv") {
      rc.recordStatus = "IV Required";
      rc.ivRequired = true;
    }
    if (action === "release") rc.recordStatus = "Released";

    updated.recordControl = rc;
    return res.json({ ok: true, record: updated });
  } catch (err) {
    console.error("records/action failed:", err);
    return jsonError(res, 500, err.message);
  }
});

/* =========================
   EXPORTS
========================= */
app.post("/api/export/feedback-docx", async (req, res) => {
  try {
    const result = req.body?.result || {};
    const learnerName = result.fullName || "Learner Submission";
    const band = result.overallBandSummary || {
      P: { achieved: 0, total: 0 },
      M: { achieved: 0, total: 0 },
      D: { achieved: 0, total: 0 }
    };

    const infoTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph("Learner")] }),
            new TableCell({ children: [new Paragraph(String(learnerName))] }),
            new TableCell({ children: [new Paragraph("Submission type")] }),
            new TableCell({ children: [new Paragraph(String(result.submissionType || ""))] })
          ]
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph("Unit")] }),
            new TableCell({ children: [new Paragraph(String(result.unitInfo || ""))] }),
            new TableCell({ children: [new Paragraph("Qualification")] }),
            new TableCell({ children: [new Paragraph(String(result.qualificationLevel || ""))] })
          ]
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph("Assessor")] }),
            new TableCell({ children: [new Paragraph(String(result.assessorName || ""))] }),
            new TableCell({ children: [new Paragraph("Assessment mode")] }),
            new TableCell({ children: [new Paragraph(String(result.assessmentMode || ""))] })
          ]
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph("Programme")] }),
            new TableCell({ children: [new Paragraph(String(result.programmePathway || ""))] }),
            new TableCell({ children: [new Paragraph("Internal verifier")] }),
            new TableCell({ children: [new Paragraph(String(result.internalVerifierName || ""))] })
          ]
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph("Overall judgement")] }),
            new TableCell({ children: [new Paragraph(String(result.grade || ""))] }),
            new TableCell({ children: [new Paragraph("Generated")] }),
            new TableCell({ children: [new Paragraph(String(result.meta?.generatedAt || ""))] })
          ]
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph("Band summary")] }),
            new TableCell({ children: [new Paragraph(`P ${band.P.achieved}/${band.P.total}`)] }),
            new TableCell({ children: [new Paragraph("")] }),
            new TableCell({ children: [new Paragraph(`M ${band.M.achieved}/${band.M.total}   D ${band.D.achieved}/${band.D.total}`)] })
          ]
        })
      ]
    });

    const auditRows = [
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph("Criterion")] }),
          new TableCell({ children: [new Paragraph("Requirement")] }),
          new TableCell({ children: [new Paragraph("Status")] }),
          new TableCell({ children: [new Paragraph("Evidence location")] }),
          new TableCell({ children: [new Paragraph("Evidence and depth")] }),
          new TableCell({ children: [new Paragraph("Rationale")] }),
          new TableCell({ children: [new Paragraph("Development")] })
        ]
      }),
      ...((result.audit || []).map(item =>
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph(String(item.id || ""))] }),
            new TableCell({ children: [new Paragraph(String(item.requirement || ""))] }),
            new TableCell({ children: [new Paragraph(String(item.finalStatus || item.status || ""))] }),
            new TableCell({ children: [new Paragraph(String(item.evidencePage || ""))] }),
            new TableCell({ children: [new Paragraph(String(item.evidenceAndDepth || ""))] }),
            new TableCell({ children: [new Paragraph(String(item.rationale || ""))] }),
            new TableCell({ children: [new Paragraph(String(item.action || ""))] })
          ]
        })
      ))
    ];

    const auditTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: auditRows
    });

    const workflowTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph("Record status")] }),
            new TableCell({ children: [new Paragraph(String(result.recordControl?.recordStatus || "Draft"))] }),
            new TableCell({ children: [new Paragraph("IV required")] }),
            new TableCell({ children: [new Paragraph(String(result.recordControl?.ivRequired ? "Yes" : "No"))] })
          ]
        }),
        new TableRow({
          children: [
            new TableCell({ children: [new Paragraph("Assessor sign-off")] }),
            new TableCell({ children: [new Paragraph("________________")] }),
            new TableCell({ children: [new Paragraph("IV sign-off")] }),
            new TableCell({ children: [new Paragraph("________________")] })
          ]
        })
      ]
    });

    const doc = new Document({
      sections: [
        {
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
        }
      ]
    });

    const buffer = await Packer.toBuffer(doc);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${learnerName.replace(/[^a-z0-9-_ ]/gi, "").trim() || "feedback"}-feedback.docx"`
    );
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
      ...((result.audit || []).map(item => [
        item.id || "",
        item.finalStatus || item.status || "",
        item.evidencePage || "",
        item.evidenceAndDepth || "",
        item.rationale || "",
        item.action || ""
      ]))
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
