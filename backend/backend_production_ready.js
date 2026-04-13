import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

const PORT = process.env.PORT || 3000;
const CACHE_DIR = process.env.CACHE_DIR || "./data";
const CACHE_FILE = path.join(CACHE_DIR, "criterion-cache.json");

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

function getModelName(preferred) {
  // Restored to 2.5 as these are the supported models for this API version
  return preferred || process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

function getFallbackModels(preferredArray) {
  if (Array.isArray(preferredArray) && preferredArray.length > 0) return preferredArray;
  // COMMERCIAL UPGRADE: A robust cascade of models using the correct 2.5 generation
  return ["gemini-2.5-flash", "gemini-2.5-pro"];
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
    const cleanText = text.replace(/^`{3}(?:json)?/im, '').replace(/`{3}$/im, '').trim();
    return JSON.parse(cleanText);
  } catch (err) {
    console.warn("JSON Parse Failed. Falling back to default. Raw output:", text.substring(0, 150));
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
    .replace(/\bAI\b/gi, "review process")
    .trim();
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

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
    promptVersion: "resilient-v2"
  });

  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function loadPersistentCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function savePersistentCache(cacheObject) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheObject, null, 2), "utf8");
}

let persistentCache = loadPersistentCache();

function getCachedResult(key) {
  return persistentCache[key] || null;
}

function setCachedResult(key, value) {
  persistentCache[key] = {
    ...value,
    cachedAt: new Date().toISOString()
  };
  savePersistentCache(persistentCache);
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
      ? parsed.criteria.map((item) => ({
          code: String(item?.code || "").trim().toUpperCase().replace(/\s+/g, ""),
          requirement: String(item?.requirement || "").trim()
        })).filter((item) => item.code && item.requirement)
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

async function extractTextResponse(response) {
  if (typeof response?.text === "string" && response.text.trim()) return response.text;
  if (typeof response?.text === "function") {
    const text = await response.text();
    if (text && String(text).trim()) return String(text);
  }
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

function isBusyModelError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("503") ||
    message.includes("service unavailable") ||
    message.includes("high demand") ||
    message.includes("overloaded") ||
    message.includes("429") ||
    message.includes("rate limit")
  );
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGeminiJson({ model, prompt, fallback, maxRetries = 3 }) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await genAI.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0,
          topP: 0.1,
          responseMimeType: "application/json"
        }
      });

      const text = await extractTextResponse(response);
      return safeJsonParse(text, fallback);
    } catch (error) {
      lastError = error;

      if (!isRetryableModelError(error) || attempt === maxRetries) {
        throw error;
      }

      const delayMs = 1500 * Math.pow(2, attempt);
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
  primaryRetries = 3,
  fallbackRetries = 2
}) {
  const triedModels = [];
  let lastError = null;

  // Deduplicate and filter out any empty strings
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
      console.error(`Model failed: ${model}`, error?.message || error);
    }
  }

  // COMMERCIAL UPGRADE: The "Never-Crash" Guarantee. 
  // If every model fails completely, we gracefully return the fallback object so the frontend NEVER gets a 500 error.
  console.error("CRITICAL: All AI models exhausted. Preventing crash by returning safe fallback payload.", lastError?.message);
  return { parsed: fallback, modelUsed: "system-safe-fallback", triedModels };
}

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
    contextBlock += `

Full unit context:
${String(payload.fullUnitInfo || "").trim()}
`;
  }

  if (payload.unitContextMode === "criteria_plus_unit_and_tutor") {
    contextBlock += `

Tutor-led notes:
${String(payload.tutorLedCriteria || "").trim()}
`;
  }

  const prompt = `
You are supporting a BTEC assessor.

Write feedback and make a criterion judgement using the learner submission, the criterion wording, and the supplied assessment context.

${contextBlock}

Evidence principles:
${String(payload.evidencePrinciples || "").trim()}

Watchouts:
${String(payload.watchouts || "").trim()}

Learner submission:
${String(payload.learnerText || "").slice(0, 100000)}

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
- Use only these decisions: "Achieved", "Review Required", "Not Yet Achieved".
- Choose "Achieved" only where the criterion is clearly met by direct evidence in the learner text.
- Choose "Review Required" where there is partial or unclear evidence that needs assessor confirmation.
- Choose "Not Yet Achieved" where the required evidence is not present or is clearly insufficient.
- Base the decision only on evidence that is present in the learner text.
- Do not invent pages, evidence, or claims.
- Be conservative and consistent.
- Do not reward likely intent; reward only what is actually evidenced.
- If the same evidence appears again, make the same judgement.
- Keep the tone professional, clear, and tutor-led.
- Do not mention AI, backend systems, temporary outages, retries, or model limitations in learner-facing fields.
- If evidence is limited or unclear, explain what still needs to be demonstrated in normal assessor language.
- "action" must sound like tutor feedback, not a technical log.
- Respect command verbs such as explain, analyse, evaluate, justify.
- Where unit context or tutor-led notes are provided, use them to make the feedback more assignment-specific and natural.
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
    primaryRetries: 3,
    fallbackRetries: 2
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
  if (!borderline) {
    return { result: primaryResult, verifierUsed: false, verifierAgreed: null, verifierModel: null };
  }

  try {
    const verifierRun = await gradeWithModel(payload, verifierModel, []);
    const verifierResult = verifierRun.result;

    const verifierAgreed =
      verifierResult.decision === primaryResult.decision &&
      Math.abs(verifierResult.confidence_score - primaryResult.confidence_score) <= 20;

    if (verifierAgreed) {
      return {
        result: {
          ...primaryResult,
          confidence_score: Math.round((primaryResult.confidence_score + verifierResult.confidence_score) / 2)
        },
        verifierUsed: true,
        verifierAgreed: true,
        verifierModel: verifierRun.modelUsed || verifierModel
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
      verifierUsed: true,
      verifierAgreed: false,
      verifierModel: verifierRun.modelUsed || verifierModel
    };
  } catch (error) {
    console.error("Verifier model failed:", error);
    return { result: primaryResult, verifierUsed: false, verifierAgreed: null, verifierModel: null };
  }
}

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "mgts-btec-feedback-backend",
    model: getModelName(),
    fallbackModel: getFallbackModels()[0],
    cacheEntries: Object.keys(persistentCache).length,
    promptVersion: "resilient-v2"
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

    console.log("Brief scan request received. Characters:", String(briefText).length);

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

    const emptyBriefFallback = {
      unit_number: "",
      unit_title: "",
      learning_aims: [],
      assignment_title: "",
      assignment_context: "",
      criteria: [],
      task_mapping: [],
      evidence_requirements: [],
      unit_context: ""
    };

    const primaryModel = getModelName();
    const fallbackModels = getFallbackModels();

    const { parsed, modelUsed, triedModels } = await callGeminiJsonWithFallback({
      primaryModel,
      fallbackModels,
      prompt,
      fallback: emptyBriefFallback,
      primaryRetries: 3,
      fallbackRetries: 2
    });

    console.log("Brief scan completed successfully with model:", modelUsed);

    return res.json({
      result: normaliseBriefScanResult(parsed),
      modelUsed,
      triedModels
    });
  } catch (error) {
    // With the new "never-crash" fallback system, we will rarely hit this catch block,
    // ensuring the client never sees a 500 error for AI failures.
    console.error("Brief scan critical system error:", error?.message || error); 
    
    return res.status(500).json({
      error: "An internal system error occurred.",
      detail: error?.message || "Unknown error"
    });
  }
});

app.post("/api/grade/criterion", requireAdmin, async (req, res) => {
  try {
    const payload = req.body || {};

    if (!payload.learnerText || !String(payload.learnerText).trim()) {
      return res.status(400).json({ error: "learnerText is required." });
    }

    if (!payload.criterion || !payload.criterion.code || !payload.criterion.requirement) {
      return res.status(400).json({ error: "criterion with code and requirement is required." });
    }

    const cacheKey = buildCriterionCacheKey(payload);
    const cached = getCachedResult(cacheKey);

    if (cached?.result) {
      return res.json({
        result: cached.result,
        cached: true,
        cacheKey,
        model: cached.model || null,
        verifierUsed: cached.verifierUsed ?? false,
        verifierAgreed: cached.verifierAgreed ?? null,
        triedModels: cached.triedModels || []
      });
    }

    const primaryModel = getModelName(payload?.strategy?.primaryModel);
    const fallbackModels = getFallbackModels(payload?.strategy?.fallbackModels);

    const primaryRun = await gradeWithModel(payload, primaryModel, fallbackModels);
    const checked = await maybeCrossCheck(primaryRun.result, payload);
    const result = normaliseGradeResult(checked.result);

    setCachedResult(cacheKey, {
      result,
      model: primaryRun.modelUsed,
      triedModels: primaryRun.triedModels,
      verifierUsed: checked.verifierUsed,
      verifierAgreed: checked.verifierAgreed,
      verifierModel: checked.verifierModel
    });

    return res.json({
      result,
      cached: false,
      cacheKey,
      model: primaryRun.modelUsed,
      triedModels: primaryRun.triedModels,
      verifierUsed: checked.verifierUsed,
      verifierAgreed: checked.verifierAgreed,
      verifierModel: checked.verifierModel
    });
  } catch (error) {
    console.error("Criterion grading critical system error:", error?.message || error); 

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
  console.log(`MGTS BTEC backend running on port ${PORT}`);
});
