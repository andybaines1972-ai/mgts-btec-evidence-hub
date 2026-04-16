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
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;

/* -----------------------------
   BASIC HEALTH / CONFIG
----------------------------- */

app.get("/api/client-config", (req, res) => {
  res.json({
    logoUrl: "https://www.mgts.co.uk/wp-content/themes/mgts/images/svg/logo.svg"
  });
});

/* -----------------------------
   FILE EXTRACTION
----------------------------- */

async function extractTextFromFile(file) {
  const buffer = Buffer.from(file.fileBase64, "base64");
  const name = file.filename.toLowerCase();

  try {
    // DOCX
    if (name.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ buffer });
      return result.value || "";
    }

    // PDF
    if (name.endsWith(".pdf")) {
      const result = await pdf(buffer);
      return result.text || "";
    }

    // PPTX
    if (name.endsWith(".pptx")) {
      const zip = await JSZip.loadAsync(buffer);
      let text = "";

      const slides = Object.keys(zip.files).filter(f =>
        f.includes("ppt/slides/slide")
      );

      for (const slide of slides) {
        const xml = await zip.files[slide].async("text");
        const matches = xml.match(/<a:t>(.*?)<\/a:t>/g) || [];
        matches.forEach(m => {
          text += m.replace(/<\/?a:t>/g, "") + " ";
        });
      }

      return text;
    }

    // TEXT
    if (name.endsWith(".txt")) {
      return buffer.toString("utf-8");
    }

    // IMAGE OCR
    if (name.match(/\.(png|jpg|jpeg|webp)$/)) {
      const result = await Tesseract.recognize(buffer, "eng");
      return result.data.text || "";
    }

    return "";
  } catch (err) {
    console.error("Extraction failed:", err);
    return "";
  }
}

/* -----------------------------
   CRITERIA GRADING ENGINE (SIMPLE BASELINE)
----------------------------- */

function gradeAgainstCriteria({ text, criteria }) {
  return criteria.map(c => {
    const found = text.toLowerCase().includes(c.requirement.toLowerCase().slice(0, 20));

    const confidence = found ? 75 : 20;

    return {
      id: c.code,
      requirement: c.requirement,
      status: found ? "Achieved" : "Review Required",
      finalStatus: found ? "Achieved" : "Review Required",
      confidenceScore: confidence,
      evidencePage: found ? "Evidence located (approximate)" : "Page reference not identified",
      evidenceAndDepth: found
        ? "Relevant content detected in submission."
        : "The submission could not be confirmed fully at this time.",
      rationale: found
        ? "The criterion appears to be addressed in the submission."
        : "A secure judgement could not be confirmed from available evidence.",
      action: found
        ? "Further development could strengthen depth."
        : "Return to this criterion and strengthen directly relevant evidence."
    };
  });
}

function buildOverallGrade(audit) {
  const anyFail = audit.some(a => a.finalStatus !== "Achieved");
  return anyFail ? "Pass Pending Review" : "Pass";
}

/* -----------------------------
   SINGLE FILE (LEGACY SUPPORT)
----------------------------- */

app.post("/api/grade/submission", async (req, res) => {
  try {
    const { filename, fileBase64, criteria } = req.body;

    const text = await extractTextFromFile({ filename, fileBase64 });

    const audit = gradeAgainstCriteria({ text, criteria });

    const result = {
      fullName: filename,
      audit,
      grade: buildOverallGrade(audit)
    };

    res.json({ result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Single submission failed" });
  }
});

/* -----------------------------
   MULTI-FILE SUBMISSION (NEW)
----------------------------- */

app.post("/api/grade/submission-multi", async (req, res) => {
  try {
    const { files, criteria, submissionLabel } = req.body;

    if (!files || !files.length) {
      return res.status(400).json({ error: "No files provided" });
    }

    const extractedFiles = [];

    for (const file of files) {
      const text = await extractTextFromFile(file);

      extractedFiles.push({
        filename: file.filename,
        role: file.role || "general",
        text
      });
    }

    const combinedText = extractedFiles
      .map(f => `[FILE: ${f.filename}]\n${f.text}`)
      .join("\n\n");

    const audit = gradeAgainstCriteria({
      text: combinedText,
      criteria
    });

    const result = {
      fullName: submissionLabel || "Combined Submission",
      audit,
      grade: buildOverallGrade(audit),
      evidenceTrace: extractedFiles.map(f => ({
        file: f.filename,
        role: f.role
      }))
    };

    res.json({ result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Multi submission failed" });
  }
});

/* -----------------------------
   BRIEF SCAN (BASIC)
----------------------------- */

app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { filename, fileBase64 } = req.body;

    const text = await extractTextFromFile({ filename, fileBase64 });

    const lines = text.split("\n");

    const criteria = [];

    lines.forEach(line => {
      const match = line.match(/([PMD]\d+)\s+(.*)/i);
      if (match) {
        criteria.push({
          code: match[1].toUpperCase(),
          requirement: match[2]
        });
      }
    });

    res.json({
      result: {
        criteria,
        unit_context: "",
        assignment_context: "",
        evidence_requirements: []
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Brief scan failed" });
  }
});

/* -----------------------------
   RECORD STORAGE (TEMP MEMORY)
----------------------------- */

let records = [];

app.post("/api/records/save", (req, res) => {
  const id = Date.now().toString();
  records.push({ id, data: req.body.result });
  res.json({ id });
});

app.post("/api/records/update", (req, res) => {
  const { dbId, result } = req.body;
  records = records.map(r => (r.id === dbId ? { ...r, data: result } : r));
  res.json({ success: true });
});

app.get("/api/records/list", (req, res) => {
  res.json({ records });
});

app.post("/api/records/load", (req, res) => {
  const { ids } = req.body;
  const result = records.filter(r => ids.includes(r.id));
  res.json({ records: result });
});

/* -----------------------------
   START SERVER
----------------------------- */

app.listen(PORT, () => {
  console.log(`🚀 MGTS Feedback Server running on port ${PORT}`);
});
