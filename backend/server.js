import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import rateLimit from "express-rate-limit";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || "").trim();
const ADMIN_TOKEN_SECRET = String(process.env.ADMIN_TOKEN_SECRET || "").trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "").trim();

const DEFAULT_PRIMARY_MODEL = String(
  process.env.GEMINI_MODEL || "gemini-2.5-flash"
).trim();

const DEFAULT_FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-1.5-flash",
  "gemini-1.5-pro"
];

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const HAS_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

const FRONTEND_ORIGIN = String(process.env.FRONTEND_ORIGIN || "").trim();
const FRONTEND_ORIGINS = String(process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = [...new Set([FRONTEND_ORIGIN, ...FRONTEND_ORIGINS].filter(Boolean))];

const supabase = HAS_SUPABASE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

const app = express();
app.set("trust proxy", 1);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (!ALLOWED_ORIGINS.length) {
      return callback(null, true);
    }

    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("CORS blocked"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
  maxAge: 86400
}));

app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cache-Control", "no-store");
  next();
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." }
});

const publicAssessmentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." }
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." }
});

app.use(generalLimiter);
app.use("/api/brief/scan", publicAssessmentLimiter);
app.use("/api/grade/criterion", publicAssessmentLimiter);
app.use("/api/auth/admin-login", adminLoginLimiter);

function requireAdmin(req, res, next) {
  const authHeader = String(req.headers.authorization || "").trim();
  const token = authHeader.replace(/^Bearer\s+/i, "").trim() || authHeader;

  if (!token || !ADMIN_TOKEN_SECRET || token !== ADMIN_TOKEN_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  return next();
}

function cleanTutorText(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/backend/gi, "system")
    .replace(/\bAPI\b/gi, "service")
    .replace(/\bAI\b/gi, "review process")
    .trim();
}

function compact(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
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
    unitContextMode: payload.unitContextMode || "",
    fullUnitInfo: payload.fullUnitInfo || "",
    tutorLedCriteria: payload.tutorLedCriteria || "",
    assessmentMode: payload.assessmentMode || "",
    pathway: payload.pathway || "",
    watchouts: payload.watchouts || "",
    evidencePrinciples: payload.evidencePrinciples || "",
    learnerText: payload.learnerText || "",
    criterion: payload.criterion || {},
    version: "server-public-safe-2026-04-15-v1"
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
    .upsert({
      key: cacheKey,
      payload: {
        ...payload,
        cachedAt: new Date().toISOString()
      }
    });
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

function buildCriterionAction({
  decision = "Review Required",
  action = "",
  criterionCode = "This criterion",
  criterionRequirement = ""
} = {}) {
  const cleanedAction = compact(action);
  const code = compact(criterionCode) || "This criterion";
  const requirement = compact(criterionRequirement);

  if (cleanedAction && !/^none\.?$/i.test(cleanedAction)) {
    return cleanTutorText(cleanedAction);
  }

  if (decision === "Not Yet Achieved") {
    return cleanTutorText(
      requirement
        ? `Return to ${code} and add clearer evidence that directly meets "${requirement}".`
        : `Return to ${code} and add clearer directly relevant evidence.`
    );
  }

  if (decision === "Review Required") {
    return cleanTutorText(
      requirement
        ? `Strengthen ${code} by making the evidence more explicit against "${requirement}".`
        : `Strengthen ${code} by making the evidence more explicit and directly linked to the criterion wording.`
    );
  }

  if (code.startsWith("P")) {
    return "To strengthen this further, add more evaluative commentary, clearer justification, and stronger links to higher-grade performance where relevant.";
  }

  if (code.startsWith("M")) {
    return "To push this further, deepen the analysis, compare alternatives more explicitly, and make the justification more critical and precise.";
  }

  if (code.startsWith("D")) {
    return "To extend this high-level response even further, add broader professional reflection, benchmark against recognised industry practice, and include more forward-looking recommendations.";
  }

  return "Continue improving this area by sharpening the evidence trail, using explicit references, and adding stronger evaluative commentary.";
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
    action: buildCriterionAction({
      decision,
      action: parsed.action || "",
      criterionCode: criterion.code || "",
      criterionRequirement: criterion.requirement || ""
    })
  };
}

async function extractTextFromGeminiResponse(result) {
  try {
    if (typeof result?.response?.text === "function") {
      return await result.response.text();
    }

    if (typeof result?.response?.text === "string") {
      return result.response.text;
    }

    const candidates = result?.response?.candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
      const parts = candidates[0]?.content?.parts;
      if (Array.isArray(parts)) {
        return parts.map((p) => p?.text || "").join("").trim();
      }
    }

    return "";
  } catch {
    return "";
  }
}

async function callGeminiJson({ modelName, prompt, fallback }) {
  if (!genAI) {
    throw new Error("Model service is not configured.");
  }

  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0,
      topP: 0.1,
      responseMimeType: "application/json"
    }
  });

  const result = await model.generateContent(prompt);
  const text = await extractTextFromGeminiResponse(result);

  if (!text) {
    throw new Error(`Empty response from model ${modelName}`);
  }

  return safeJsonParse(text, fallback);
}

function shouldTryNextModel(error) {
  const message = String(error?.message || error || "").toLowerCase();

  return (
    message.includes("404") ||
    message.includes("not found") ||
    message.includes("not supported") ||
    message.includes("model") ||
    message.includes("503") ||
    message.includes("429") ||
    message.includes("unavailable") ||
    message.includes("overloaded") ||
    message.includes("deadline") ||
    message.includes("temporary") ||
    message.includes("temporar")
  );
}

async function callGeminiWithFallback({ prompt, fallback, primaryModel, fallbackModels }) {
  const models = [...new Set([primaryModel, ...(fallbackModels || [])].filter(Boolean))];
  let lastError = null;

  for (const modelName of models) {
    try {
      const parsed = await callGeminiJson({ modelName, prompt, fallback });
      return { parsed };
    } catch (error) {
      lastError = error;
      console.error(`[Gemini] Model failed: ${modelName}`, String(error?.message || error));

      if (!shouldTryNextModel(error)) {
        throw error;
      }
    }
  }

  throw new Error(`All model attempts failed. Last error: ${String(lastError?.message || lastError)}`);
}

function validateCriterionPayload(payload = {}) {
  if (!payload || typeof payload !== "object") {
    return "Invalid request body.";
  }

  if (!String(payload.learnerText || "").trim()) {
    return "learnerText is required.";
  }

  if (!payload.criterion || typeof payload.criterion !== "object") {
    return "criterion is required.";
  }

  const learnerTextLength = String(payload.learnerText || "").length;
  if (learnerTextLength > 120000) {
    return "learnerText is too large.";
  }

  return null;
}

app.get("/health", (req, res) => {
  return res.json({
    status: "ok",
    service: "mgts-btec-feedback-backend"
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

    if (!briefText) {
      return res.status(400).json({ error: "briefText is required." });
    }

    if (briefText.length > 120000) {
      return res.status(400).json({ error: "briefText is too large." });
    }

    const prompt = `You are extracting structured data from a BTEC assignment brief.
Return JSON only with fields: unit_number, unit_title, learning_aims, assignment_title, assignment_context, criteria (array of {code, requirement}), task_mapping, evidence_requirements, unit_context.
Extract every criterion code and requirement exactly where possible.

Brief text:
${briefText.slice(0, 100000)}`;

    const { parsed } = await callGeminiWithFallback({
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
        result
      });
    }

    return res.json({ result });
  } catch (error) {
    console.error("Brief scan failed:", error);
    return res.status(500).json({
      error: "Request could not be completed."
    });
  }
});

app.post("/api/grade/criterion", async (req, res) => {
  try {
    const payload = req.body || {};
    const validationError = validateCriterionPayload(payload);

    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const cacheKey = buildCacheKey(payload);
    const cached = await getCachedGrade(cacheKey);

    if (cached) {
      return res.json({
        result: cached.result,
        cached: true
      });
    }

    const criterion = payload.criterion || {};
    const prompt = `You are an experienced BTEC assessor.

Return strict JSON with these fields only:
learner_name, decision, confidence_score, evidence_page, evidence_and_depth, rationale, action

Rules:
- decision must be one of: Achieved, Review Required, Not Yet Achieved
- If the evidence clearly meets the criterion, set decision to Achieved
- rationale must agree with the decision
- action must be short and practical
- If decision is Achieved, action may still include brief developmental feedback
- Do not contradict yourself
- Be specific and concise
- Do not mention system limitations
- Do not mention data protection or policy wording
- Do not reveal hidden reasoning

Criterion code: ${criterion.code || ""}
Criterion requirement: ${criterion.requirement || ""}
Qualification label: ${payload.qualificationLabel || "Not provided"}
Unit info: ${payload.unitInfo || "Not provided"}
Unit context mode: ${payload.unitContextMode || "criteria_only"}
Full unit context: ${payload.fullUnitInfo || ""}
Tutor-led notes: ${payload.tutorLedCriteria || ""}
Assessment mode: ${payload.assessmentMode || "Not provided"}
Pathway: ${payload.pathway || "Not specified"}
Assessor watchouts: ${payload.watchouts || "None"}
Evidence principles: ${payload.evidencePrinciples || "None"}

Learner submission:
${String(payload.learnerText).slice(0, 100000)}`;

    const strategy = payload.strategy || {};
    const primaryModel = String(strategy.primaryModel || DEFAULT_PRIMARY_MODEL).trim();
    const fallbackModels =
      Array.isArray(strategy.fallbackModels) && strategy.fallbackModels.length
        ? strategy.fallbackModels
        : DEFAULT_FALLBACK_MODELS;

    const { parsed } = await callGeminiWithFallback({
      prompt,
      fallback: {
        learner_name: "",
        decision: "Review Required",
        confidence_score: 55,
        evidence_page: "Page reference not identified",
        evidence_and_depth: "The submission could not be confirmed fully at this time.",
        rationale: "A secure judgement could not be confirmed from the available result.",
        action: "Strengthen the evidence and review this criterion again."
      },
      primaryModel,
      fallbackModels
    });

    const result = normaliseGradeResult(parsed, criterion);

    const response = {
      result,
      cached: false
    };

    await setCachedGrade(cacheKey, response);
    return res.json(response);
  } catch (error) {
    console.error("Criterion grading failed:", error);
    return res.status(500).json({
      error: "Request could not be completed."
    });
  }
});

app.post("/api/admin/cache/clear", requireAdmin, async (req, res) => {
  try {
    if (!HAS_SUPABASE) {
      return res.status(503).json({ error: "Cache storage is not configured." });
    }

    const { error } = await supabase.from("criterion_cache").delete().neq("key", "");
    if (error) {
      console.error("Cache clear failed:", error);
      return res.status(500).json({ error: "Request could not be completed." });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Admin cache clear failed:", error);
    return res.status(500).json({ error: "Request could not be completed." });
  }
});

app.use((req, res) => {
  return res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
  console.error("Unhandled server error:", err);
  return res.status(500).json({ error: "Request could not be completed." });
});

app.listen(PORT, () => {
  console.log(`Backend listening on ${PORT}`);
});
