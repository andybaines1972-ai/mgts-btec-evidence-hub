import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

/* =========================
   ENV CONFIG
========================= */
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!GEMINI_API_KEY) console.warn("⚠️ Missing GEMINI_API_KEY");
if (!SUPABASE_URL) console.warn("⚠️ Missing SUPABASE_URL");

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
);

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.send("✅ MGTS Grading Server Running");
});

/* =========================
   CREATE JOB
========================= */
app.post("/api/create-job", async (req, res) => {
  try {
    const { text, criteria, context, assessor } = req.body;

    const { data, error } = await supabase
      .from("grading_jobs")
      .insert([
        {
          status: "queued",
          progress: 0,
          payload: { text, criteria, context, assessor },
        },
      ])
      .select()
      .single();

    if (error) throw error;

    processJob(data.id); // fire async

    res.json({ jobId: data.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   GET JOB STATUS
========================= */
app.get("/api/job/:id", async (req, res) => {
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

    const { text, criteria, context } = job.payload;

    let results = [];

    for (let i = 0; i < criteria.length; i++) {
      const c = criteria[i];

      await updateJob(jobId, {
        progress: Math.round((i / criteria.length) * 90),
      });

      const feedback = await gradeCriterion(text, c, context);

      results.push(feedback);
    }

    const final = buildFinal(results);

    await updateJob(jobId, {
      status: "complete",
      progress: 100,
      result: final,
    });

  } catch (err) {
    console.error("❌ Job failed:", err);

    await updateJob(jobId, {
      status: "error",
      error: err.message,
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
          maxOutputTokens: 2048,
        },
      }),
    }
  );

  const json = await res.json();

  if (json.error) throw new Error(json.error.message);

  return json.candidates[0].content.parts[0].text;
}

/* =========================
   CRITERION GRADING (KEY FIX)
========================= */
async function gradeCriterion(text, criterion, context) {
  const system = `
You are a senior Pearson BTEC assessor.

You MUST:
- Evaluate ONLY ${criterion}
- Use the provided requirement EXACTLY
- Extract REAL quotes from the student work
- Avoid generic statements
- Provide deep, specific reasoning

FORMAT JSON:
{
  "id": "${criterion}",
  "status": "Achieved or Not Achieved",
  "justification": "...",
  "evidence": "...quote...",
  "action": "...clear improvement steps..."
}
`;

  const user = `
CRITERIA MAP:
${context}

STUDENT WORK:
${text.substring(0, 40000)}
`;

  const raw = await callGemini(system, user);

  try {
    return JSON.parse(raw);
  } catch {
    return {
      id: criterion,
      status: "Not Achieved",
      justification: "Model failed to return structured output.",
      evidence: "",
      action: "Re-run analysis.",
    };
  }
}

/* =========================
   FINAL BUILD
========================= */
function buildFinal(results) {
  return {
    audit: results,
    summary: "Full structured assessment generated.",
  };
}

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
