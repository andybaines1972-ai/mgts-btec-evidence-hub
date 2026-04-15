import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import crypto from "crypto";


dotenv.config();

const app = express();


app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.PORT || 3000;

/* =========================
   CONFIG
========================= */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

/* =========================
   HELPERS
========================= */

function hashLearnerName(name) {
  return crypto.createHash("sha256").update(name).digest("hex").slice(0, 10);
}

function extractLearnerName(text) {
  const match = text.match(/Name\s*[:\-]\s*(.+)/i);
  return match ? match[1].trim() : "Unknown Learner";
}

async function extractTextFromFile(fileBuffer, filename) {
  if (filename.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    return result.value;
  }
  if (filename.endsWith(".pdf")) {
    const result = await pdfParse(fileBuffer);
    return result.text;
  }
  return "";
}

async function callOpenAI(prompt) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-5.3",
      input: prompt,
      temperature: 0.2
    })
  });

  const data = await response.json();
  return data.output_text || "";
}

/* =========================
   AUTH (Supabase JWT passthrough)
========================= */

function getUserId(req) {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "");
  if (!token) return null;

  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    return payload.sub;
  } catch {
    return null;
  }
}

/* =========================
   CLIENT CONFIG
========================= */

app.get("/api/client-config", (req, res) => {
  res.json({
    logoUrl: "https://www.mgts.co.uk/wp-content/themes/mgts/images/svg/logo.svg"
  });
});

/* =========================
   BRIEF SCAN
========================= */

app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { fileBase64, filename } = req.body;
    const buffer = Buffer.from(fileBase64, "base64");
    const text = await extractTextFromFile(buffer, filename);

    const prompt = `
Extract:
1. Criteria list (code + requirement)
2. Unit context
3. Assignment context
4. Evidence requirements

Return JSON.
Text:
${text}
`;

    const ai = await callOpenAI(prompt);
    const parsed = JSON.parse(ai);

    res.json({ result: parsed });
  } catch (err) {
    res.status(500).json({ error: "Brief scan failed" });
  }
});

/* =========================
   SUBMISSION GRADING
========================= */

app.post("/api/grade/submission", async (req, res) => {
  try {
    const {
      fileBase64,
      filename,
      criteria,
      mode
    } = req.body;

    const buffer = Buffer.from(fileBase64, "base64");
    const text = await extractTextFromFile(buffer, filename);

    const learnerName = extractLearnerName(text);
    const learnerCode = hashLearnerName(learnerName);

    const prompt = `
You are a BTEC assessor.

Evaluate submission against criteria.

Return JSON:
{
 fullName,
 audit:[
  {id, requirement, status, confidenceScore, evidencePage, evidenceAndDepth, rationale, action}
 ]
}

Criteria:
${JSON.stringify(criteria)}

Submission:
${text}
`;

    const ai = await callOpenAI(prompt);
    const parsed = JSON.parse(ai);

    parsed.fullName = learnerCode; // pseudonymised

    parsed.audit = parsed.audit.map(item => ({
      ...item,
      finalStatus: item.status
    }));

    res.json({ result: parsed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Grading failed" });
  }
});

/* =========================
   RECORD SAVE
========================= */

app.post("/api/records/save", async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const { result, unit } = req.body;

    const response = await fetch(`${SUPABASE_URL}/rest/v1/records`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        user_id: userId,
        learner_name: result.fullName,
        unit,
        grade: result.grade || "",
        record_status: result.recordControl?.recordStatus || "Draft",
        data: result
      })
    });

    const data = await response.json();
    res.json({ id: data[0]?.id });
  } catch (err) {
    res.status(500).json({ error: "Save failed" });
  }
});

/* =========================
   UPDATE
========================= */

app.post("/api/records/update", async (req, res) => {
  try {
    const { dbId, result } = req.body;

    await fetch(`${SUPABASE_URL}/rest/v1/records?id=eq.${dbId}`, {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        grade: result.grade,
        record_status: result.recordControl?.recordStatus,
        data: result
      })
    });

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: "Update failed" });
  }
});

/* =========================
   LIST
========================= */

app.get("/api/records/list", async (req, res) => {
  try {
    const userId = getUserId(req);

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/records?user_id=eq.${userId}&order=created_at.desc`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      }
    );

    const data = await response.json();
    res.json({ records: data });
  } catch {
    res.status(500).json({ error: "List failed" });
  }
});

/* =========================
   LOAD
========================= */

app.post("/api/records/load", async (req, res) => {
  try {
    const { ids } = req.body;

    let query = `${SUPABASE_URL}/rest/v1/records?select=*`;
    if (ids.length) query += `&id=in.(${ids.join(",")})`;

    const response = await fetch(query, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    });

    const data = await response.json();
    res.json({ records: data });
  } catch {
    res.status(500).json({ error: "Load failed" });
  }
});

/* ========================= */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
