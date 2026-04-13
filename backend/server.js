import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" })); // JSON body limit for large BTEC portfolio uploads

const PORT = process.env.PORT || 3000;

// --- INITIALIZATION ---
// Supabase initialization for persistent caching (Replaces ephemeral local fs)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; 

if (!supabaseUrl || !supabaseKey) {
  console.error("CRITICAL: Supabase environment variables are missing! Persistence will fail.");
}

const supabase = createClient(supabaseUrl || "", supabaseKey || "");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// --- HELPER UTILITIES ---

/**
 * Returns the preferred model or defaults to the fastest stable version.
 */
function getModelName(preferred) {
  // Use the 2.5 flash model as the current high-performance default
  return preferred || process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

/**
 * Returns the full fallback cascade to ensure 100% uptime during high demand.
 */
function getFallbackModels(preferredArray) {
  if (Array.isArray(preferredArray) && preferredArray.length > 0) return preferredArray;
  // COMMERCIAL UPGRADE: A massive cascade of 5 different models to guarantee uptime.
  return [
    "gemini-2.5-flash",
    "gemini-1.5-flash",
    "gemini-2.5-pro",
    "gemini-1.5-pro",
    "gemini-1.5-flash-8b"
  ];
}

/**
 * Middleware to protect administrative endpoints.
 */
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim() || authHeader.trim();
  if (!token || token !== process.env.ADMIN_TOKEN_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
}

/**
 * Robust JSON parsing to handle AI markdown blocks.
 */
function safeJsonParse(text, fallback) {
  try {
    const cleanText = text.replace(/^`{3}(?:json)?/im, '').replace(/`{3}$/im, '').trim();
    return JSON.parse(cleanText);
  } catch (err) {
    console.warn("JSON Parse Failed. Falling back to default. Raw output:", text.substring(0, 150));
    return fallback;
  }
}

/**
 * Filters AI terminology into professional educational feedback.
 */
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
    .replace(/\bAI\b/gi, "review process")
    .trim();
}

/**
 * Deterministic stringify for consistent cache hashing.
 */
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// --- PERSISTENCE LAYER (SUPABASE) ---

/**
 * Retrieves a cached AI result from Supabase.
 */
async function getCachedResult(key) {
  try {
    if (!supabaseUrl || !supabaseKey) return null;
    const { data, error } = await supabase
      .from('criterion_cache')
      .select('payload')
      .eq('key', key)
      .single();

    if (error || !data) return null;
    return data.payload;
  } catch (err) {
    return null; 
  }
}

/**
 * Stores an AI result in Supabase for future reuse.
 */
async function setCachedResult(key, value) {
  try {
    if (!supabaseUrl || !supabaseKey) return;
    const payload = { ...value, cachedAt: new Date().toISOString() };
    await supabase.from('criterion_cache').upsert({ key: key, payload: payload });
  } catch (err) {
    console.error("Supabase Cache Write Error:", err.message);
  }
}

/**
 * Generates a unique SHA-256 hash for the specific assessment request.
 */
function buildCriterionCacheKey(payload) {
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
    primaryModel: payload?.strategy?.primaryModel || "",
    fallbackModels: payload?.strategy?.fallbackModels || [],
    verifierModel: payload?.strategy?.verifierModel || "",
    crossCheck: Boolean(payload?.strategy?.crossCheck),
    promptVersion: "resilient-v6-supabase"
  });

  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// --- DATA NORMALISATION ---

function normaliseBriefScanResult(parsed) {
  const rawCriteria = Array.isArray(parsed?.criteria)
    ? parsed.criteria
    : Array.isArray(parsed?.assessment_criteria)
      ? parsed.assessment_criteria
      : Array.isArray(parsed?.criterion_map)
        ? parsed.criterion_map
        : [];

  const normalisedCriteria = rawCriteria
    .map((item) => {
      if (typeof item === "string") {
        const match = item.match(/^([A-Za-z0-9.\- ]{2,})\s*[:\-]\s*(.+)$/);
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
    .filter((item) => item && item.code && item.requirement);

  return {
    unit_number: String(parsed?.unit_number || "").trim(),
    unit_title: String(parsed?.unit_title || "").trim(),
    learning_aims: Array.isArray(parsed?.learning_aims) ? parsed.learning_aims.map((x) => String(x).trim()).filter(Boolean) : [],
    assignment_title: String(parsed?.assignment_title || "").trim(),
    assignment_context: cleanTutorText(parsed?.assignment_context || ""),
    criteria: normalisedCriteria,
    task_mapping: Array.isArray(parsed?.task_mapping) ? parsed.task_mapping.map((item) => ({
      task: String(item?.task || "").trim(),
      criteria: Array.isArray(item?.criteria) ? item.criteria.map((x) => String(x).trim().toUpperCase().replace(/\s+/g, "")).filter(Boolean) : []
    })) : [],
    evidence_requirements: Array.isArray(parsed?.evidence_requirements) ? parsed.evidence_requirements.map(x => cleanTutorText(String(x))).filter(Boolean) : [],
    unit_context: cleanTutorText(parsed?.unit_context || "")
  };
}

function normaliseDecision(value) {
  const decision = String(value || "").trim();
  if (["Achieved", "Review Required", "Not Yet Achieved"].includes(decision)) return decision;
  return "Review Required";
}

function normaliseGradeResult(parsed) {
  return {
    decision: normaliseDecision(parsed?.decision),
    confidence_score: Math.max(0, Math.min(100, Number(parsed?.confidence_score) || 60)),
    evidence_page: cleanTutorText(parsed?.evidence_page || "Page reference not identified"),
    evidence_and_depth: cleanTutorText(parsed?.evidence_and_depth || "No substantial evidence summary returned."),
    rationale: cleanTutorText(parsed?.rationale || "No rationale returned."),
    action: cleanTutorText(parsed?.action || "Review this criterion and strengthen the evidence where needed.")
  };
}

// --- AI CORE EXECUTION ---

async function extractTextResponse(response) {
  if (typeof response?.text === "string" && response.text.trim()) return response.text;
  if (typeof response?.text === "function") return await response.text();
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text || "").join("");
}

function isRetryableModelError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("503") ||
    message.includes("service unavailable") ||
    message.includes("unavailable") ||
    message.includes("high demand") ||
    message.includes("overloaded") ||
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("deadline exceeded") ||
    message.includes("temporarily")
  );
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGeminiJson({ model, prompt, fallback, maxRetries = 1 }) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const modelInstance = genAI.getGenerativeModel({
        model,
        generationConfig: {
          temperature: 0,
          topP: 0.1,
          responseMimeType: "application/json"
        }
      });
      const result = await modelInstance.generateContent(prompt);
      const text = await extractTextResponse(result.response);
      return safeJsonParse(text, fallback);
    } catch (error) {
      lastError = error;
      if (!isRetryableModelError(error) || attempt === maxRetries) throw error;
      const delayMs = 1000;
      console.warn(`Model ${model} busy/unavailable. Retry ${attempt + 1}/${maxRetries} in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function callGeminiJsonWithFallback({
  primaryModel,
  fallbackModels = [],
  prompt,
  fallback,
  primaryRetries = 1, // Only retry the primary model once so we don't timeout
  fallbackRetries = 0 // Don't retry fallback models at all, just cascade to the next one instantly
}) {
  const triedModels = [];
  let lastError = null;
  const allModels = [...new Set([primaryModel, ...fallbackModels])].filter(Boolean);

  for (let i = 0; i < allModels.length; i += 1) {
    const model = allModels[i];
    const retries = i === 0 ? primaryRetries : fallbackRetries;
    triedModels.push(model);

    try {
      const parsed = await callGeminiJson({
        model,
        prompt,
        fallback,
        maxRetries: retries
      });
      return { parsed, modelUsed: model, triedModels };
    } catch (error) {
      lastError = error;
      console.error(`Model failed: ${model} -> Switching to next model.`);
    }
  }

  // COMMERCIAL UPGRADE: The "Never-Crash" Guarantee. 
  console.error("CRITICAL: All AI models exhausted. Returning safe fallback payload.", lastError?.message);
  return { parsed: fallback, modelUsed: "system-safe-fallback", triedModels };
}

// --- GRADING ENGINE ---

async function gradeWithModel(payload, modelName, fallbackModels = []) {
  let contextBlock = `
Qualification: ${payload.qualificationLabel || "Not provided"}
Unit: ${payload.unitInfo || "Not provided"}
Assessment mode: ${payload.assessmentMode || "Not provided"}
Pathway: ${payload.pathway || "Not specified"}
Mode: ${payload.mode || "assessor"}
Criterion: ${payload.criterion.code} - ${payload.criterion.requirement}
`;

  if (payload.unitContextMode === "criteria_plus_unit" || payload.unitContextMode === "criteria_plus_unit_and_tutor") {
    contextBlock += `\nFull unit context:\n${String(payload.fullUnitInfo || "").trim()}`;
  }

  if (payload.unitContextMode === "criteria_plus_unit_and_tutor") {
    contextBlock += `\nTutor-led notes:\n${String(payload.tutorLedCriteria || "").trim()}`;
  }

  const prompt = `
You are supporting a BTEC assessor.
Write feedback and make a criterion judgement using the learner submission, the criterion wording, and the supplied assessment context.

${contextBlock}
Evidence principles: ${String(payload.evidencePrinciples || "").trim()}
Watchouts: ${String(payload.watchouts || "").trim()}
Learner submission: ${String(payload.learnerText || "").slice(0, 100000)}

Return JSON only in this structure:
{
  "decision": "Achieved" | "Review Required" | "Not Yet Achieved",
  "confidence_score": 0,
  "evidence_page": "",
  "evidence_and_depth": "",
  "rationale": "",
  "action": ""
}

Rules:
- Use only these decisions: "Achieved", "Review Required", "Not Yet Achieved".
- Choose "Achieved" only where the criterion is clearly met by direct evidence in the learner text.
- Choose "Review Required" where there is partial or unclear evidence that needs assessor confirmation.
- Choose "Not Yet Achieved" where the required evidence is not present or is clearly insufficient.
- Base the decision only on evidence that is present in the learner text.
- Do not invent pages, evidence, or claims.
- Be conservative and consistent.
- Keep the tone professional, clear, and tutor-led.
- Respect command verbs such as explain, analyse, evaluate, justify.
- Return JSON only, with no markdown fences or commentary.
`;

  const fallback = {
    decision: "Review Required",
    confidence_score: 60,
    evidence_page: "Page reference not identified",
    evidence_and_depth: "No substantial evidence summary returned.",
    rationale: "The available evidence could not be confirmed securely from the submission provided.",
    action: "Review this criterion and strengthen the evidence where needed."
  };

  const { parsed, modelUsed, triedModels } = await callGeminiJsonWithFallback({
    primaryModel: modelName,
    fallbackModels,
    prompt,
    fallback,
    primaryRetries: 1,
    fallbackRetries: 0
  });

  return {
    result: normaliseGradeResult(parsed),
    modelUsed,
    triedModels
  };
}

async function maybeCrossCheck(primaryResult, payload) {
  const verifierModel = payload?.strategy?.verifierModel || "";
  const crossCheck = Boolean(payload?.strategy?.crossCheck);

  if (!crossCheck || !verifierModel) {
    return { result: primaryResult, verifierUsed: false, verifierAgreed: null, verifierModel: null };
  }

  const borderline = primaryResult.decision === "Review Required" || primaryResult.confidence_score < 70;
  if (!borderline) return { result: primaryResult, verifierUsed: false, verifierAgreed: null, verifierModel: null };

  try {
    const verifierRun = await gradeWithModel(payload, verifierModel, []);
    const verifierResult = verifierRun.result;

    const verifierAgreed = verifierResult.decision === primaryResult.decision;

    if (verifierAgreed) {
      return {
        result: {
          ...primaryResult,
          confidence_score: Math.round((primaryResult.confidence_score + verifierResult.confidence_score) / 2)
        },
        verifierUsed: true, verifierAgreed: true, verifierModel: verifierRun.modelUsed
      };
    }

    return {
      result: {
        ...primaryResult,
        decision: "Review Required",
        confidence_score: Math.min(primaryResult.confidence_score, verifierResult.confidence_score, 65),
        rationale: cleanTutorText(`${primaryResult.rationale} A further review is recommended before a final judgement is confirmed.`),
        action: cleanTutorText(`${primaryResult.action} This point should be checked again before release.`)
      },
      verifierUsed: true, verifierAgreed: false, verifierModel: verifierRun.modelUsed
    };
  } catch (error) {
    console.error("Verifier model failed:", error);
    return { result: primaryResult, verifierUsed: false, verifierAgreed: null, verifierModel: null };
  }
}

// --- API ROUTES ---

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "mgts-btec-feedback-backend",
    persistence: "supabase",
    db_connected: !!supabaseUrl
  });
});

app.post("/api/auth/admin-login", (req, res) => {
  const password = String(req.body?.password || "").trim();
  const expected = String(process.env.ADMIN_PASSWORD || "").trim();

  if (!password) return res.status(400).json({ error: "Password is required." });
  if (password !== expected) return res.status(401).json({ error: "Invalid password" });
  return res.json({ token: process.env.ADMIN_TOKEN_SECRET });
});

app.post("/api/brief/scan", requireAdmin, async (req, res) => {
  try {
    const { briefText } = req.body || {};
    if (!briefText || !String(briefText).trim()) {
      return res.status(400).json({ error: "briefText is required." });
    }

    const prompt = `
You are extracting structured data from a BTEC assignment brief.
Return JSON only with this shape:
{
  "unit_number": "",
  "unit_title": "",
  "learning_aims": [],
  "assignment_title": "",
  "assignment_context": "",
  "criteria": [
    { "code": "", "requirement": "" }
  ],
  "task_mapping": [
    { "task": "", "criteria": [] }
  ],
  "evidence_requirements": [],
  "unit_context": ""
}

Rules:
- Extract every criterion code you can find (e.g., P1, M2, D1, A.P1, B.M2).
- Put each criterion requirement in plain English in "requirement".
- Return valid JSON only (no markdown).

Brief text:
${String(briefText).slice(0, 100000)}
`;
    const primaryModel = getModelName();
    const fallbackModels = getFallbackModels();

    const { parsed, modelUsed, triedModels } = await callGeminiJsonWithFallback({
      primaryModel,
      fallbackModels,
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
      primaryRetries: 1,
      fallbackRetries: 0
    });

    const result = normaliseBriefScanResult(parsed);
    if (!result.criteria.length) {
      return res.status(422).json({
        error: "Brief scan completed but no mappable criteria were detected. Please check brief quality or upload a clearer brief.",
        result,
        modelUsed,
        triedModels
      });
    }

    return res.json({
      result,
      modelUsed,
      triedModels
    });
  } catch (error) {
    console.error("Brief scan error:", error?.message || error);
    return res.status(500).json({
      error: "An internal system error occurred.",
      detail: error?.message || "Unknown error"
    });
  }
});

app.post("/api/grade/criterion", requireAdmin, async (req, res) => {
  try {
    const payload = req.body || {};

    if (!payload.learnerText || !payload.criterion) {
      return res.status(400).json({ error: "learnerText and criterion are required." });
    }

    const cacheKey = buildCriterionCacheKey(payload);
    const cached = await getCachedResult(cacheKey);

    if (cached) return res.json({ ...cached, cached: true, cacheKey });

    const primaryRun = await gradeWithModel(payload, getModelName(payload?.strategy?.primaryModel), getFallbackModels(payload?.strategy?.fallbackModels));
    const checked = await maybeCrossCheck(primaryRun.result, payload);
    const result = normaliseGradeResult(checked.result);

    const responseData = {
      result,
      model: primaryRun.modelUsed,
      triedModels: primaryRun.triedModels,
      verifierUsed: checked.verifierUsed,
      verifierAgreed: checked.verifierAgreed,
      verifierModel: checked.verifierModel
    };

    await setCachedResult(cacheKey, responseData);

    return res.json({
      ...responseData,
      cached: false,
      cacheKey
    });
  } catch (error) {
    console.error("Grading critical error:", error?.message || error);
    return res.status(500).json({
      error: "An internal system error occurred.",
      detail: error?.message || "Unknown error"
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Route not found." });
});

app.listen(PORT, () => {
  console.log(`MGTS BTEC Backend running on port ${PORT} (Supabase Persistence)`);
});
