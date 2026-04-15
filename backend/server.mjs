import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || "").trim();
const FRONTEND_ORIGIN = String(process.env.FRONTEND_ORIGIN || "").trim();

const DEFAULT_PRIMARY_MODEL = String(
  process.env.GEMINI_MODEL || "gemini-2.5-flash"
).trim();

const DEFAULT_FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-1.5-pro"
];

const SYSTEM_CONFIG = {
  logoUrl: "https://www.mgts.co.uk/wp-content/themes/mgts/images/svg/logo.svg",
  confidenceHighThreshold: 90,
  confidenceMediumThreshold: 75
};

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const HAS_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

const supabase = HAS_SUPABASE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

const app = express();

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (!FRONTEND_ORIGIN) return callback(null, true);
    if (origin === FRONTEND_ORIGIN) return callback(null, true);
    return callback(new Error("CORS blocked"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false
}));

app.use(express.json({ limit: "25mb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  next();
});

async function getRequestUser(req) {
  if (!HAS_SUPABASE) return null;

  const authHeader = String(req.headers.authorization || "").trim();
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) return null;

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error) return null;
    return data?.user || null;
  } catch {
    return null;
  }
}

function cleanTutorText(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/backend/gi, "system")
    .replace(/\bAPI\b/gi, "service")
    .replace(/\bAI\b/gi, "review process")
    .trim();
}

function normalizeCriterionCode(code = "") {
  return String(code).trim().toUpperCase().replace(/\s+/g, "");
}

function criterionSortValue(code = "") {
  const normalized = normalizeCriterionCode(code);
  const match = normalized.match(/^([PMD])(\d+)$/);
  if (!match) return [9, Number.MAX_SAFE_INTEGER, normalized];
  const order = { P: 1, M: 2, D: 3 };
  return [order[match[1]], Number(match[2]), normalized];
}

function sortCriteria(criteria) {
  return [...criteria].sort((a, b) => {
    const [aOrder, aNum, aRaw] = criterionSortValue(a.code);
    const [bOrder, bNum, bRaw] = criterionSortValue(b.code);
    if (aOrder !== bOrder) return aOrder - bOrder;
    if (aNum !== bNum) return aNum - bNum;
    return aRaw.localeCompare(bRaw);
  });
}

function getDefaultRecordControl() {
  return {
    recordStatus: "Draft",
    assessorSignedOffBy: "",
    assessorSignedOffAt: "",
    assessorInternalNotes: "",
    ivRequired: false,
    ivStartedAt: "",
    ivReviewerName: "",
    ivDecision: "",
    ivDecisionAt: "",
    ivInternalNotes: "",
    releasedAt: "",
    releasedBy: ""
  };
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
    version: "server-mjs-clean-2026-04-15"
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

function getCriterionKeywordHits(requirementText = "", responseText = "") {
  const stopWords = new Set([
    "the","and","for","with","that","this","from","through","into","your","their","have",
    "has","been","being","were","will","shall","about","each","them","they","then",
    "when","what","which","where","while","using","used","use","make","made","show","shows"
  ]);

  const keywords = String(requirementText)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => word.length > 3 && !stopWords.has(word));

  const uniqueKeywords = [...new Set(keywords)];
  const response = String(responseText).toLowerCase();

  return uniqueKeywords.reduce((count, word) => count + (response.includes(word) ? 1 : 0), 0);
}

function deriveConfidenceScore(parsed, criterion, mode) {
  const evidencePage = String(parsed.evidence_page || "").trim();
  const evidenceAndDepth = String(parsed.evidence_and_depth || "").trim();
  const rationale = String(parsed.rationale || "").trim();
  const action = String(parsed.action || "").trim();
  const decision = String(parsed.decision || "").trim();
  const requirement = String(criterion?.requirement || "").trim();

  let score = 0;

  if (evidencePage && !/page reference not identified/i.test(evidencePage)) {
    if (/appendix|page\s+\d+/i.test(evidencePage)) score += 20;
    else score += 12;
  }

  if (evidenceAndDepth.length >= 700) score += 28;
  else if (evidenceAndDepth.length >= 400) score += 22;
  else if (evidenceAndDepth.length >= 180) score += 14;
  else if (evidenceAndDepth.length >= 80) score += 8;

  if (rationale.length >= 420) score += 24;
  else if (rationale.length >= 220) score += 18;
  else if (rationale.length >= 100) score += 10;
  else if (rationale.length >= 40) score += 5;

  const hits = getCriterionKeywordHits(requirement, `${evidenceAndDepth} ${rationale}`);
  if (hits >= 5) score += 18;
  else if (hits >= 3) score += 12;
  else if (hits >= 1) score += 6;

  const uncertaintyFlags = [
    "page reference not identified",
    "could not be confirmed",
    "not fully evidenced",
    "review required",
    "unclear",
    "insufficient",
    "not identified",
    "secure judgement could not be confirmed"
  ];

  const combined = `${evidencePage} ${evidenceAndDepth} ${rationale} ${action} ${decision}`.toLowerCase();
  const penaltyCount = uncertaintyFlags.filter((flag) => combined.includes(flag)).length;
  score -= penaltyCount * 12;

  if (mode === "assessor") {
    if (/^achieved$/i.test(decision)) score += 8;
    if (/^review required$/i.test(decision)) score -= 2;
    if (/^not yet achieved$/i.test(decision)) score -= 6;
  } else {
    if (/strong evidence/i.test(decision)) score += 6;
    if (/needs attention/i.test(decision)) score -= 6;
  }

  return Math.max(20, Math.min(98, Math.round(score)));
}

function getConfidenceBand(score) {
  if (score >= SYSTEM_CONFIG.confidenceHighThreshold) return "high";
  if (score >= SYSTEM_CONFIG.confidenceMediumThreshold) return "medium";
  return "low";
}

function getDefaultFinalStatus(mode, confidenceScore) {
  const band = getConfidenceBand(Number(confidenceScore) || 0);

  if (mode === "student") {
    if (band === "high") return "Strong evidence";
    if (band === "medium") return "Some evidence";
    return "Needs attention";
  }

  if (confidenceScore >= 88) return "Achieved";
  if (confidenceScore >= 70) return "Review Required";
  return "Not Yet Achieved";
}

function buildAlwaysPresentNextSteps({ mode, criterion, finalStatus, action }) {
  const code = String(criterion?.code || "").trim().toUpperCase();
  const requirement = String(criterion?.requirement || "").trim();
  const existingAction = cleanTutorText(action || "");

  if (mode === "student") {
    if (finalStatus === "Needs attention" || finalStatus === "Some evidence") {
      return existingAction || `Strengthen ${code} by making your evidence more explicit, using direct explanation linked to "${requirement}", and signposting clearly where this appears in your work.`;
    }
    return `Before submission, strengthen ${code} further by adding clearer explanation, sharper justification, and more direct links to the wording of "${requirement}".`;
  }

  if (finalStatus === "Not Yet Achieved" || finalStatus === "Review Required") {
    return existingAction || `Return to ${code} and add direct evidence that explicitly addresses "${requirement}". Strengthen signposting, page references, and explanation so the evidence meets the criterion securely.`;
  }

  if (code.startsWith("P")) {
    return "To strengthen this further, develop the explanation with more evaluative commentary, clearer justification for decisions made, and stronger links to higher-grade performance where relevant.";
  }

  if (code.startsWith("M")) {
    return "To push this further, deepen the analysis, compare alternatives more explicitly, and make the justification for the chosen approach more critical and precise.";
  }

  if (code.startsWith("D")) {
    return "To extend this high-level response even further, add broader professional reflection, benchmark against recognised industry practice, and include more forward-looking recommendations.";
  }

  return "Continue improving this area by sharpening the evidence trail, using explicit references, and adding stronger evaluative commentary.";
}

function buildTutorLedSummary(audit) {
  const achieved = audit.filter((i) => (i.finalStatus || i.status) === "Achieved");
  const notYet = audit.filter((i) => (i.finalStatus || i.status) === "Not Yet Achieved");
  const review = audit.filter((i) => (i.finalStatus || i.status) === "Review Required");
  const strong = achieved.map((i) => i.id).slice(0, 3).join(", ");
  const gaps = [...notYet, ...review].map((i) => i.id).slice(0, 3).join(", ");
  let summary = "";

  if (achieved.length) {
    summary += strong
      ? `You have produced a clear and generally well-structured submission with secure coverage in ${strong}. `
      : "You have produced a clear and generally well-structured submission with secure coverage across the assessed criteria. ";
  } else {
    summary += "Your submission shows some relevant understanding, but key areas still need further development. ";
  }

  if (notYet.length || review.length) {
    summary += `There are areas where the evidence could be strengthened, particularly in ${gaps}. `;
  }

  summary += "To improve the work further, focus on the command verbs in each criterion and make sure your explanation, analysis, or justification is shown clearly in the writing itself.";
  return cleanTutorText(summary);
}

function buildStudentSummary(audit) {
  const strong = audit.filter((i) => (i.finalStatus || i.status) === "Strong evidence").map((i) => i.id).slice(0, 3).join(", ");
  const partial = audit.filter((i) => (i.finalStatus || i.status) === "Some evidence").map((i) => i.id).slice(0, 3).join(", ");
  const needs = audit.filter((i) => (i.finalStatus || i.status) === "Needs attention").map((i) => i.id).slice(0, 3).join(", ");
  let summary = "";

  if (strong) summary += `Your draft appears to cover ${strong} with reasonably strong evidence. `;
  else summary += "Your draft shows some early coverage, but the criteria do not yet look fully secure. ";

  if (partial) summary += `Some areas, including ${partial}, would benefit from further development. `;
  if (needs) summary += `Before submitting, pay close attention to ${needs} and make sure your evidence is clear, specific, and directly linked to the criterion wording. `;

  return cleanTutorText(summary);
}

function buildImprovementGuide(audit, mode) {
  const items = audit.filter((i) => !["Achieved", "Strong evidence"].includes(i.finalStatus || i.status)).slice(0, 4);

  if (!items.length) {
    return mode === "student"
      ? "Your work is generally in a strong position. Before submitting, take a final pass to ensure clarity, structure, and direct alignment to each criterion."
      : "The work currently meets the expected standard overall. Apply final assessor checks before confirming outcomes.";
  }

  return items.map((i) => `${i.id}: ${cleanTutorText(i.action || "")}`).join("\n\n");
}

function buildAssessorGrade(audit) {
  const getStatus = (item) => item.finalStatus || item.status;

  const passCriteria = audit.filter((i) => i.id.startsWith("P"));
  const meritCriteria = audit.filter((i) => i.id.startsWith("M"));
  const distinctionCriteria = audit.filter((i) => i.id.startsWith("D"));

  const anyNotAchieved = (items) => items.some((i) => getStatus(i) === "Not Yet Achieved");
  const anyReviewRequired = (items) => items.some((i) => getStatus(i) === "Review Required");
  const allAchieved = (items) => items.length > 0 && items.every((i) => getStatus(i) === "Achieved");

  if (passCriteria.length && anyNotAchieved(passCriteria)) return "Referral";
  if (passCriteria.length && anyReviewRequired(passCriteria)) return "Pass Pending Review";
  if (distinctionCriteria.length && allAchieved(passCriteria) && allAchieved(meritCriteria) && allAchieved(distinctionCriteria)) return "Distinction";
  if (meritCriteria.length && allAchieved(passCriteria) && allAchieved(meritCriteria)) return "Merit";
  if (passCriteria.length && allAchieved(passCriteria)) return "Pass";

  return "Referral";
}

function buildStudentGrade() {
  return "Pre-submission guidance";
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

function normaliseGradeResult(parsed = {}) {
  const decision = toDecision(parsed.decision);
  const confidence = Math.max(0, Math.min(100, Number(parsed.confidence_score) || 60));

  return {
    decision,
    confidence_score: confidence,
    evidence_page: cleanTutorText(parsed.evidence_page || "Page reference not identified"),
    evidence_and_depth: cleanTutorText(parsed.evidence_and_depth || "No substantial evidence summary returned."),
    rationale: cleanTutorText(parsed.rationale || "No rationale returned."),
    action: cleanTutorText(parsed.action || "")
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
    throw new Error("GEMINI_API_KEY is missing.");
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
  const triedModels = [];
  const models = [...new Set([primaryModel, ...(fallbackModels || [])].filter(Boolean))];

  for (const modelName of models) {
    triedModels.push(modelName);

    try {
      const parsed = await callGeminiJson({ modelName, prompt, fallback });
      return { parsed, modelUsed: modelName, triedModels };
    } catch (error) {
      console.error(`[Gemini] Model failed: ${modelName}`, String(error?.message || error));
      if (!shouldTryNextModel(error)) {
        throw error;
      }
    }
  }

  return { parsed: fallback, modelUsed: "fallback", triedModels };
}

function decodeBase64File(fileBase64 = "") {
  const cleaned = String(fileBase64 || "").trim().replace(/^data:.*?;base64,/, "");
  return Buffer.from(cleaned, "base64");
}

async function parseUploadedDocument({ filename = "", fileBase64 = "" }) {
  const lower = String(filename || "").toLowerCase();
  const buffer = decodeBase64File(fileBase64);

  if (lower.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer });
    const rawText = result.value || "";
    const paragraphs = rawText.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);

    const chunks = [];
    let pageNumber = 1;
    let currentPage = [];
    let currentLength = 0;

    for (const paragraph of paragraphs) {
      if (currentPage.length && currentLength + paragraph.length > 2200) {
        chunks.push({
          label: `Page ${pageNumber} (estimated from Word extraction)`,
          text: currentPage.join("\n\n")
        });
        pageNumber += 1;
        currentPage = [];
        currentLength = 0;
      }

      currentPage.push(paragraph);
      currentLength += paragraph.length;
    }

    if (currentPage.length) {
      chunks.push({
        label: `Page ${pageNumber} (estimated from Word extraction)`,
        text: currentPage.join("\n\n")
      });
    }

    const fullText = chunks
      .map((chunk) => `[${chunk.label}] ${chunk.text}`)
      .join("\n\n")
      .slice(0, 180000);

    return {
      sourceType: "docx",
      chunks,
      fullText
    };
  }

  if (lower.endsWith(".pdf")) {
    const parsed = await pdfParse(buffer);
    const rawText = String(parsed.text || "").trim();

    const chunks = rawText
      ? rawText
          .split(/\f+/)
          .map((x, i) => ({
            label: `Page ${i + 1}`,
            text: String(x || "").replace(/\s+/g, " ").trim()
          }))
          .filter((x) => x.text)
      : [];

    const safeChunks = chunks.length
      ? chunks
      : [{
          label: "Page 1",
          text: rawText.replace(/\s+/g, " ").trim()
        }].filter((x) => x.text);

    const fullText = safeChunks
      .map((chunk) => `[${chunk.label}] ${chunk.text}`)
      .join("\n\n")
      .slice(0, 180000);

    return {
      sourceType: "pdf",
      chunks: safeChunks,
      fullText
    };
  }

  throw new Error("Unsupported file type. Use .docx or .pdf.");
}

function extractLearnerName(text = "", filename = "") {
  const patterns = [
    /(?:learner|student)\s*name\s*[:\-]\s*([A-Z][A-Za-z' -]{2,80})/i,
    /name\s*[:\-]\s*([A-Z][A-Za-z' -]{2,80})/i
  ];

  for (const pattern of patterns) {
    const match = String(text).match(pattern);
    if (match?.[1]) {
      return match[1].trim().replace(/\s+/g, " ");
    }
  }

  const base = String(filename || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();

  if (base && !/submission|assignment|evidence|unit|task/i.test(base)) {
    return base;
  }

  return "Learner";
}

function pseudonymiseLearner(text = "", filename = "") {
  const learnerName = extractLearnerName(text, filename);
  const learnerRef = `LRN-${crypto.createHash("sha1").update(`${learnerName}|${filename}`).digest("hex").slice(0, 8).toUpperCase()}`;

  let redactedText = String(text || "");

  if (learnerName && learnerName !== "Learner") {
    const escaped = learnerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    redactedText = redactedText.replace(new RegExp(escaped, "gi"), learnerRef);
  }

  return {
    learnerName,
    learnerRef,
    redactedText
  };
}

async function buildCriterionAuditItem({ mode, criterion, learnerText, meta }) {
  const cacheKey = buildCacheKey({
    ...meta,
    learnerText,
    criterion
  });

  const cached = await getCachedGrade(cacheKey);
  if (cached?.result) {
    const parsed = cached.result;
    const confidenceScore = deriveConfidenceScore(parsed, criterion, mode);
    const suggestedStatus = mode === "student"
      ? getDefaultFinalStatus("student", confidenceScore)
      : (parsed.decision || getDefaultFinalStatus("assessor", confidenceScore));

    return {
      id: criterion.code,
      requirement: criterion.requirement,
      status: suggestedStatus,
      finalStatus: suggestedStatus,
      confidenceScore,
      evidencePage: cleanTutorText(parsed.evidence_page || "Page reference not identified"),
      evidenceAndDepth: cleanTutorText(parsed.evidence_and_depth || "No substantial evidence summary returned."),
      rationale: cleanTutorText(parsed.rationale || "No rationale returned."),
      action: buildAlwaysPresentNextSteps({
        mode,
        criterion,
        finalStatus: suggestedStatus,
        action: cleanTutorText(parsed.action || "")
      })
    };
  }

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
- Do not mention hidden system behaviour
- Do not mention model limitations

Criterion code: ${criterion.code || ""}
Criterion requirement: ${criterion.requirement || ""}
Qualification label: ${meta.qualificationLabel || "Not provided"}
Unit info: ${meta.unitInfo || "Not provided"}
Unit context mode: ${meta.unitContextMode || "criteria_only"}
Full unit context: ${meta.fullUnitInfo || ""}
Tutor-led notes: ${meta.tutorLedCriteria || ""}
Assessment mode: ${meta.assessmentMode || "Not provided"}
Pathway: ${meta.pathway || "Not specified"}
Assessor watchouts: ${meta.watchouts || "None"}
Evidence principles: ${meta.evidencePrinciples || "None"}

Learner submission:
${String(learnerText).slice(0, 100000)}`;

  const { parsed } = await callGeminiWithFallback({
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
    primaryModel: DEFAULT_PRIMARY_MODEL,
    fallbackModels: DEFAULT_FALLBACK_MODELS
  });

  const normalised = normaliseGradeResult(parsed);
  await setCachedGrade(cacheKey, { result: normalised });

  const confidenceScore = deriveConfidenceScore(normalised, criterion, mode);
  const suggestedStatus = mode === "student"
    ? getDefaultFinalStatus("student", confidenceScore)
    : (normalised.decision || getDefaultFinalStatus("assessor", confidenceScore));

  return {
    id: criterion.code,
    requirement: criterion.requirement,
    status: suggestedStatus,
    finalStatus: suggestedStatus,
    confidenceScore,
    evidencePage: cleanTutorText(normalised.evidence_page || "Page reference not identified"),
    evidenceAndDepth: cleanTutorText(normalised.evidence_and_depth || "No substantial evidence summary returned."),
    rationale: cleanTutorText(normalised.rationale || "No rationale returned."),
    action: buildAlwaysPresentNextSteps({
      mode,
      criterion,
      finalStatus: suggestedStatus,
      action: cleanTutorText(normalised.action || "")
    })
  };
}

app.get("/health", (req, res) => {
  return res.json({
    status: "ok",
    service: "mgts-btec-feedback-backend",
    version: "server-mjs-clean-2026-04-15"
  });
});

app.get("/api/client-config", (req, res) => {
  return res.json({
    logoUrl: SYSTEM_CONFIG.logoUrl
  });
});

app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const filename = String(req.body?.filename || "").trim();
    const fileBase64 = String(req.body?.fileBase64 || "").trim();

    if (!filename || !fileBase64) {
      return res.status(400).json({ error: "filename and fileBase64 are required." });
    }

    const parsedFile = await parseUploadedDocument({ filename, fileBase64 });

    if (!parsedFile.fullText || parsedFile.fullText.length < 20) {
      return res.status(400).json({ error: "The uploaded brief could not be read clearly." });
    }

    const prompt = `You are extracting structured data from a BTEC assignment brief.
Return JSON only with fields: unit_number, unit_title, learning_aims, assignment_title, assignment_context, criteria (array of {code, requirement}), task_mapping, evidence_requirements, unit_context.
Extract every criterion code and requirement exactly where possible.

Brief text:
${parsedFile.fullText.slice(0, 100000)}`;

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
    console.error("Brief scan file failed:", error);
    return res.status(500).json({
      error: "Request could not be completed.",
      detail: String(error?.message || error)
    });
  }
});

app.post("/api/grade/submission", async (req, res) => {
  try {
    const {
      filename,
      fileBase64,
      criteria,
      mode,
      qualificationLabel,
      unitInfo,
      unitContextMode,
      fullUnitInfo,
      tutorLedCriteria,
      assessmentMode,
      pathway,
      watchouts,
      evidencePrinciples
    } = req.body || {};

    if (!filename || !fileBase64) {
      return res.status(400).json({ error: "filename and fileBase64 are required." });
    }

    if (!Array.isArray(criteria) || !criteria.length) {
      return res.status(400).json({ error: "criteria are required." });
    }

    const parsedFile = await parseUploadedDocument({ filename, fileBase64 });
    const pseudo = pseudonymiseLearner(parsedFile.fullText, filename);

    const sortedCriteria = sortCriteria(
      criteria
        .map((c) => ({
          code: normalizeCriterionCode(c.code),
          requirement: String(c.requirement || "").trim()
        }))
        .filter((c) => c.code && c.requirement)
    );

    const meta = {
      mode: mode || "assessor",
      qualificationLabel: qualificationLabel || "",
      unitInfo: unitInfo || "",
      unitContextMode: unitContextMode || "criteria_only",
      fullUnitInfo: fullUnitInfo || "",
      tutorLedCriteria: tutorLedCriteria || "",
      assessmentMode: assessmentMode || "",
      pathway: pathway || "",
      watchouts: watchouts || "",
      evidencePrinciples: evidencePrinciples || ""
    };

    const audit = [];
    for (const criterion of sortedCriteria) {
      const item = await buildCriterionAuditItem({
        mode: meta.mode,
        criterion,
        learnerText: pseudo.redactedText,
        meta
      });
      audit.push(item);
    }

    const result = {
      fullName: pseudo.learnerName || filename.replace(/\.[^.]+$/, ""),
      learnerRef: pseudo.learnerRef,
      audit,
      summary: meta.mode === "student" ? buildStudentSummary(audit) : buildTutorLedSummary(audit),
      improvementGuide: buildImprovementGuide(audit, meta.mode),
      grade: meta.mode === "student" ? buildStudentGrade() : buildAssessorGrade(audit),
      recordControl: getDefaultRecordControl()
    };

    return res.json({ result });
  } catch (error) {
    console.error("Submission grading failed:", error);
    return res.status(500).json({
      error: "Request could not be completed.",
      detail: String(error?.message || error)
    });
  }
});

app.post("/api/records/save", async (req, res) => {
  try {
    if (!HAS_SUPABASE) {
      return res.status(503).json({ error: "Record storage is not configured." });
    }

    const user = await getRequestUser(req);
    if (!user) {
      return res.status(401).json({ error: "Login required." });
    }

    const result = req.body?.result;
    const unit = String(req.body?.unit || "").trim();

    if (!result || typeof result !== "object") {
      return res.status(400).json({ error: "result is required." });
    }

    const rc = result.recordControl || getDefaultRecordControl();

    const { data, error } = await supabase
      .from("feedback_records")
      .insert({
        user_id: user.id,
        learner_name: result.fullName || "",
        unit,
        grade: result.grade || "",
        record_status: rc.recordStatus || "Draft",
        assessor_signed_off_by: rc.assessorSignedOffBy || null,
        assessor_signed_off_at: rc.assessorSignedOffAt || null,
        assessor_internal_notes: rc.assessorInternalNotes || null,
        iv_required: Boolean(rc.ivRequired),
        iv_started_at: rc.ivStartedAt || null,
        iv_reviewer_name: rc.ivReviewerName || null,
        iv_decision: rc.ivDecision || null,
        iv_decision_at: rc.ivDecisionAt || null,
        iv_internal_notes: rc.ivInternalNotes || null,
        released_at: rc.releasedAt || null,
        released_by: rc.releasedBy || null,
        data: result
      })
      .select()
      .single();

    if (error) {
      console.error("Record save failed:", error);
      return res.status(500).json({ error: "Request could not be completed." });
    }

    return res.json({ id: data.id });
  } catch (error) {
    console.error("Record save failed:", error);
    return res.status(500).json({ error: "Request could not be completed." });
  }
});

app.post("/api/records/update", async (req, res) => {
  try {
    if (!HAS_SUPABASE) {
      return res.status(503).json({ error: "Record storage is not configured." });
    }

    const user = await getRequestUser(req);
    if (!user) {
      return res.status(401).json({ error: "Login required." });
    }

    const result = req.body?.result;
    const dbId = req.body?.dbId;

    if (!dbId || !result || typeof result !== "object") {
      return res.status(400).json({ error: "dbId and result are required." });
    }

    const rc = result.recordControl || getDefaultRecordControl();

    const { error } = await supabase
      .from("feedback_records")
      .update({
        learner_name: result.fullName || "",
        grade: result.grade || "",
        record_status: rc.recordStatus || "Draft",
        assessor_signed_off_by: rc.assessorSignedOffBy || null,
        assessor_signed_off_at: rc.assessorSignedOffAt || null,
        assessor_internal_notes: rc.assessorInternalNotes || null,
        iv_required: Boolean(rc.ivRequired),
        iv_started_at: rc.ivStartedAt || null,
        iv_reviewer_name: rc.ivReviewerName || null,
        iv_decision: rc.ivDecision || null,
        iv_decision_at: rc.ivDecisionAt || null,
        iv_internal_notes: rc.ivInternalNotes || null,
        released_at: rc.releasedAt || null,
        released_by: rc.releasedBy || null,
        data: result
      })
      .eq("id", dbId)
      .eq("user_id", user.id);

    if (error) {
      console.error("Record update failed:", error);
      return res.status(500).json({ error: "Request could not be completed." });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Record update failed:", error);
    return res.status(500).json({ error: "Request could not be completed." });
  }
});

app.get("/api/records/list", async (req, res) => {
  try {
    if (!HAS_SUPABASE) {
      return res.status(503).json({ error: "Record storage is not configured." });
    }

    const user = await getRequestUser(req);
    if (!user) {
      return res.status(401).json({ error: "Login required." });
    }

    const { data, error } = await supabase
      .from("feedback_records")
      .select("id, learner_name, unit, grade, created_at, record_status")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Record list failed:", error);
      return res.status(500).json({ error: "Request could not be completed." });
    }

    return res.json({ records: data || [] });
  } catch (error) {
    console.error("Record list failed:", error);
    return res.status(500).json({ error: "Request could not be completed." });
  }
});

app.post("/api/records/load", async (req, res) => {
  try {
    if (!HAS_SUPABASE) {
      return res.status(503).json({ error: "Record storage is not configured." });
    }

    const user = await getRequestUser(req);
    if (!user) {
      return res.status(401).json({ error: "Login required." });
    }

    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];

    let query = supabase
      .from("feedback_records")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (ids.length) {
      query = query.in("id", ids);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Record load failed:", error);
      return res.status(500).json({ error: "Request could not be completed." });
    }

    return res.json({ records: data || [] });
  } catch (error) {
    console.error("Record load failed:", error);
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
