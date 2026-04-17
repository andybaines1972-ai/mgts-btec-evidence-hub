import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mammoth from "mammoth";
import pdf from "pdf-parse";
import JSZip from "jszip";
import Tesseract from "tesseract.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "100mb" }));

const PORT = process.env.PORT || 3000;

/* ===============================
   HELPERS
================================ */

const safe = (v = "") => String(v ?? "").trim();

const now = () => new Date().toLocaleString("en-GB");

function normalize(text = "") {
  return safe(text)
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ");
}

function tokenize(text = "") {
  return normalize(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function inferRole(filename = "") {
  const n = filename.toLowerCase();
  if (n.endsWith(".pptx") || n.includes("slides")) return "presentation";
  if (n.includes("notes")) return "notes";
  if (n.includes("report")) return "report";
  if (n.includes("appendix")) return "appendix";
  return "general";
}

/* ===============================
   EXTRACTION
================================ */

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return normalize(result.value);
}

async function extractPdf(buffer) {
  const result = await pdf(buffer);
  return normalize(result.text);
}

async function extractPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  let text = "";

  const slides = Object.keys(zip.files).filter(f =>
    f.includes("ppt/slides/slide")
  );

  for (const slide of slides) {
    const xml = await zip.files[slide].async("text");
    text += xml.replace(/<[^>]+>/g, " ") + " ";
  }

  return normalize(text);
}

async function extractImage(buffer) {
  const res = await Tesseract.recognize(buffer, "eng");
  return normalize(res.data.text);
}

async function extractText(file) {
  const buffer = Buffer.from(file.fileBase64, "base64");
  const name = file.filename.toLowerCase();

  try {
    if (name.endsWith(".docx")) return await extractDocx(buffer);
    if (name.endsWith(".pdf")) return await extractPdf(buffer);
    if (name.endsWith(".pptx")) return await extractPptx(buffer);
    if (/\.(png|jpg|jpeg)$/.test(name)) return await extractImage(buffer);
    return "";
  } catch {
    return "";
  }
}

/* ===============================
   GRADING ENGINE
================================ */

function score(text, requirement) {
  const t = tokenize(text);
  const r = tokenize(requirement);

  const matches = r.filter(x => t.includes(x)).length;
  const ratio = r.length ? matches / r.length : 0;

  return Math.min(100, Math.round(ratio * 100));
}

function buildAudit(criteria, text) {
  return criteria.map(c => {
    const s = score(text, c.requirement);

    return {
      id: c.code,
      requirement: c.requirement,
      status: s > 75 ? "Achieved" : "Review Required",
      finalStatus: s > 75 ? "Achieved" : "Review Required",
      confidenceScore: s,
      evidencePage: s > 40 ? "Evidence detected" : "Not clearly located",
      evidenceAndDepth:
        s > 40
          ? "Relevant evidence identified in submission."
          : "Evidence not clearly matched.",
      rationale:
        s > 40
          ? "Submission appears to address this criterion."
          : "Insufficient direct evidence located.",
      action:
        s > 40
          ? "Expand depth where possible."
          : "Add clearer direct evidence."
    };
  });
}

function grade(audit) {
  const fail = audit.some(a => a.status !== "Achieved");
  return fail ? "Pass Pending Review" : "Pass";
}

/* ===============================
   RECORD CONTROL
================================ */

function defaultControl() {
  return {
    recordStatus: "Draft",
    assessorSignedOffBy: "",
    assessorSignedOffAt: "",
    ivRequired: false,
    ivDecision: "",
    releasedAt: ""
  };
}

/* ===============================
   API
================================ */

app.get("/api/client-config", (req, res) => {
  res.json({ ok: true });
});

/* -------- BRIEF SCAN -------- */

app.post("/api/brief/scan-file", async (req, res) => {
  const { filename, fileBase64 } = req.body;

  const text = await extractText({ filename, fileBase64 });

  const lines = text.split("\n");

  const criteria = [];

  lines.forEach(line => {
    const m = line.match(/([PMD]\d+)\s+(.*)/i);
    if (m) {
      criteria.push({
        code: m[1].toUpperCase(),
        requirement: m[2]
      });
    }
  });

  res.json({ result: { criteria } });
});

/* -------- SINGLE -------- */

app.post("/api/grade/submission", async (req, res) => {
  const { filename, fileBase64, criteria } = req.body;

  const text = await extractText({ filename, fileBase64 });

  const audit = buildAudit(criteria, text);

  res.json({
    result: {
      fullName: filename,
      audit,
      grade: grade(audit),
      recordControl: defaultControl()
    }
  });
});

/* -------- MULTI -------- */

app.post("/api/grade/submission-multi", async (req, res) => {
  const { files, criteria } = req.body;

  let combined = "";

  for (const f of files) {
    const text = await extractText(f);
    combined += text + "\n\n";
  }

  const audit = buildAudit(criteria, combined);

  res.json({
    result: {
      fullName: "Combined Submission",
      audit,
      grade: grade(audit),
      recordControl: defaultControl()
    }
  });
});

/* -------- RECORD STORE -------- */

let records = [];

app.post("/api/records/save", (req, res) => {
  const id = Date.now().toString();
  records.push({ id, data: req.body.result });
  res.json({ id });
});

app.post("/api/records/update", (req, res) => {
  const { dbId, result } = req.body;

  records = records.map(r =>
    r.id === dbId ? { ...r, data: result } : r
  );

  res.json({ success: true });
});

app.get("/api/records/list", (req, res) => {
  res.json({ records });
});

app.post("/api/records/load", (req, res) => {
  const { ids } = req.body;
  res.json({ records: records.filter(r => ids.includes(r.id)) });
});

/* -------- IV / REVIEW ACTIONS -------- */

app.post("/api/records/action", (req, res) => {
  const { dbId, action } = req.body;

  const record = records.find(r => r.id === dbId);
  if (!record) return res.status(404).send();

  const rc = record.data.recordControl;

  switch (action) {
    case "sign_off":
      rc.assessorSignedOffAt = now();
      rc.recordStatus = "Signed Off";
      break;

    case "request_iv":
      rc.ivRequired = true;
      rc.recordStatus = "IV Requested";
      break;

    case "iv_approve":
      rc.ivDecision = "Approved";
      rc.recordStatus = "IV Approved";
      break;

    case "iv_return":
      rc.ivDecision = "Returned";
      rc.recordStatus = "IV Returned";
      break;

    case "release":
      rc.releasedAt = now();
      rc.recordStatus = "Released";
      break;
  }

  res.json({ success: true });
});

/* ===============================
   START
================================ */

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
