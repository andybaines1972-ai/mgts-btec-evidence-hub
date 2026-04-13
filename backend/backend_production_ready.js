import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" })); // Sufficient limit for large BTEC portfolios

const PORT = process.env.PORT || 3000;

// --- INITIALIZATION ---
// Supabase initialization for persistent caching (Replaces ephemeral local fs)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; 

if (!supabaseUrl || !supabaseKey) {
  console.error("CRITICAL: Supabase environment variables are missing! Persistence will fail.");
}

const supabase = createClient(supabaseUrl || "", supabaseKey || "");

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// --- HELPER UTILITIES ---

/**
 * Returns the preferred model or defaults to the fastest stable version.
 */
function getModelName(preferred) {
  return preferred || process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

/**
 * Returns the full fallback cascade to ensure 100% uptime during high demand.
 */
function getFallbackModels(preferredArray) {
  if (Array.isArray(preferredArray) && preferredArray.length > 0) return preferredArray;
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
    return res.status(403).json({ error: "Unauthorized access detected." });
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
    console.warn("JSON Parse Failed. Using safe fallback.");
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
    promptVersion: "resilient-v3-supabase"
  });

  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// --- DATA NORMALISATION ---

function normaliseBriefScanResult(parsed) {
  return {
    unit_number: String(parsed?.unit_number || "").trim(),
    unit_title: String(parsed?.unit_title || "").trim(),
    learning_aims: Array.isArray(parsed?.learning_aims) ? parsed.learning_aims.map((x) => String(x).trim()).filter(Boolean) : [],
    assignment_title: String(parsed?.assignment_title || "").trim(),
    assignment_context: cleanTutorText(parsed?.assignment_context || ""),
    criteria: Array.isArray(parsed?.criteria) ? parsed.criteria.map((item) => ({
      code: String(item?.code || "").trim().toUpperCase().replace(/\s+/g, ""),
      requirement: String(item?.requirement || "").trim()
    })).filter((item) => item.code && item.requirement) : [],
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
    action: cleanTutorText(parsed?.action || "Review evidence and strengthen submission where needed.")
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
  const message = String(error?.message || "").toLowerCase();
  return message.includes("503") || message.includes("unavailable") || message.includes("429") || message.includes("rate limit") || message.includes("overloaded");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGeminiJson({ model, prompt, fallback, maxRetries = 1 }) {
  let lastError = null;
  const modelInstance = genAI.getGenerativeModel({ 
    model,
    generationConfig: { temperature: 0, topP: 0.1, responseMimeType: "application/json" }
  });

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await modelInstance.generateContent(prompt);
      const text = await extractTextResponse(result.response);
      return safeJsonParse(text, fallback);
    } catch (error) {
      lastError = error;
      if (!isRetryableModelError(error) || attempt === maxRetries) throw error;
      await sleep(1000);
    }
  }
  throw lastError;
}

async function callGeminiJsonWithFallback({
  primaryModel,
  fallbackModels = [],
  prompt,
  fallback,
  primaryRetries = 1,
  fallbackRetries = 0
}) {
  const triedModels = [];
  const allModels = [...new Set([primaryModel, ...fallbackModels])].filter(Boolean);

  for (let i = 0; i < allModels.length; i += 1) {
    const model = allModels[i];
    triedModels.push(model);

    try {
      const parsed = await callGeminiJson({
        model,
        prompt,
        fallback,
        maxRetries: i === 0 ? primaryRetries : fallbackRetries
      });
      return { parsed, modelUsed: model, triedModels };
    } catch (error) {
      console.error(`Model failed: ${model} -> cascading.`);
    }
  }
  return { parsed: fallback, modelUsed: "system-safe-fallback", triedModels };
}

// --- GRADING ENGINE ---

async function gradeWithModel(payload, modelName, fallbackModels = []) {
  let contextBlock = `
Qualification: ${payload.qualificationLabel || "BTEC Vocational"}
Unit: ${payload.unitInfo || "Unit Context"}
Assessment mode: ${payload.assessmentMode || "Standard Assessment"}
Pathway: ${payload.pathway || "Not specified"}
Criterion: ${payload.criterion.code} - ${payload.criterion.requirement}
`;

  if (payload.unitContextMode !== "criteria_only") {
    contextBlock += `\nFull Context: ${payload.fullUnitInfo || ""}\nTutor Notes: ${payload.tutorLedCriteria || ""}`;
  }

  const prompt = `
You are a BTEC Assessor. Assess learner submission text against specific criteria.
${contextBlock}
Evidence principles: ${payload.evidencePrinciples || "Standard vocational evidence standards"}
Watchouts: ${payload.watchouts || "None specified"}
Learner submission: ${String(payload.learnerText || "").slice(0, 100000)}

Return JSON:
{
  "decision": "Achieved" | "Review Required" | "Not Yet Achieved",
  "confidence_score": (0-100),
  "evidence_page": "string",
  "evidence_and_depth": "string",
  "rationale": "string",
  "action": "tutor feedback to learner"
}
`;

  const fallback = { decision: "Review Required", confidence_score: 60 };
  const { parsed, modelUsed, triedModels } = await callGeminiJsonWithFallback({
    primaryModel: modelName,
    fallbackModels,
    prompt,
    fallback,
    primaryRetries: 1,
    fallbackRetries: 0
  });

  return { result: normaliseGradeResult(parsed), modelUsed, triedModels };
}

async function maybeCrossCheck(primaryResult, payload) {
  const verifierModel = payload?.strategy?.verifierModel || "";
  const crossCheck = Boolean(payload?.strategy?.crossCheck);

  if (!crossCheck || !verifierModel) {
    return { result: primaryResult, verifierUsed: false, verifierAgreed: null, verifierModel: null };
  }

  const borderline = primaryResult.decision === "Review Required" || primaryResult.confidence_score < 75;
  if (!borderline) return { result: primaryResult, verifierUsed: false, verifierAgreed: null, verifierModel: null };

  try {
    const verifierRun = await gradeWithModel(payload, verifierModel, []);
    const verifierAgreed = verifierRun.result.decision === primaryResult.decision;

    if (verifierAgreed) {
      return {
        result: {
          ...primaryResult,
          confidence_score: Math.round((primaryResult.confidence_score + verifierRun.result.confidence_score) / 2)
        },
        verifierUsed: true, verifierAgreed: true, verifierModel: verifierRun.modelUsed
      };
    }

    return {
      result: {
        ...primaryResult,
        decision: "Review Required",
        confidence_score: Math.min(primaryResult.confidence_score, verifierRun.result.confidence_score, 65),
        rationale: cleanTutorText(`${primaryResult.rationale} A cross-check review suggested a more conservative judgement is required before final sign-off.`)
      },
      verifierUsed: true, verifierAgreed: false, verifierModel: verifierRun.modelUsed
    };
  } catch (error) {
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
  if (req.body?.password === process.env.ADMIN_PASSWORD) {
    return res.json({ token: process.env.ADMIN_TOKEN_SECRET });
  }
  res.status(401).json({ error: "Invalid password credentials." });
});

app.post("/api/brief/scan", requireAdmin, async (req, res) => {
  try {
    const { briefText } = req.body || {};
    const prompt = `Analyse BTEC Brief: ${briefText}. Return structured JSON unit details.`;
    const { parsed, modelUsed } = await callGeminiJsonWithFallback({
      primaryModel: getModelName(),
      fallbackModels: getFallbackModels(),
      prompt,
      fallback: {}
    });
    return res.json({ result: normaliseBriefScanResult(parsed), modelUsed });
  } catch (error) {
    res.status(500).json({ error: "Brief scan execution failed." });
  }
});

app.post("/api/grade/criterion", requireAdmin, async (req, res) => {
  try {
    const payload = req.body || {};
    const cacheKey = buildCriterionCacheKey(payload);

    // 1. Check Database Cache
    const cached = await getCachedResult(cacheKey);
    if (cached) return res.json({ ...cached, cached: true, cacheKey });

    // 2. Perform Primary Grading
    const primary = await gradeWithModel(payload, getModelName(payload?.strategy?.primaryModel), getFallbackModels(payload?.strategy?.fallbackModels));
    
    // 3. Optional Cross-Check Verification
    const checked = await maybeCrossCheck(primary.result, payload);
    
    const responseData = {
      result: normaliseGradeResult(checked.result),
      model: primary.modelUsed,
      triedModels: primary.triedModels,
      verifierUsed: checked.verifierUsed,
      verifierAgreed: checked.verifierAgreed,
      verifierModel: checked.verifierModel
    };

    // 4. Save to Cache (Background)
    setCachedResult(cacheKey, responseData);

    return res.json({ ...responseData, cached: false, cacheKey });
  } catch (error) {
    console.error("Internal Assessment Error:", error);
    res.status(500).json({ error: "Assessment processing failed." });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found." });
});

app.listen(PORT, () => console.log(`MGTS BTEC Backend active on port ${PORT}`));import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" })); // Sufficient limit for large BTEC portfolios

const PORT = process.env.PORT || 3000;

// --- INITIALIZATION ---
// Supabase initialization for persistent caching (Replaces ephemeral local fs)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; 

if (!supabaseUrl || !supabaseKey) {
  console.error("CRITICAL: Supabase environment variables are missing! Persistence will fail.");
}

const supabase = createClient(supabaseUrl || "", supabaseKey || "");

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// --- HELPER UTILITIES ---

/**
 * Returns the preferred model or defaults to the fastest stable version.
 */
function getModelName(preferred) {
  return preferred || process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

/**
 * Returns the full fallback cascade to ensure 100% uptime during high demand.
 */
function getFallbackModels(preferredArray) {
  if (Array.isArray(preferredArray) && preferredArray.length > 0) return preferredArray;
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
    return res.status(403).json({ error: "Unauthorized access detected." });
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
    console.warn("JSON Parse Failed. Using safe fallback.");
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
    promptVersion: "resilient-v3-supabase"
  });

  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// --- DATA NORMALISATION ---

function normaliseBriefScanResult(parsed) {
  return {
    unit_number: String(parsed?.unit_number || "").trim(),
    unit_title: String(parsed?.unit_title || "").trim(),
    learning_aims: Array.isArray(parsed?.learning_aims) ? parsed.learning_aims.map((x) => String(x).trim()).filter(Boolean) : [],
    assignment_title: String(parsed?.assignment_title || "").trim(),
    assignment_context: cleanTutorText(parsed?.assignment_context || ""),
    criteria: Array.isArray(parsed?.criteria) ? parsed.criteria.map((item) => ({
      code: String(item?.code || "").trim().toUpperCase().replace(/\s+/g, ""),
      requirement: String(item?.requirement || "").trim()
    })).filter((item) => item.code && item.requirement) : [],
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
    action: cleanTutorText(parsed?.action || "Review evidence and strengthen submission where needed.")
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
  const message = String(error?.message || "").toLowerCase();
  return message.includes("503") || message.includes("unavailable") || message.includes("429") || message.includes("rate limit") || message.includes("overloaded");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGeminiJson({ model, prompt, fallback, maxRetries = 1 }) {
  let lastError = null;
  const modelInstance = genAI.getGenerativeModel({ 
    model,
    generationConfig: { temperature: 0, topP: 0.1, responseMimeType: "application/json" }
  });

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await modelInstance.generateContent(prompt);
      const text = await extractTextResponse(result.response);
      return safeJsonParse(text, fallback);
    } catch (error) {
      lastError = error;
      if (!isRetryableModelError(error) || attempt === maxRetries) throw error;
      await sleep(1000);
    }
  }
  throw lastError;
}

async function callGeminiJsonWithFallback({
  primaryModel,
  fallbackModels = [],
  prompt,
  fallback,
  primaryRetries = 1,
  fallbackRetries = 0
}) {
  const triedModels = [];
  const allModels = [...new Set([primaryModel, ...fallbackModels])].filter(Boolean);

  for (let i = 0; i < allModels.length; i += 1) {
    const model = allModels[i];
    triedModels.push(model);

    try {
      const parsed = await callGeminiJson({
        model,
        prompt,
        fallback,
        maxRetries: i === 0 ? primaryRetries : fallbackRetries
      });
      return { parsed, modelUsed: model, triedModels };
    } catch (error) {
      console.error(`Model failed: ${model} -> cascading.`);
    }
  }
  return { parsed: fallback, modelUsed: "system-safe-fallback", triedModels };
}

// --- GRADING ENGINE ---

async function gradeWithModel(payload, modelName, fallbackModels = []) {
  let contextBlock = `
Qualification: ${payload.qualificationLabel || "BTEC Vocational"}
Unit: ${payload.unitInfo || "Unit Context"}
Assessment mode: ${payload.assessmentMode || "Standard Assessment"}
Pathway: ${payload.pathway || "Not specified"}
Criterion: ${payload.criterion.code} - ${payload.criterion.requirement}
`;

  if (payload.unitContextMode !== "criteria_only") {
    contextBlock += `\nFull Context: ${payload.fullUnitInfo || ""}\nTutor Notes: ${payload.tutorLedCriteria || ""}`;
  }

  const prompt = `
You are a BTEC Assessor. Assess learner submission text against specific criteria.
${contextBlock}
Evidence principles: ${payload.evidencePrinciples || "Standard vocational evidence standards"}
Watchouts: ${payload.watchouts || "None specified"}
Learner submission: ${String(payload.learnerText || "").slice(0, 100000)}

Return JSON:
{
  "decision": "Achieved" | "Review Required" | "Not Yet Achieved",
  "confidence_score": (0-100),
  "evidence_page": "string",
  "evidence_and_depth": "string",
  "rationale": "string",
  "action": "tutor feedback to learner"
}
`;

  const fallback = { decision: "Review Required", confidence_score: 60 };
  const { parsed, modelUsed, triedModels } = await callGeminiJsonWithFallback({
    primaryModel: modelName,
    fallbackModels,
    prompt,
    fallback,
    primaryRetries: 1,
    fallbackRetries: 0
  });

  return { result: normaliseGradeResult(parsed), modelUsed, triedModels };
}

async function maybeCrossCheck(primaryResult, payload) {
  const verifierModel = payload?.strategy?.verifierModel || "";
  const crossCheck = Boolean(payload?.strategy?.crossCheck);

  if (!crossCheck || !verifierModel) {
    return { result: primaryResult, verifierUsed: false, verifierAgreed: null, verifierModel: null };
  }

  const borderline = primaryResult.decision === "Review Required" || primaryResult.confidence_score < 75;
  if (!borderline) return { result: primaryResult, verifierUsed: false, verifierAgreed: null, verifierModel: null };

  try {
    const verifierRun = await gradeWithModel(payload, verifierModel, []);
    const verifierAgreed = verifierRun.result.decision === primaryResult.decision;

    if (verifierAgreed) {
      return {
        result: {
          ...primaryResult,
          confidence_score: Math.round((primaryResult.confidence_score + verifierRun.result.confidence_score) / 2)
        },
        verifierUsed: true, verifierAgreed: true, verifierModel: verifierRun.modelUsed
      };
    }

    return {
      result: {
        ...primaryResult,
        decision: "Review Required",
        confidence_score: Math.min(primaryResult.confidence_score, verifierRun.result.confidence_score, 65),
        rationale: cleanTutorText(`${primaryResult.rationale} A cross-check review suggested a more conservative judgement is required before final sign-off.`)
      },
      verifierUsed: true, verifierAgreed: false, verifierModel: verifierRun.modelUsed
    };
  } catch (error) {
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
  if (req.body?.password === process.env.ADMIN_PASSWORD) {
    return res.json({ token: process.env.ADMIN_TOKEN_SECRET });
  }
  res.status(401).json({ error: "Invalid password credentials." });
});

app.post("/api/brief/scan", requireAdmin, async (req, res) => {
  try {
    const { briefText } = req.body || {};
    const prompt = `Analyse BTEC Brief: ${briefText}. Return structured JSON unit details.`;
    const { parsed, modelUsed } = await callGeminiJsonWithFallback({
      primaryModel: getModelName(),
      fallbackModels: getFallbackModels(),
      prompt,
      fallback: {}
    });
    return res.json({ result: normaliseBriefScanResult(parsed), modelUsed });
  } catch (error) {
    res.status(500).json({ error: "Brief scan execution failed." });
  }
});

app.post("/api/grade/criterion", requireAdmin, async (req, res) => {
  try {
    const payload = req.body || {};
    const cacheKey = buildCriterionCacheKey(payload);

    // 1. Check Database Cache
    const cached = await getCachedResult(cacheKey);
    if (cached) return res.json({ ...cached, cached: true, cacheKey });

    // 2. Perform Primary Grading
    const primary = await gradeWithModel(payload, getModelName(payload?.strategy?.primaryModel), getFallbackModels(payload?.strategy?.fallbackModels));
    
    // 3. Optional Cross-Check Verification
    const checked = await maybeCrossCheck(primary.result, payload);
    
    const responseData = {
      result: normaliseGradeResult(checked.result),
      model: primary.modelUsed,
      triedModels: primary.triedModels,
      verifierUsed: checked.verifierUsed,
      verifierAgreed: checked.verifierAgreed,
      verifierModel: checked.verifierModel
    };

    // 4. Save to Cache (Background)
    setCachedResult(cacheKey, responseData);

    return res.json({ ...responseData, cached: false, cacheKey });
  } catch (error) {
    console.error("Internal Assessment Error:", error);
    res.status(500).json({ error: "Assessment processing failed." });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found." });
});

app.listen(PORT, () => console.log(`MGTS BTEC Backend active on port ${import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" })); // Sufficient limit for large BTEC portfolios

const PORT = process.env.PORT || 3000;

// --- INITIALIZATION ---
// Supabase initialization for persistent caching (Replaces ephemeral local fs)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; 

if (!supabaseUrl || !supabaseKey) {
  console.error("CRITICAL: Supabase environment variables are missing! Persistence will fail.");
}

const supabase = createClient(supabaseUrl || "", supabaseKey || "");

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// --- HELPER UTILITIES ---

/**
 * Returns the preferred model or defaults to the fastest stable version.
 */
function getModelName(preferred) {
  return preferred || process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

/**
 * Returns the full fallback cascade to ensure 100% uptime during high demand.
 */
function getFallbackModels(preferredArray) {
  if (Array.isArray(preferredArray) && preferredArray.length > 0) return preferredArray;
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
    return res.status(403).json({ error: "Unauthorized access detected." });
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
    console.warn("JSON Parse Failed. Using safe fallback.");
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
    promptVersion: "resilient-v3-supabase"
  });

  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// --- DATA NORMALISATION ---

function normaliseBriefScanResult(parsed) {
  return {
    unit_number: String(parsed?.unit_number || "").trim(),
    unit_title: String(parsed?.unit_title || "").trim(),
    learning_aims: Array.isArray(parsed?.learning_aims) ? parsed.learning_aims.map((x) => String(x).trim()).filter(Boolean) : [],
    assignment_title: String(parsed?.assignment_title || "").trim(),
    assignment_context: cleanTutorText(parsed?.assignment_context || ""),
    criteria: Array.isArray(parsed?.criteria) ? parsed.criteria.map((item) => ({
      code: String(item?.code || "").trim().toUpperCase().replace(/\s+/g, ""),
      requirement: String(item?.requirement || "").trim()
    })).filter((item) => item.code && item.requirement) : [],
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
    action: cleanTutorText(parsed?.action || "Review evidence and strengthen submission where needed.")
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
  const message = String(error?.message || "").toLowerCase();
  return message.includes("503") || message.includes("unavailable") || message.includes("429") || message.includes("rate limit") || message.includes("overloaded");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGeminiJson({ model, prompt, fallback, maxRetries = 1 }) {
  let lastError = null;
  const modelInstance = genAI.getGenerativeModel({ 
    model,
    generationConfig: { temperature: 0, topP: 0.1, responseMimeType: "application/json" }
  });

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await modelInstance.generateContent(prompt);
      const text = await extractTextResponse(result.response);
      return safeJsonParse(text, fallback);
    } catch (error) {
      lastError = error;
      if (!isRetryableModelError(error) || attempt === maxRetries) throw error;
      await sleep(1000);
    }
  }
  throw lastError;
}

async function callGeminiJsonWithFallback({
  primaryModel,
  fallbackModels = [],
  prompt,
  fallback,
  primaryRetries = 1,
  fallbackRetries = 0
}) {
  const triedModels = [];
  const allModels = [...new Set([primaryModel, ...fallbackModels])].filter(Boolean);

  for (let i = 0; i < allModels.length; i += 1) {
    const model = allModels[i];
    triedModels.push(model);

    try {
      const parsed = await callGeminiJson({
        model,
        prompt,
        fallback,
        maxRetries: i === 0 ? primaryRetries : fallbackRetries
      });
      return { parsed, modelUsed: model, triedModels };
    } catch (error) {
      console.error(`Model failed: ${model} -> cascading.`);
    }
  }
  return { parsed: fallback, modelUsed: "system-safe-fallback", triedModels };
}

// --- GRADING ENGINE ---

async function gradeWithModel(payload, modelName, fallbackModels = []) {
  let contextBlock = `
Qualification: ${payload.qualificationLabel || "BTEC Vocational"}
Unit: ${payload.unitInfo || "Unit Context"}
Assessment mode: ${payload.assessmentMode || "Standard Assessment"}
Pathway: ${payload.pathway || "Not specified"}
Criterion: ${payload.criterion.code} - ${payload.criterion.requirement}
`;

  if (payload.unitContextMode !== "criteria_only") {
    contextBlock += `\nFull Context: ${payload.fullUnitInfo || ""}\nTutor Notes: ${payload.tutorLedCriteria || ""}`;
  }

  const prompt = `
You are a BTEC Assessor. Assess learner submission text against specific criteria.
${contextBlock}
Evidence principles: ${payload.evidencePrinciples || "Standard vocational evidence standards"}
Watchouts: ${payload.watchouts || "None specified"}
Learner submission: ${String(payload.learnerText || "").slice(0, 100000)}

Return JSON:
{
  "decision": "Achieved" | "Review Required" | "Not Yet Achieved",
  "confidence_score": (0-100),
  "evidence_page": "string",
  "evidence_and_depth": "string",
  "rationale": "string",
  "action": "tutor feedback to learner"
}
`;

  const fallback = { decision: "Review Required", confidence_score: 60 };
  const { parsed, modelUsed, triedModels } = await callGeminiJsonWithFallback({
    primaryModel: modelName,
    fallbackModels,
    prompt,
    fallback,
    primaryRetries: 1,
    fallbackRetries: 0
  });

  return { result: normaliseGradeResult(parsed), modelUsed, triedModels };
}

async function maybeCrossCheck(primaryResult, payload) {
  const verifierModel = payload?.strategy?.verifierModel || "";
  const crossCheck = Boolean(payload?.strategy?.crossCheck);

  if (!crossCheck || !verifierModel) {
    return { result: primaryResult, verifierUsed: false, verifierAgreed: null, verifierModel: null };
  }

  const borderline = primaryResult.decision === "Review Required" || primaryResult.confidence_score < 75;
  if (!borderline) return { result: primaryResult, verifierUsed: false, verifierAgreed: null, verifierModel: null };

  try {
    const verifierRun = await gradeWithModel(payload, verifierModel, []);
    const verifierAgreed = verifierRun.result.decision === primaryResult.decision;

    if (verifierAgreed) {
      return {
        result: {
          ...primaryResult,
          confidence_score: Math.round((primaryResult.confidence_score + verifierRun.result.confidence_score) / 2)
        },
        verifierUsed: true, verifierAgreed: true, verifierModel: verifierRun.modelUsed
      };
    }

    return {
      result: {
        ...primaryResult,
        decision: "Review Required",
        confidence_score: Math.min(primaryResult.confidence_score, verifierRun.result.confidence_score, 65),
        rationale: cleanTutorText(`${primaryResult.rationale} A cross-check review suggested a more conservative judgement is required before final sign-off.`)
      },
      verifierUsed: true, verifierAgreed: false, verifierModel: verifierRun.modelUsed
    };
  } catch (error) {
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
  if (req.body?.password === process.env.ADMIN_PASSWORD) {
    return res.json({ token: process.env.ADMIN_TOKEN_SECRET });
  }
  res.status(401).json({ error: "Invalid password credentials." });
});

app.post("/api/brief/scan", requireAdmin, async (req, res) => {
  try {
    const { briefText } = req.body || {};
    const prompt = `Analyse BTEC Brief: ${briefText}. Return structured JSON unit details.`;
    const { parsed, modelUsed } = await callGeminiJsonWithFallback({
      primaryModel: getModelName(),
      fallbackModels: getFallbackModels(),
      prompt,
      fallback: {}
    });
    return res.json({ result: normaliseBriefScanResult(parsed), modelUsed });
  } catch (error) {
    res.status(500).json({ error: "Brief scan execution failed." });
  }
});

app.post("/api/grade/criterion", requireAdmin, async (req, res) => {
  try {
    const payload = req.body || {};
    const cacheKey = buildCriterionCacheKey(payload);

    // 1. Check Database Cache
    const cached = await getCachedResult(cacheKey);
    if (cached) return res.json({ ...cached, cached: true, cacheKey });

    // 2. Perform Primary Grading
    const primary = await gradeWithModel(payload, getModelName(payload?.strategy?.primaryModel), getFallbackModels(payload?.strategy?.fallbackModels));
    
    // 3. Optional Cross-Check Verification
    const checked = await maybeCrossCheck(primary.result, payload);
    
    const responseData = {
      result: normaliseGradeResult(checked.result),
      model: primary.modelUsed,
      triedModels: primary.triedModels,
      verifierUsed: checked.verifierUsed,
      verifierAgreed: checked.verifierAgreed,
      verifierModel: checked.verifierModel
    };

    // 4. Save to Cache (Background)
    setCachedResult(cacheKey, responseData);

    return res.json({ ...responseData, cached: false, cacheKey });
  } catch (error) {
    console.error("Internal Assessment Error:", error);
    res.status(500).json({ error: "Assessment processing failed." });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found." });
});

app.listen(PORT, () => console.log(`MGTS BTEC Backend active on port ${PORT}`));
