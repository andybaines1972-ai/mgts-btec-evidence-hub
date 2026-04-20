import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
const upload = multer();
const PORT = process.env.PORT || 3000;

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

app.use(cors());
app.use(express.json({ limit: "25mb" }));

/**
 * AI Assessment Proxy
 * Calibrated for BTEC Mastery Model and Command Verb Taxonomies
 */
app.post("/api/evaluate", async (req, res) => {
  try {
    const { portfolio, level, criteria, mode } = req.body;
    const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash-preview-09-2025";
    const model = genAI.getGenerativeModel({ model: modelName });

    const prompt = `
      You are an expert Lead Internal Verifier for BTEC Engineering.
      Evaluation Context: Level ${level}
      Mode: ${mode || 'Formative'} (If Summative: No coaching, justify strictly based on evidence.)

      TASK:
      Evaluate the student portfolio against the following criteria. 
      For each, provide a binary status (Met / Not Met) and a professional justification.

      CRITERIA:
      ${JSON.stringify(criteria)}
      
      STUDENT EVIDENCE:
      ${portfolio}
      
      LOGIC RULES:
      1. Binary Mastery: Every criterion is either Met or Not Met.
      2. Command Verbs: Level 3 requires Description/Identification. Level 4/5 requires Analysis/Evaluation.
      3. Attribution: Quote or reference specific parts of the portfolio to justify decisions.

      OUTPUT FORMAT: STRICT JSON
      { 
        "criteria_results": [ { "id": "P1", "status": "Met"|"Not Met", "reason": "...", "citation": "..." } ], 
        "overall_summary": "...",
        "suggested_grade": "Referral"|"Pass"|"Merit"|"Distinction"
      }
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().replace(/```json|```/g, "").trim();

    res.json(JSON.parse(text));
  } catch (error) {
    console.error("AI Evaluation Error:", error);
    res.status(500).json({ error: "Failed to evaluate portfolio." });
  }
});

/**
 * File Text Extraction
 */
app.post("/api/parse", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    let extractedText = "";
    const filename = req.file.originalname;

    if (filename.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      extractedText = result.value;
    } else if (filename.endsWith(".pdf")) {
      const data = await pdfParse(req.file.buffer);
      extractedText = data.text;
    } else {
      extractedText = req.file.buffer.toString("utf8");
    }

    res.json({ text: extractedText });
  } catch (error) {
    console.error("Parsing Error:", error);
    res.status(500).json({ error: "Failed to parse document." });
  }
});

app.listen(PORT, () => {
  console.log(`MGTS Studio Backend running on port ${PORT}`);
});
