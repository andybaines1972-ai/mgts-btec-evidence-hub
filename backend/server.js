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
const CLIENT_LOGO_URL = process.env.CLIENT_LOGO_URL || "https://www.mgts.co.uk/wp-content/themes/mgts/images/svg/logo.svg";

if (!GEMINI_API_KEY) console.warn("Missing GEMINI_API_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) console.warn("Missing Supabase config");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function safeParse(text = "") {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {}
    }
    return {};
  }
}

function normaliseStatus(s = "") {
  const v = String(s).toLowerCase().trim();
  if (v === "achieved") return "Achieved";
  if (v === "not achieved") return "Not Achieved";
  if (v === "review required") return "Review Required";
  if (v.includes("review")) return "Review Required";
  if (v.includes("not")) return "Not Achieved";
  if (v.includes("ach")) return "Achieved";
  return "Review Required";
}

function calculateGrade(audit = []) {
  if (audit.some(a => normaliseStatus(a.finalStatus || a.status) === "Not Achieved")) return "Not Achieved";
  if (audit.some(a => normaliseStatus(a.finalStatus || a.status) === "Review Required")) return "Review Required";
  return "Achieved";
}

function buildBandSummary(audit = []) {
  const out = {
    P: { achieved: 0, reviewRequired: 0, notAchieved: 0, total: 0 },
    M: { achieved: 0, reviewRequired: 0, notAchieved: 0, total: 0 },
    D: { achieved: 0, reviewRequired: 0, notAchieved: 0, total: 0 }
  };

  audit.forEach(item => {
    const band = String(item.id || "").charAt(0).toUpperCase();
    if (!out[band]) return;

    out[band].total++;
    const status = normaliseStatus(item.finalStatus || item.status);
    if (status === "Achieved") out[band].achieved++;
    else if (status === "Not Achieved") out[band].notAchieved++;
    else out[band].reviewRequired++;
  });

  return out;
}

function ensureRecordControl(result = {}) {
  result.recordControl = {
    recordStatus: "Draft",
    ivRequired: false,
    ...result.recordControl
  };
  return result;
}

async function extractDocx(base64) {
  const buffer = Buffer.from(base64, "base64");
  const result = await mammoth.extractRawText({ buffer });
  return String(result.value || "").trim();
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

async function extractTxt(base64) {
  return Buffer.from(base64, "base64").toString("utf8");
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
      part: { text: `FILE: ${file.filename}\nROLE: ${file.role || "general"}\nTYPE: DOCX\n\n${text || "[No text extracted]"}` }
    };
  }

  if (mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    const text = await extractPptx(file.fileBase64);
    return {
      summary: `${file.filename} [${file.role || "general"}]`,
      part: { text: `FILE: ${file.filename}\nROLE: ${file.role || "general"}\nTYPE: PPTX\n\n${text || "[No text extracted]"}` }
    };
  }

  if (mime === "text/plain") {
    const text = await extractTxt(file.fileBase64);
    return {
      summary: `${file.filename} [${file.role || "general"}]`,
      part: { text: `FILE: ${file.filename}\nROLE: ${file.role || "general"}\nTYPE: TXT\n\n${text || "[Empty text file]"}` }
    };
  }

  return {
    summary: `${file.filename} [${file.role || "general"}]`,
    part: { text: `FILE: ${file.filename}\nROLE: ${file.role || "general"}\nTYPE: unsupported\n\nManual review may be needed.` }
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
      return res.status(400).json({ error: "filename and fileBase64 are required" });
    }

    const lower = filename.toLowerCase();
    let text = "";

    if (lower.endsWith(".docx")) {
      text = await extractDocx(fileBase64);
    } else if (lower.endsWith(".txt")) {
      text = await extractTxt(fileBase64);
    } else {
      return res.status(400).json({
        error: "Brief scan currently supports DOCX and TXT reliably in this build."
      });
    }

    const prompt = `
You are extracting BTEC assessment criteria from an assignment brief.

Return ONLY JSON:
{
  "criteria":[
    {"code":"P1","requirement":"..."}
  ],
  "unitTitle":"",
  "unitNumber":"",
  "learningAims":[],
  "tasks":[],
  "commandVerbIndex":[],
  "assignmentContext":"",
  "unitContext":"",
  "evidenceRequirements":[],
  "ambiguityFlags":[],
  "extractedFrom":"${filename}",
  "schemaVersion":"brief.v1"
}

Rules:
- Extract every valid P, M, and D criterion present
- Codes may appear like P1, P1., P1:, m1, d2 etc — normalise them
- Remove duplicates
- Keep requirement text concise but accurate
- Return JSON only

Brief text:
${text}
`;

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    const data = await r.json();
    const parsed = safeParse(data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}");

    let criteria = Array.isArray(parsed.criteria) ? parsed.criteria : [];

    // Normalise Gemini output more defensively
    const seen = new Set();
    criteria = criteria
      .map(c => {
        const rawCode = String(c.code || "").toUpperCase().trim();
        const code = rawCode.replace(/[^PMD0-9]/g, "");
        return {
          code,
          requirement: String(c.requirement || "").trim()
        };
      })
      .filter(c => /^[PMD]\d+$/i.test(c.code) && c.requirement)
      .filter(c => {
        if (seen.has(c.code)) return false;
        seen.add(c.code);
        return true;
      });

    // Fallback: regex extraction directly from text if Gemini returned nothing
    if (!criteria.length) {
      const regex = /\b([PMD]\d+)\b[\s:.\-–—]+([^\n\r]+)/gi;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const code = String(match[1] || "").toUpperCase().trim();
        const requirement = String(match[2] || "").trim();
        if (/^[PMD]\d+$/.test(code) && requirement && !seen.has(code)) {
          seen.add(code);
          criteria.push({ code, requirement });
        }
      }
    }
console.log("SCAN CRITERIA COUNT:", criteria.length);
console.log("SCAN CRITERIA:", criteria);
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
        schemaVersion: parsed.schemaVersion || "brief.v1"
      }
    });
  } catch (err) {
    console.error("scan-file failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/grade/submission-multi", async (req, res) => {
  try {
    const payload = req.body || {};
    const files = Array.isArray(payload.files) ? payload.files : [];
    const criteria = Array.isArray(payload.criteria) ? payload.criteria : [];
    const brief = payload.briefInterpretation || {};

    if (!files.length) return res.status(400).json({ error: "No files provided" });

    const criteriaSource = Array.isArray(brief.criteria) && brief.criteria.length ? brief.criteria : criteria;
    if (!criteriaSource.length) return res.status(400).json({ error: "No criteria provided" });

    const preparedFiles = [];
    for (const file of files) {
      preparedFiles.push(await prepareFilePart(file));
    }

    const criteriaText = criteriaSource.map(c => `${c.code}: ${c.requirement}`).join("\n");
    const fileSummary = preparedFiles.map((f, i) => `${i + 1}. ${f.summary}`).join("\n");

    const prompt = `
You are a senior BTEC assessor.

Return ONLY JSON:
{
  "fullName":"Learner Submission",
  "audit":[
    {
      "id":"P1",
      "status":"Achieved | Not Achieved | Review Required",
      "finalStatus":"Achieved | Not Achieved | Review Required",
      "rationale":"Detailed evidence-based explanation",
      "action":"Clear developmental improvement guidance",
      "confidenceScore":75
    }
  ],
  "developmentalSummary":"..."
}

STRICT RULES:
- You MUST return one audit item for EVERY criterion
- NEVER leave rationale empty
- NEVER leave action empty
- If evidence is weak, still explain why and what stronger evidence would look like
- Use professional assessor language
- Do not use phrases like "to achieve P1"
- Be realistic and conservative

Criteria:
${criteriaText}

Brief interpretation:
${JSON.stringify(brief)}

Files summary:
${fileSummary}
`;

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                ...preparedFiles.map(f => f.part)
              ]
            }
          ]
        })
      }
    );

    const data = await r.json();
    const parsed = safeParse(data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
    const incomingAudit = Array.isArray(parsed.audit) ? parsed.audit : [];

    const audit = criteriaSource.map(c => {
      const code = String(c.code || "").toUpperCase().trim();

      const found = incomingAudit.find(a => {
        const id = String(a.id || "").toUpperCase().replace(/[^PMD0-9]/g, "");
        return id === code;
      }) || {};

      return {
        id: code,
        requirement: c.requirement || "",
        status: normaliseStatus(found.status || "Review Required"),
        finalStatus: normaliseStatus(found.finalStatus || found.status || "Review Required"),
        evidencePage: String(found.evidencePage || "Not specified"),
        evidenceAndDepth: String(found.evidenceAndDepth || ""),
        rationale: found.rationale && String(found.rationale).length > 10
          ? String(found.rationale)
          : "Evidence is currently insufficiently demonstrated in the submitted work to support a confident judgement.",
        action: found.action && String(found.action).length > 10
          ? String(found.action)
          : "Further development should focus on strengthening evidence depth and clearly aligning the work to the assessment criteria.",
        confidenceScore: Number(found.confidenceScore || 40)
      };
    });

    const result = ensureRecordControl({
      fullName: parsed.fullName || "Learner Submission",
      audit,
      grade: calculateGrade(audit),
      overallBandSummary: buildBandSummary(audit),
      developmentalSummary: String(parsed.developmentalSummary || ""),
      briefInterpretation: brief,
      meta: {
        generatedAt: new Date().toISOString()
      }
    });

    return res.json({ result });
  } catch (err) {
    console.error("grade/submission-multi failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/grade/submission", async (req, res) => {
  return app._router.handle(
    { ...req, url: "/api/grade/submission-multi", method: "POST", body: req.body },
    res,
    () => {}
  );
});

app.post("/api/records/save", async (req, res) => {
  try {
    const { result } = req.body || {};
    const { data, error } = await supabase
      .from("feedback_records")
      .insert([{ data: ensureRecordControl(result || {}) }])
      .select("id")
      .single();

    if (error) throw error;
    return res.json({ id: data.id });
  } catch (err) {
    console.error("records/save failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/records/update", async (req, res) => {
  try {
    const { dbId, result } = req.body || {};
    if (!dbId || !result) return res.status(400).json({ error: "dbId and result are required" });

    const { error } = await supabase
      .from("feedback_records")
      .update({ data: ensureRecordControl(result), updated_at: new Date().toISOString() })
      .eq("id", dbId);

    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error("records/update failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/records/list", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("feedback_records")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    return res.json({ records: data || [] });
  } catch (err) {
    console.error("records/list failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/records/load", async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    let query = supabase.from("feedback_records").select("*").order("created_at", { ascending: false });
    if (ids.length) query = query.in("id", ids);

    const { data, error } = await query;
    if (error) throw error;
    return res.json({ records: data || [] });
  } catch (err) {
    console.error("records/load failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/records/action", async (req, res) => {
  try {
    const { record, action } = req.body || {};
    if (!record || !action) return res.status(400).json({ error: "record and action are required" });

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
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/export/feedback-docx", async (req, res) => {
  try {
    const result = req.body?.result || {};
    const text = [
      `Learner: ${result.fullName || "Learner Submission"}`,
      `Grade: ${result.grade || ""}`,
      "",
      ...((result.audit || []).map(item =>
        `${item.id || ""} - ${item.finalStatus || item.status || ""}\nRationale: ${item.rationale || ""}\nDevelopment: ${item.action || ""}\n`
      ))
    ].join("\n");

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", "attachment; filename=feedback.docx");
    return res.send(Buffer.from(text, "utf8"));
  } catch (err) {
    console.error("export/feedback-docx failed:", err);
    return res.status(500).json({ error: err.message });
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
      ["Criterion", "Status", "Rationale", "Development"],
      ...((result.audit || []).map(item => [
        item.id || "",
        item.finalStatus || item.status || "",
        item.rationale || "",
        item.action || ""
      ]))
    ];

    const csv = rows.map(row => row.map(v => {
      const s = String(v ?? "");
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    }).join(",")).join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=iv-log.csv");
    return res.send(csv);
  } catch (err) {
    console.error("export/iv-log failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
