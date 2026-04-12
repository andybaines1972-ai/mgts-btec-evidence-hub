import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

if (!process.env.GEMINI_API_KEY) {
  console.warn("Warning: GEMINI_API_KEY is not set.");
}
if (!process.env.ADMIN_PASSWORD) {
  console.warn("Warning: ADMIN_PASSWORD is not set.");
}
if (!process.env.ADMIN_TOKEN_SECRET) {
  console.warn("Warning: ADMIN_TOKEN_SECRET is not set.");
}

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

function getModelName(preferred) {
  return preferred || process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim() || authHeader.trim();

  if (!token || token !== process.env.ADMIN_TOKEN_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  next();
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function cleanTutorText(value = "") {
  return String(value)
    .replace(/AI service was temporarily unavailable/gi, "this point could not be confirmed fully at the time of review")
    .replace(/temporarily unavailable/gi, "not fully available at the time of review")
    .replace(/couldn't be completed reliably/gi, "could not be confirmed securely")
    .replace(/could not be completed reliably/gi, "could not be confirmed securely")
    .replace(/rerun this criteria later/gi, "return to this criterion and review it again")
    .replace(/rerun this criterion later/gi, "return to this criterion and review it again")
    .replace(/rerun later/gi, "review this again")
    .replace(/retry later/gi, "review this again")
    .replace(/backend/gi, "system")
    .replace(/\bAPI\b/gi, "service")
    .replace(/model limitation(s)?/gi, "current review limitations")
    .replace(/AI/gi, "review process")
    .trim();
}

function normaliseBriefScanResult(parsed) {
  return {
    unit_number: String(parsed?.unit_number || "").trim(),
    unit_title: String(parsed?.unit_title || "").trim(),
    learning_aims: Array.isArray(parsed?.learning_aims)
      ? parsed.learning_aims.map((x) => String(x).trim()).filter(Boolean)
      : [],
    assignment_title: String(parsed?.assignment_title || "").trim(),
    assignment_context: cleanTutorText(parsed?.assignment_context || ""),
    criteria: Array.isArray(parsed?.criteria)
      ? parsed.criteria
          .map((item) => ({
            code: String(item?.code || "").trim().toUpperCase().replace(/\s+/g, ""),
            requirement: String(item?.requirement || "").trim()
          }))
          .filter((item) => item.code && item.requirement)
      : [],
    task_mapping: Array.isArray(parsed?.task_mapping)
      ? parsed.task_mapping.map((item) => ({
          task: String(item?.task || "").trim(),
          criteria: Array.isArray(item?.criteria)
            ? item.criteria.map((x) => String(x).trim().toUpperCase().replace(/\s+/g, "")).filter(Boolean)
            : []
        }))
      : [],
    evidence_requirements: Array.isArray(parsed?.evidence_requirements)
      ? parsed.evidence_requirements.map((x) => cleanTutorText(String(x))).filter(Boolean)
      : [],
    unit_context: cleanTutorText(parsed?.unit_context || "")
  };
}

function normaliseGradeResult(parsed) {
  return {
    decision: String(parsed?.decision || "Review Required").trim(),
    confidence_score: Number(parsed?.confidence_score) || 60,
    evidence_page: cleanTutorText(parsed?.evidence_page || "Page reference not identified"),
    evidence_and_depth: cleanTutorText(parsed?.evidence_and_depth || "No substantial evidence summary returned."),
    rationale: cleanTutorText(parsed?.rationale || "No rationale returned."),
    action: cleanTutorText(parsed?.action || "Review this criterion and strengthen the evidence where needed.")
  };
}

async function callGeminiJson({ model, prompt, fallback }) {
  const response = await genAI.models.generateContent({
    model,
    contents: prompt
  });

  const text =
    response?.text ||
    response?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") ||
    "";

  return safeJsonParse(text, fallback);
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "mgts-btec-feedback-backend",
    model: getModelName()
  });
});

app.post("/api/auth/admin-login", (req, res) => {
  const { password } = req.body || {};

  if (!password) {
    return res.status(400).json({ error: "Password is required." });
  }

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }

  return res.json({
    token: process.env.ADMIN_TOKEN_SECRET
  });
});

app.post("/api/brief/scan", requireAdmin, async (req, res) => {
  try {
    const { briefText } = req.body || {};

    if (!briefText || !String(briefText).trim()) {
      return res.status(400).json({ error: "briefText is required." });
    }

    const prompt = `
You are analysing a Pearson BTEC assignment brief.

Extract structured information from the brief and return JSON only.

Your task is to identify:
1. Unit number
2. Unit title
3. Learning aim(s)
4. Assignment title
5. Assignment context or scenario
6. Criteria list
7. Task-to-criteria mapping
8. Evidence requirements
9. A clean unit context summary for downstream feedback generation

Return JSON in exactly this structure:

{
  "unit_number": "",
  "unit_title": "",
  "learning_aims": [],
  "assignment_title": "",
  "assignment_context": "",
  "criteria": [
    { "code": "P1", "requirement": "" }
  ],
  "task_mapping": [
    { "task": "Task 1", "criteria": ["P1", "M1"] }
  ],
  "evidence_requirements": [],
  "unit_context": ""
}

Rules:
- Keep wording clear and concise.
- Preserve criterion wording as closely as possible.
- Do not invent criteria that are not present.
- If a field is missing, return an empty string or empty array.
- "unit_context" should be a clean summary combining unit, assignment, task structure, and assessment expectations.
- "assignment_context" should sound like a tutor summary, not a marketing summary.
- Return JSON only, with no markdown fences or commentary.

Here is the assignment brief:

${String(briefText).slice(0, 80000)}
`;

    const parsed = await callGeminiJson({
      model: getModelName(),
      prompt,
      fallback: {
        unit_number: "",
        unit_title: "",
        learning_aims: [],
        assignment_title: "",
        assignment_context: "",
        criteria: [],
        task_mapping: [],
        evidence_requirements: [],
        unit_context: ""
      }
    });

    return res.json({
      result: normaliseBriefScanResult(parsed)
    });
  } catch (error) {
    console.error("Brief scan error:", error);
    return res.status(500).json({
      error: "Failed to scan brief."
    });
  }
});

app.post("/api/grade/criterion", requireAdmin, async (req, res) => {
  try {
    const {
      mode,
      qualificationLabel,
      unitInfo,
      unitContextMode = "criteria_only",
      fullUnitInfo = "",
      tutorLedCriteria = "",
      assessmentMode,
      pathway,
      watchouts,
      evidencePrinciples,
      learnerText,
      criterion
    } = req.body || {};

    if (!learnerText || !String(learnerText).trim()) {
      return res.status(400).json({ error: "learnerText is required." });
    }

    if (!criterion || !criterion.code || !criterion.requirement) {
      return res.status(400).json({ error: "criterion with code and requirement is required." });
    }

    let contextBlock = `
Qualification: ${qualificationLabel || "Not provided"}
Unit: ${unitInfo || "Not provided"}
Assessment mode: ${assessmentMode || "Not provided"}
Pathway: ${pathway || "Not specified"}
Mode: ${mode || "assessor"}
Criterion: ${criterion.code} - ${criterion.requirement}
`;

    if (unitContextMode === "criteria_plus_unit" || unitContextMode === "criteria_plus_unit_and_tutor") {
      contextBlock += `

Full unit context:
${String(fullUnitInfo || "").trim()}
`;
    }

    if (unitContextMode === "criteria_plus_unit_and_tutor") {
      contextBlock += `

Tutor-led notes:
${String(tutorLedCriteria || "").trim()}
`;
    }

    const prompt = `
You are supporting a BTEC assessor.

Write feedback and make a criterion judgement using the learner submission, the criterion wording, and the supplied assessment context.

${contextBlock}

Evidence principles:
${String(evidencePrinciples || "").trim()}

Watchouts:
${String(watchouts || "").trim()}

Learner submission:
${String(learnerText).slice(0, 100000)}

Return JSON only in this structure:

{
  "decision": "Achieved",
  "confidence_score": 0,
  "evidence_page": "",
  "evidence_and_depth": "",
  "rationale": "",
  "action": ""
}

Rules:
- Base the decision only on evidence that is present in the learner text.
- Do not invent pages, evidence, or claims.
- Keep the tone professional, clear, and tutor-led.
- Do not mention AI, backend systems, temporary outages, retries, or model limitations in learner-facing fields.
- If evidence is limited or unclear, explain what still needs to be demonstrated in normal assessor language.
- "action" must sound like tutor feedback, not a technical log.
- Respect command verbs such as explain, analyse, evaluate, justify.
- Where unit context or tutor-led notes are provided, use them to make the feedback more assignment-specific and natural.
- Use one of these decisions only:
  - assessor mode: "Achieved", "Review Required", "Not Yet Achieved"
  - student mode: still return assessor-style core judgement and let the front end map the status
- Return JSON only, with no markdown fences or commentary.
`;

    const parsed = await callGeminiJson({
      model: getModelName(),
      prompt,
      fallback: {
        decision: "Review Required",
        confidence_score: 60,
        evidence_page: "Page reference not identified",
        evidence_and_depth: "No substantial evidence summary returned.",
        rationale: "The available evidence could not be confirmed securely from the submission provided.",
        action: "Review this criterion and strengthen the evidence where needed."
      }
    });

    return res.json({
      result: normaliseGradeResult(parsed)
    });
  } catch (error) {
    console.error("Criterion grading error:", error);
    return res.status(500).json({
      error: "Failed to grade criterion."
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Route not found." });
});

app.listen(PORT, () => {
  console.log(`MGTS BTEC backend running on port ${PORT}`);
});
