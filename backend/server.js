const express = require("express");
const cors = require("cors");
const mammoth = require("mammoth");
const JSZip = require("jszip");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLIENT_LOGO_URL =
  process.env.CLIENT_LOGO_URL ||
  "https://www.mgts.co.uk/wp-content/themes/mgts/images/svg/logo.svg";

if (!GEMINI_API_KEY) console.warn("Missing GEMINI_API_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) console.warn("Missing Supabase config");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const MODEL_CASCADE = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite"
];

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

async function callGeminiModel(model, parts, temperature = 0.2) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        generationConfig: {
          temperature,
          responseMimeType: "application/json"
        },
        contents: [{ parts }]
      })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      data?.error?.message ||
      `Gemini request failed with status ${response.status}`;
    throw new Error(message);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return safeParse(text);
}

async function runGeminiWithFallback(parts, options = {}) {
  const {
    temperature = 0.2,
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
  if (v.includes("review")) return "Review Required";
  if (v.includes("not")) return "Not Achieved";
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

function calculateGrade(audit = []) {
  if (audit.some(a => normaliseStatus(a.finalStatus || a.status) === "Not Achieved")) {
    return "Not Achieved";
  }
  if (audit.some(a => normaliseStatus(a.finalStatus || a.status) === "Review Required")) {
    return "Review Required";
  }
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
      commandVerbs: Array.isArray(item.commandVerbs) ? item.commandVerbs : []
    }))
    .filter(item => /^[PMD]\d+$/i.test(item.code) && item.requirement)
    .filter(item => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    });
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function detectConfidenceClass(score) {
  const num = Number(score || 0);
  if (num >= 85) return "high";
  if (num >= 60) return "medium";
  return "low";
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

function commandVerbHintsFromRequirement(text = "") {
  const lower = String(text).toLowerCase();
  const verbs = [];
  ["identify", "describe", "explain", "analyse", "analyze", "evaluate", "justify", "compare", "assess"].forEach(v => {
    if (lower.includes(v)) verbs.push(v);
  });
  return verbs;
}

async function getUserFromRequest(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token) {
    throw new Error("Missing bearer token");
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    throw new Error("Invalid or expired login");
  }

  return data.user;
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

async function prepareFilePart(file) {
  const mime = inferMimeType(file.filename || "");

  if (mime === "application/pdf" || mime.startsWith("image/")) {
    return {
      summary: `${file.filename} [${file.role || "general"}]`,
      part: {
        inline_data: {
          mime_type: mime,
          data: file.fileBase64
        }
      }
    };
  }

  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const text = await extractDocx(file.fileBase64);
    return {
      summary: `${file.filename} [${file.role || "general"}]`,
      part: {
        text: `FILE: ${file.filename}\nROLE: ${file.role || "general"}\nTYPE: DOCX\n\n${text || "[No text extracted]"}`
      }
    };
  }

  if (mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    const text = await extractPptx(file.fileBase64);
    return {
      summary: `${file.filename} [${file.role || "general"}]`,
      part: {
        text: `FILE: ${file.filename}\nROLE: ${file.role || "general"}\nTYPE: PPTX\n\n${text || "[No text extracted]"}`
      }
    };
  }

  if (mime === "text/plain") {
    const text = await extractTxt(file.fileBase64);
    return {
      summary: `${file.filename} [${file.role || "general"}]`,
      part: {
        text: `FILE: ${file.filename}\nROLE: ${file.role || "general"}\nTYPE: TXT\n\n${text || "[Empty text file]"}`
      }
    };
  }

  return {
    summary: `${file.filename} [${file.role || "general"}]`,
    part: {
      text: `FILE: ${file.filename}\nROLE: ${file.role || "general"}\nTYPE: unsupported\n\nManual review may be needed.`
    }
  };
}

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
      return jsonError(res, 400, "filename and fileBase64 are required");
    }

    const lower = filename.toLowerCase();
    let text = "";

    if (lower.endsWith(".docx")) {
      text = await extractDocx(fileBase64);
    } else if (lower.endsWith(".txt")) {
      text = await extractTxt(fileBase64);
    } else {
      return jsonError(res, 400, "Brief scan currently supports DOCX and TXT reliably in this build.");
    }

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
- Extract all valid P, M, D criteria
- Codes may appear like P1, P1., P1:, m1, d2 - normalise them
- Remove duplicates
- Return JSON only

Brief text:
${text}
`;

    let parsed = {};
    let modelUsed = "";

    try {
      const result = await runGeminiWithFallback(
        [{ text: prompt }],
        { temperature: 0.1, maxRetriesPerModel: 2, initialDelayMs: 1000 }
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

    const result = {
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
    };

    return res.json({ result });
  } catch (err) {
    console.error("scan-file failed:", err);
    return jsonError(res, 500, err.message);
  }
});

app.post("/api/grade/submission-multi", async (req, res) => {
  try {
    const payload = req.body || {};
    const files = Array.isArray(payload.files) ? payload.files : [];
    const criteria = Array.isArray(payload.criteria) ? payload.criteria : [];
    const brief = payload.briefInterpretation || {};

    if (!files.length) {
      return jsonError(res, 400, "No files provided");
    }

    const criteriaSource =
      Array.isArray(brief.criteria) && brief.criteria.length ? brief.criteria : criteria;

    if (!criteriaSource.length) {
      return jsonError(res, 400, "No criteria provided");
    }

    const preparedFiles = [];
    for (const file of files) {
      preparedFiles.push(await prepareFilePart(file));
    }

    const criteriaText = criteriaSource.map(c => `${c.code}: ${c.requirement}`).join("\n");
    const fileSummary = preparedFiles.map((f, i) => `${i + 1}. ${f.summary}`).join("\n");

    const gradePrompt = `
You are a senior BTEC assessor producing criterion-level feedback.

Return ONLY JSON in this exact shape:
{
  "fullName":"Learner Submission",
  "audit":[
    {
      "id":"P1",
      "status":"Achieved | Not Achieved | Review Required",
      "finalStatus":"Achieved | Not Achieved | Review Required",
      "evidencePage":"Specific file / page / section / paragraph reference",
      "evidenceAndDepth":"Detailed explanation of what evidence is present, how well it matches the criterion, and whether the depth is sufficient",
      "rationale":"A specific assessor-style judgement explaining why the current evidence does or does not support the criterion",
      "action":"A clear developmental action explaining what would strengthen, deepen, complete, or improve the work",
      "confidenceScore":75
    }
  ],
  "developmentalSummary":"A concise overall developmental summary"
}

STRICT RULES:
- You MUST return one audit item for EVERY criterion supplied.
- NEVER leave evidencePage empty.
- NEVER leave evidenceAndDepth empty.
- NEVER leave rationale empty.
- NEVER leave action empty.
- Use the actual extracted evidence from the files.
- If evidence is weak, say exactly what is missing.
- Development must sound like a real assessor, not generic filler.
- Do not say "to achieve P1".
- Be professional, specific, and realistic.
- If evidence is partial or unclear, use Review Required.

Criteria:
${criteriaText}

Brief interpretation:
${JSON.stringify(brief)}

Files summary:
${fileSummary}
`;

    const gradedResult = await runGeminiWithFallback(
      [{ text: gradePrompt }, ...preparedFiles.map(f => f.part)],
      { temperature: 0.25, maxRetriesPerModel: 2, initialDelayMs: 1200 }
    );
    const graded = gradedResult.parsed || {};

    const validatePrompt = `
You are validating a BTEC assessor output.

Return ONLY JSON:
{
  "audit":[
    {
      "id":"P1",
      "status":"Achieved | Not Achieved | Review Required",
      "finalStatus":"Achieved | Not Achieved | Review Required",
      "evidencePage":"...",
      "evidenceAndDepth":"...",
      "rationale":"...",
      "action":"...",
      "confidenceScore":75
    }
  ],
  "developmentalSummary":"..."
}

Rules:
- Keep one row per criterion
- Remove vague filler
- Make rationale and action specific
- If a judgement is too strong for the evidence, downgrade to Review Required
- Preserve professional assessor language
- Return JSON only

Criteria:
${criteriaText}

Draft assessor output:
${JSON.stringify(graded)}
`;

    let validated = {};
    try {
      const validatedResult = await runGeminiWithFallback(
        [{ text: validatePrompt }],
        { temperature: 0.1, maxRetriesPerModel: 2, initialDelayMs: 1000 }
      );
      validated = validatedResult.parsed || {};
    } catch (validationError) {
      console.error("Validation fallback exhausted:", validationError.message);
      validated = {};
    }

    const incomingAudit = Array.isArray(validated.audit)
      ? validated.audit
      : (Array.isArray(graded.audit) ? graded.audit : []);

    const audit = criteriaSource.map(c => {
      const code = normaliseCriterionCode(c.code || "");
      const found = incomingAudit.find(a => normaliseCriterionCode(a.id || "") === code) || {};

      return {
        id: code,
        requirement: c.requirement || "",
        status: normaliseStatus(found.status || "Review Required"),
        finalStatus: normaliseStatus(found.finalStatus || found.status || "Review Required"),
        evidencePage:
          found.evidencePage && String(found.evidencePage).trim().length > 3
            ? String(found.evidencePage).trim()
            : "Evidence not clearly located in the submitted files",
        evidenceAndDepth:
          found.evidenceAndDepth && String(found.evidenceAndDepth).trim().length > 20
            ? String(found.evidenceAndDepth).trim()
            : "The current submission does not yet provide sufficiently specific or developed evidence against this criterion.",
        rationale:
          found.rationale && String(found.rationale).trim().length > 20
            ? String(found.rationale).trim()
            : "The evidence currently available is too limited or unclear to support a secure assessor judgement against this criterion.",
        action:
          found.action && String(found.action).trim().length > 20
            ? String(found.action).trim()
            : "The work would be stronger with clearer, more directly aligned evidence that fully addresses the criterion and shows sufficient depth.",
        confidenceScore: Number(found.confidenceScore || 40),
        confidenceClass: detectConfidenceClass(found.confidenceScore || 40)
      };
    });

    const result = ensureRecordControl({
      fullName: validated.fullName || graded.fullName || "Learner Submission",
      audit,
      grade: calculateGrade(audit),
      overallBandSummary: buildBandSummary(audit),
      developmentalSummary: String(validated.developmentalSummary || graded.developmentalSummary || ""),
      briefInterpretation: brief,
      meta: {
        generatedAt: new Date().toISOString(),
        gradeModelUsed: gradedResult.model || ""
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

app.get("/api/client-config", (_req, res) => {
  res.json({ logoUrl: CLIENT_LOGO_URL });
});

app.post("/api/records/save", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const { result } = req.body || {};

    const { data, error } = await supabase
      .from("feedback_records")
      .insert([{
        user_id: user.id,
        user_email: user.email || "",
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
    const user = await getUserFromRequest(req);
    const { dbId, result } = req.body || {};
    if (!dbId || !result) {
      return jsonError(res, 400, "dbId and result are required");
    }

    const { error } = await supabase
      .from("feedback_records")
      .update({
        learner_name: result.fullName || "Learner Submission",
        grade: result.grade || "",
        record_status: result?.recordControl?.recordStatus || "Draft",
        data: ensureRecordControl(result),
        updated_at: new Date().toISOString()
      })
      .eq("id", dbId)
      .eq("user_id", user.id);

    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error("records/update failed:", err);
    return jsonError(res, 500, err.message);
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
    console.error("records/list failed:", err);
    return jsonError(res, 500, err.message);
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

    if (ids.length) query = query.in("id", ids);

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
    await getUserFromRequest(req);
    const { record, action } = req.body || {};
    if (!record || !action) {
      return jsonError(res, 400, "record and action are required");
    }

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

app.post("/api/export/feedback-docx", async (req, res) => {
  try {
    const result = req.body?.result || {};

    const text = [
      `Learner: ${result.fullName || "Learner Submission"}`,
      `Grade: ${result.grade || ""}`,
      `Status: ${result.recordControl?.recordStatus || ""}`,
      "",
      ...((result.audit || []).map(item =>
        `${item.id || ""} - ${item.finalStatus || item.status || ""}\nEvidence location: ${item.evidencePage || ""}\nEvidence and depth: ${item.evidenceAndDepth || ""}\nRationale: ${item.rationale || ""}\nDevelopment: ${item.action || ""}\n`
      ))
    ].join("\n");

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", "attachment; filename=feedback.docx");
    return res.send(Buffer.from(text, "utf8"));
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
