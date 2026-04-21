const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

/* ================================
   ENV
================================ */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ================================
   HEALTH + CLIENT CONFIG
================================ */
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// 🔥 FIX: frontend expected this
app.get("/api/client-config", (_req, res) => {
  res.json({
    logoUrl: "https://www.mgts.co.uk/wp-content/themes/mgts/images/svg/logo.svg"
  });
});

/* ================================
   HELPERS
================================ */
function normaliseStatus(value = "") {
  const v = String(value).toLowerCase();

  if (v.includes("not")) return "Not Achieved";
  if (v.includes("review")) return "Review Required";
  if (v.includes("ach")) return "Achieved";

  return "Review Required";
}

function calculateOverallGrade(audit = []) {
  const statuses = audit.map(a => a.finalStatus || a.status);

  if (statuses.includes("Not Achieved")) return "Not Achieved";
  if (statuses.includes("Review Required")) return "Review Required";
  return "Achieved";
}

/* ================================
   GEMINI CALL
================================ */
async function callGemini(model, body) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
    }
  );

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";

  return text;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ================================
   BRIEF SCAN (UPGRADED)
================================ */
app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { filename, fileBase64 } = req.body;

    const prompt = {
      contents: [
        {
          parts: [
            {
              text: `
Extract structured BTEC brief data.

Return JSON:
{
  "criteria":[{"code":"P1","requirement":"..."}],
  "unit_context":"...",
  "assignment_context":"...",
  "evidence_requirements":["..."],
  "extracted_from":"${filename}"
}

Rules:
- Only valid P/M/D criteria
- Keep wording concise
`
            },
            {
              inline_data: {
                mime_type: "application/pdf",
                data: fileBase64
              }
            }
          ]
        }
      ]
    };

    const raw = await callGemini("gemini-2.5-flash", prompt);
    const parsed = safeParse(raw);

    return res.json({ result: parsed });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================================
   GRADE (MULTI + SINGLE FIXED)
================================ */
async function runGrading(payload) {
  const prompt = {
    contents: [
      {
        parts: [
          {
            text: `
You are a BTEC assessor.

Return JSON:
{
  "fullName":"Learner",
  "audit":[
    {
      "id":"P1",
      "status":"Achieved | Not Achieved | Review Required",
      "finalStatus":"Achieved | Not Achieved | Review Required",
      "rationale":"...",
      "action":"...",
      "confidenceScore":0-100
    }
  ]
}

Context:
Unit: ${payload.unitInfo}
Tutor Notes: ${payload.tutorNotes || ""}

Criteria:
${JSON.stringify(payload.criteria)}
`
          }
        ]
      }
    ]
  };

  const raw = await callGemini("gemini-2.5-flash", prompt);
  const parsed = safeParse(raw);

  let audit = payload.criteria.map(c => {
    const found = parsed?.audit?.find(a => a.id === c.code);

    return {
      id: c.code,
      requirement: c.requirement,
      status: normaliseStatus(found?.status),
      finalStatus: normaliseStatus(found?.finalStatus || found?.status),
      rationale: found?.rationale || "",
      action: found?.action || "",
      confidenceScore: Number(found?.confidenceScore || 50)
    };
  });

  return {
    fullName: parsed?.fullName || "Learner",
    audit,
    grade: calculateOverallGrade(audit),
    meta: {
      model: "gemini-2.5-flash",
      generatedAt: new Date().toISOString()
    }
  };
}

// 🔥 EXISTING
app.post("/api/grade/submission-multi", async (req, res) => {
  try {
    const result = await runGrading(req.body);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🔥 FIX: missing route
app.post("/api/grade/submission", async (req, res) => {
  try {
    const result = await runGrading(req.body);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================================
   RECORDS (FIXED)
================================ */

// 🔥 FIX: frontend expected this
app.get("/api/records/list", async (req, res) => {
  const { data } = await supabase
    .from("feedback_records")
    .select("id, learner_name, unit, grade, record_status, created_at")
    .order("created_at", { ascending: false });

  res.json({ records: data });
});

// 🔥 IMPROVED: supports ID filtering
app.post("/api/records/load", async (req, res) => {
  const ids = req.body.ids || [];

  let query = supabase.from("feedback_records").select("*");

  if (ids.length) query = query.in("id", ids);

  const { data } = await query.order("created_at", { ascending: false });

  res.json({ records: data });
});

app.post("/api/records/save", async (req, res) => {
  const { result, unit } = req.body;

  const { data } = await supabase
    .from("feedback_records")
    .insert([
      {
        learner_name: result.fullName,
        grade: result.grade,
        unit,
        record_status: "Draft",
        data: result
      }
    ])
    .select("id")
    .single();

  res.json({ id: data.id });
});

app.post("/api/records/update", async (req, res) => {
  const { dbId, result } = req.body;

  await supabase
    .from("feedback_records")
    .update({
      grade: result.grade,
      data: result,
      updated_at: new Date().toISOString()
    })
    .eq("id", dbId);

  res.json({ ok: true });
});

/* ================================
   START
================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
