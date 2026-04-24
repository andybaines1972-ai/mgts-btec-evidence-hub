import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;

/* =========================
   ENV
========================= */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

/* =========================
   HEALTH
========================= */
app.get("/", (req, res) => {
  res.send("✅ MGTS 2-PASS SERVER RUNNING");
});

/* =========================
   CREATE JOB
========================= */
app.post("/api/jobs/create", async (req, res) => {
  try {
    const payload = req.body;

    const { data, error } = await supabase
      .from("grading_jobs")
      .insert([
        {
          status: "queued",
          progress: 0,
          payload,
        },
      ])
      .select()
      .single();

    if (error) throw error;

    processJob(data.id);

    res.json({ jobId: data.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   GET JOB
========================= */
app.get("/api/jobs/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("grading_jobs")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   PROCESS JOB
========================= */
async function processJob(jobId) {
  try {
    await updateJob(jobId, { status: "processing", progress: 5 });

    const { data: job } = await supabase
      .from("grading_jobs")
      .select("*")
      .eq("id", jobId)
      .single();

    const { files, criteria } = job.payload;

    const fullText = files.map(f => f.text || "").join("\n");

    let results = [];

    for (let i = 0; i < criteria.length; i++) {
      const c = criteria[i];

      await updateJob(jobId, {
        progress: Math.round((i / criteria.length) * 90),
        stage: `Processing ${c.code}`
      });

      // PASS 1: extract evidence
      const evidence = await extractEvidence(fullText, c);

      // PASS 2: grade using evidence
      const judgement = await gradeFromEvidence(c, evidence);

      results.push(judgement);
    }

    const final = {
      audit: results,
      summary: buildSummary(results)
    };

    await updateJob(jobId, {
      status: "completed",
      progress: 100,
      result: final
    });

  } catch (err) {
    console.error(err);

    await updateJob(jobId, {
      status: "failed",
      error: err.message
    });
  }
}

/* =========================
   UPDATE JOB
========================= */
async function updateJob(id, fields) {
  await supabase
    .from("grading_jobs")
    .update(fields)
    .eq("id", id);
}

/* =========================
   GEMINI CALL
========================= */
async function callGemini(system, user) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.2,
          topP: 0.8,
          maxOutputTokens: 2048
        }
      })
    }
  );

  const json = await res.json();

  if (json.error) throw new Error(json.error.message);

  return json.candidates[0].content.parts[0].text;
}

/* =========================
   PASS 1: EVIDENCE EXTRACTION
========================= */
async function extractEvidence(text, criterion) {
  const system = `
You are an evidence extraction engine.

ONLY extract evidence relevant to ${criterion.code}.

Return JSON:
{
  "quotes": ["exact quote 1", "exact quote 2"],
  "notes": "what the student is attempting"
}
`;

  const user = `
CRITERION:
${criterion.code} - ${criterion.requirement}

STUDENT WORK:
${text.substring(0, 40000)}
`;

  const raw = await callGemini(system, user);

  try {
    return JSON.parse(raw);
  } catch {
    return { quotes: [], notes: "No structured evidence found." };
  }
}

/* =========================
   PASS 2: JUDGEMENT
========================= */
async function gradeFromEvidence(criterion, evidence) {
  const system = `
You are a senior BTEC assessor.

STRICT RULES:
- Only use provided evidence
- No guessing
- If weak evidence → NOT ACHIEVED

Return JSON:
{
  "id": "${criterion.code}",
  "status": "Achieved or Not Achieved",
  "justification": "...clear reasoning...",
  "evidence": "...best quote...",
  "action": "...specific improvement..."
}
`;

  const user = `
CRITERION:
${criterion.code} - ${criterion.requirement}

EVIDENCE:
${JSON.stringify(evidence)}
`;

  const raw = await callGemini(system, user);

  try {
    return JSON.parse(raw);
  } catch {
    return {
      id: criterion.code,
      status: "Not Achieved",
      justification: "Model failed to return structured output.",
      evidence: "",
      action: "Re-run analysis."
    };
  }
}

/* =========================
   SUMMARY BUILDER
========================= */
function buildSummary(results) {
  const achieved = results.filter(r =>
    r.status.toLowerCase().includes("achieved")
  ).length;

  return `Criteria achieved: ${achieved}/${results.length}`;
}
app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { filename, fileBase64 } = req.body;

    if (!filename || !fileBase64) {
      return res.status(400).json({ error: "filename and fileBase64 are required" });
    }

    let text = "";

    if (filename.toLowerCase().endsWith(".docx")) {
      const mammoth = await import("mammoth");
      const buffer = Buffer.from(fileBase64, "base64");
      const result = await mammoth.default.extractRawText({ buffer });
      text = result.value || "";
    } else if (filename.toLowerCase().endsWith(".txt")) {
      text = Buffer.from(fileBase64, "base64").toString("utf8");
    } else {
      return res.status(400).json({
        error: "Brief scan currently supports DOCX and TXT."
      });
    }

    const system = `
You are a BTEC assignment brief interpreter.

Extract all assessment criteria.

Return valid JSON only:
{
  "unitTitle": "",
  "unitNumber": "",
  "learningAims": [],
  "tasks": [],
  "criteria": [
    {
      "code": "P1",
      "requirement": "",
      "band": "P",
      "linkedLearningAims": [],
      "linkedTasks": [],
      "commandVerbs": []
    }
  ],
  "assignmentContext": "",
  "unitContext": "",
  "evidenceRequirements": [],
  "ambiguityFlags": [],
  "extractedFrom": "${filename}",
  "schemaVersion": "brief.v1"
}
`;

    const user = `
ASSIGNMENT BRIEF TEXT:
${text.substring(0, 60000)}
`;

    const raw = await callGemini(system, user);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { criteria: [] };
    }

    if (!Array.isArray(parsed.criteria) || !parsed.criteria.length) {
      const fallbackCriteria = [];
      const regex = /\b([PMD]\d+)\b\s*[:\-–—.]?\s*([^\n\r]+)/gi;
      let match;

      while ((match = regex.exec(text)) !== null) {
        fallbackCriteria.push({
          code: match[1].toUpperCase(),
          requirement: match[2].trim(),
          band: match[1][0].toUpperCase(),
          linkedLearningAims: [],
          linkedTasks: [],
          commandVerbs: []
        });
      }

      parsed.criteria = fallbackCriteria;
    }

    res.json({ result: parsed });
  } catch (err) {
    console.error("scan-file failed:", err);
    res.status(500).json({ error: err.message });
  }
});
/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`🚀 MGTS 2-pass server running on port ${PORT}`);
});
