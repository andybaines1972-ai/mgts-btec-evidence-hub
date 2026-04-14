import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || "").trim();
const ADMIN_TOKEN_SECRET = String(process.env.ADMIN_TOKEN_SECRET || "").trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "").trim();

const DEFAULT_PRIMARY_MODEL = String(process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
const DEFAULT_FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-1.5-flash",
  "gemini-2.5-pro",
  "gemini-1.5-pro"
];

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const HAS_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const supabase = HAS_SUPABASE ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

function requireAdmin(req, res, next) {
  const authHeader = String(req.headers.authorization || "").trim();
  const token = authHeader.replace(/^Bearer\s+/i, "").trim() || authHeader;

  if (!token || !ADMIN_TOKEN_SECRET || token !== ADMIN_TOKEN_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  return next();
}

function cleanTutorText(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/backend/gi, "system")
    .replace(/\bAPI\b/gi, "service")
    .trim();
}

function compact(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function buildCriterionActionPlan({
  decision = "Review Required",
  action = "",
  criterionCode = "This criterion",
  criterionRequirement = "",
  confidenceScore = 60
} = {}) {
  const cleanedAction = compact(action);
  const code = compact(criterionCode) || "This criterion";
  const requirement = compact(criterionRequirement);
  const confidence = Math.max(0, Math.min(100, Number(confidenceScore) || 60));

  const thresholdHint = requirement
    ? `Threshold check: ensure your evidence explicitly meets "${requirement}".`
    : "Threshold check: ensure your evidence is explicit, detailed, and directly mapped to the criterion wording.";

  const nextStep = decision === "Achieved"
    ? `Next step: consolidate ${code} by adding one clearer example, justification, or evaluative point that deepens quality rather than repeating description.`
    : `Next step: strengthen ${code} by expanding evidence depth and directly linking each key point to the command verb in the criterion.`;

  const pathway = confidence >= 85
    ? "Pathway to improve: refine structure and precision so your strongest points are easier to verify quickly at assessor review."
    : "Pathway to improve: add sharper analysis, clearer justification, and explicit signposting so the evidence moves securely beyond the threshold.";

  if (!cleanedAction) {
    return `${nextStep} ${thresholdHint} ${pathway}`.trim();
  }

  return `${cleanedAction} ${thresholdHint} ${pathway}`.trim();
}

function toDecision(value = "") {
  const normalized = String(value || "").trim();
  if (["Achieved", "Not Yet Achieved", "Review Required"].includes(normalized)) {
    return normalized;
  }
  return "Review Required";
}

function safeJsonParse(raw, fallback) {
  try {
    const text = String(raw || "")
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",");

    return `{${body}}`;
  }

  return JSON.stringify(value);
}

function buildCacheKey(payload) {
  const canonical = stableStringify({
    mode: payload.mode || "",
    qualificationLabel: payload.qualificationLabel || "",
    unitInfo: payload.unitInfo || "",
    watchouts: payload.watchouts || "",
    learnerText: payload.learnerText || "",
    criterion: payload.criterion || {},
    strategy: payload.strategy || {},
    version: "server-clean-2026-04-14"
  });

  return crypto.createHash("sha256").update(canonical).digest("hex");
}

async function getCachedGrade(cacheKey) {
  if (!HAS_SUPABASE) return null;

  const { data, error } = await supabase
    .from("criterion_cache")
    .select("payload")
    .eq("key", cacheKey)
    .maybeSingle();

  if (error || !data?.payload) return null;
  return data.payload;
}

async function setCachedGrade(cacheKey, payload) {
  if (!HAS_SUPABASE) return;

  await supabase
    .from("criterion_cache")
    .upsert({ key: cacheKey, payload: { ...payload, cachedAt: new Date().toISOString() } });
}

function normaliseBriefScanResult(parsed = {}) {
  const rawCriteria = Array.isArray(parsed.criteria)
    ? parsed.criteria
    : Array.isArray(parsed.assessment_criteria)
      ? parsed.assessment_criteria
      : [];

  const criteria = rawCriteria
    .map((item) => {
      if (typeof item === "string") {
        const match = item.match(/^([A-Za-z0-9.\- ]{1,})\s*[:\-]\s*(.+)$/);
        if (!match) return null;
        return {
          code: String(match[1]).trim().toUpperCase().replace(/\s+/g, ""),
          requirement: String(match[2]).trim()
        };
      }

      return {
        code: String(item?.code || item?.criterion || "").trim().toUpperCase().replace(/\s+/g, ""),
        requirement: String(item?.requirement || item?.description || item?.text || "").trim()
      };
    })
    .filter((item) => item?.code && item?.requirement);

  return {
    unit_number: String(parsed.unit_number || "").trim(),
    unit_title: String(parsed.unit_title || "").trim(),
    learning_aims: Array.isArray(parsed.learning_aims)
      ? parsed.learning_aims.map((x) => String(x).trim()).filter(Boolean)
      : [],
    assignment_title: String(parsed.assignment_title || "").trim(),
    assignment_context: cleanTutorText(parsed.assignment_context || ""),
    criteria,
    task_mapping: Array.isArray(parsed.task_mapping) ? parsed.task_mapping : [],
    evidence_requirements: Array.isArray(parsed.evidence_requirements)
      ? parsed.evidence_requirements.map((x) => cleanTutorText(x)).filter(Boolean)
      : [],
    unit_context: cleanTutorText(parsed.unit_context || "")
  };
}

function normaliseGradeResult(parsed = {}, criterion = {}) {
  const decision = toDecision(parsed.decision);
  const confidence = Math.max(0, Math.min(100, Number(parsed.confidence_score) || 60));

  return {
    decision,
    confidence_score: confidence,
    evidence_page: cleanTutorText(parsed.evidence_page || "Page reference not identified"),
    evidence_and_depth: cleanTutorText(parsed.evidence_and_depth || "No substantial evidence summary returned."),
    rationale: cleanTutorText(parsed.rationale || "No rationale returned."),
    action: cleanTutorText(
      buildCriterionActionPlan({
        decision,
        action: parsed.action || "",
        criterionCode: criterion.code || "",
        criterionRequirement: criterion.requirement || "",
        confidenceScore: confidence
      })
    )
  };
}

async function callGeminiJson({ modelName, prompt, fallback }) {
  if (!genAI) throw new Error("GEMINI_API_KEY is missing.");

  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0,
      topP: 0.1,
      responseMimeType: "application/json"
    }
  });

  const response = await model.generateContent(prompt);
  const text = typeof response?.response?.text === "function"
    ? await response.response.text()
    : String(response?.response?.text || "");

  return safeJsonParse(text, fallback);
}

async function callGeminiWithFallback({ prompt, fallback, primaryModel, fallbackModels }) {
  const triedModels = [];
  const models = [primaryModel, ...fallbackModels].filter(Boolean);

  for (const modelName of models) {
    triedModels.push(modelName);
    try {
      const parsed = await callGeminiJson({ modelName, prompt, fallback });
      return { parsed, modelUsed: modelName, triedModels };
    } catch (error) {
      const message = String(error?.message || error || "");
      if (!/(503|429|unavailable|overloaded|deadline|temporar)/i.test(message)) {
        throw error;
      }
    }
  }

  return { parsed: fallback, modelUsed: "fallback", triedModels };
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "mgts-btec-feedback-backend",
    db_connected: HAS_SUPABASE,
    persistence: HAS_SUPABASE ? "supabase" : "disabled"
  });
});

app.post("/api/auth/admin-login", (req, res) => {
  if (!ADMIN_PASSWORD || !ADMIN_TOKEN_SECRET) {
    return res.status(503).json({ error: "Admin authentication is not configured." });
  }

  const password = String(req.body?.password || "").trim();
  if (!password) return res.status(400).json({ error: "Password is required." });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Invalid password" });

  return res.json({ token: ADMIN_TOKEN_SECRET });
});

app.post("/api/brief/scan", async (req, res) => {
  try {
    const briefText = String(req.body?.briefText || "").trim();
    if (!briefText) return res.status(400).json({ error: "briefText is required." });

    const prompt = `You are extracting structured data from a BTEC assignment brief.
Return JSON only with fields: unit_number, unit_title, learning_aims, assignment_title, assignment_context, criteria (array of {code, requirement}), task_mapping, evidence_requirements, unit_context.
Extract every criterion code and requirement exactly where possible.

Brief text:
${briefText.slice(0, 100000)}`;

    const { parsed, modelUsed, triedModels } = await callGeminiWithFallback({
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
      },
      primaryModel: DEFAULT_PRIMARY_MODEL,
      fallbackModels: DEFAULT_FALLBACK_MODELS
    });

    const result = normaliseBriefScanResult(parsed);

    if (!result.criteria.length) {
      return res.status(422).json({
        error: "Brief scan completed but no mappable criteria were detected. Please upload a clearer brief.",
        result,
        modelUsed,
        triedModels
      });
    }

    return res.json({ result, modelUsed, triedModels });
  } catch (error) {
    return res.status(500).json({ error: "An internal system error occurred.", detail: String(error?.message || error) });
  }
});

app.post("/api/grade/criterion", requireAdmin, async (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.learnerText || !payload.criterion) {
      return res.status(400).json({ error: "learnerText and criterion are required." });
    }

    const cacheKey = buildCacheKey(payload);
    const cached = await getCachedGrade(cacheKey);
    if (cached) return res.json({ ...cached, cached: true, cacheKey });

    const criterion = payload.criterion || {};
    const prompt = `You are an experienced BTEC assessor. Return strict JSON with learner_name, decision, confidence_score, evidence_page, evidence_and_depth, rationale, action.

Decision values must be one of: Achieved, Review Required, Not Yet Achieved.

Criterion code: ${criterion.code || ""}
Criterion requirement: ${criterion.requirement || ""}
Unit info: ${payload.unitInfo || "Not provided"}
Assessor watchouts: ${payload.watchouts || "None"}

Learner submission:
${String(payload.learnerText).slice(0, 100000)}`;

    const strategy = payload.strategy || {};
    const primaryModel = String(strategy.primaryModel || DEFAULT_PRIMARY_MODEL).trim();
    const fallbackModels = Array.isArray(strategy.fallbackModels) && strategy.fallbackModels.length
      ? strategy.fallbackModels
      : DEFAULT_FALLBACK_MODELS;

    const { parsed, modelUsed, triedModels } = await callGeminiWithFallback({
      prompt,
      fallback: {
        learner_name: "",
        decision: "Review Required",
        confidence_score: 55,
        evidence_page: "Page reference not identified",
        evidence_and_depth: "The submission could not be confirmed fully at this time.",
        rationale: "A secure judgement could not be confirmed from the available result.",
        action: "Return to this criterion and strengthen directly relevant evidence."
      },
      primaryModel,
      fallbackModels
    });

    const result = normaliseGradeResult(parsed, criterion);
    const response = { result, modelUsed, triedModels, cached: false, cacheKey };

    await setCachedGrade(cacheKey, response);
    return res.json(response);
  } catch (error) {
    return res.status(500).json({ error: "An internal system error occurred.", detail: String(error?.message || error) });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on ${PORT}`);
});
