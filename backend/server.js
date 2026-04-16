import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mammoth from "mammoth";
import pdf from "pdf-parse";
import JSZip from "jszip";
import Tesseract from "tesseract.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "100mb" }));

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const LOGO_URL =
  "https://www.mgts.co.uk/wp-content/themes/mgts/images/svg/logo.svg";

/* --------------------------------------------------
   CONFIG
-------------------------------------------------- */

const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","to","in","on","for","with","by","at","from","into","that","this","these","those",
  "is","are","was","were","be","been","being","it","its","their","there","them","they","he","she","you","your","yours",
  "as","if","than","then","also","can","could","should","would","may","might","must","will","shall","do","does","did",
  "have","has","had","not","no","yes","such","using","used","use","within","across","about","over","under","up","down",
  "how","what","why","when","where","which","who","whom","whose","all","any","some","each","other","more","most","less",
  "very","well","clear","clearly","detail","detailed","include","including","show","shows","shown","provide","provided",
  "analysis","analyse","analyze","explain","description","discuss","discussion","report","presentation","notes"
]);

const COMMAND_VERB_HINTS = {
  explain: ["define", "describe", "outline", "set out", "what is", "meaning"],
  analyse: ["analysis", "compare", "relationship", "impact", "because", "therefore", "however", "whereas"],
  determine: ["justify", "select", "choose", "recommend", "determine", "decision", "option"],
  develop: ["process", "plan", "steps", "implementation", "framework", "workflow", "stage"],
  justify: ["because", "rationale", "reason", "justified", "benefit", "drawback"],
  evaluate: ["strength", "weakness", "advantage", "disadvantage", "effectiveness", "suitability", "limitations"]
};

const DOMAIN_HINTS = {
  quality: ["quality", "defect", "conformance", "inspection", "variation", "control"],
  costing: ["cost", "costing", "appraisal", "prevention", "failure", "loss", "budget"],
  tools: ["pareto", "histogram", "control chart", "fishbone", "cause and effect", "qfd", "tpm", "erp", "taguchi"],
  process: ["process", "workflow", "stage", "step", "implementation", "continuous improvement"],
  performance: ["performance", "efficiency", "waste", "throughput", "productivity", "business"]
};

/* --------------------------------------------------
   UTILITIES
-------------------------------------------------- */

function safeString(value = "") {
  return String(value ?? "").trim();
}

function normalizeWhitespace(text = "") {
  return safeString(text).replace(/\r/g, "\n").replace(/\t/g, " ").replace(/[ ]{2,}/g, " ");
}

function splitParagraphs(text = "") {
  return normalizeWhitespace(text)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function normalizeCriterionCode(code = "") {
  return safeString(code).toUpperCase().replace(/\s+/g, "");
}

function tokenize(text = "") {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t && !STOPWORDS.has(t) && t.length > 2);
}

function unique(arr) {
  return [...new Set(arr)];
}

function intersectionCount(a, b) {
  const bSet = new Set(b);
  let count = 0;
  for (const token of a) if (bSet.has(token)) count++;
  return count;
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function sentenceSplit(text = "") {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractCommandVerb(requirement = "") {
  const firstWord = safeString(requirement).split(/\s+/)[0]?.toLowerCase() || "";
  return firstWord;
}

function summarizeSnippet(text = "", maxLen = 320) {
  const clean = normalizeWhitespace(text).replace(/\n/g, " ");
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen - 1).trim()}…`;
}

function inferFileRole(filename = "") {
  const name = filename.toLowerCase();
  if (name.endsWith(".pptx") || name.includes("presentation") || name.includes("slides")) return "presentation";
  if (name.includes("notes") || name.includes("speaker")) return "notes";
  if (name.includes("report")) return "report";
  if (name.includes("appendix")) return "appendix";
  if (name.includes("brief")) return "brief";
  if (name.includes("evidence")) return "evidence";
  return "general";
}

function scoreBand(score) {
  if (score >= 82) return "high";
  if (score >= 60) return "medium";
  return "low";
}

function statusByConfidence(score, mode = "assessor") {
  if (mode === "student") {
    if (score >= 82) return "Strong evidence";
    if (score >= 60) return "Some evidence";
    return "Needs attention";
  }

  if (score >= 82) return "Achieved";
  if (score >= 60) return "Review Required";
  return "Review Required";
}

/* --------------------------------------------------
   EXTRACTION
-------------------------------------------------- */

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return {
    text: normalizeWhitespace(result.value || ""),
    sections: splitParagraphs(result.value || "").map((text, idx) => ({
      locator: `paragraph ${idx + 1}`,
      text
    }))
  };
}

async function extractPdf(buffer) {
  const result = await pdf(buffer);
  const text = normalizeWhitespace(result.text || "");
  const sections = splitParagraphs(text).map((p, idx) => ({
    locator: `section ${idx + 1}`,
    text: p
  }));
  return { text, sections };
}

function decodeXmlText(xml = "") {
  return xml
    .replace(/<a:br\/>/g, "\n")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const sections = [];
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const aNum = Number(a.match(/slide(\d+)\.xml/)?.[1] || 0);
      const bNum = Number(b.match(/slide(\d+)\.xml/)?.[1] || 0);
      return aNum - bNum;
    });

  for (const slidePath of slideFiles) {
    const slideNum = Number(slidePath.match(/slide(\d+)\.xml/)?.[1] || 0);
    const slideXml = await zip.files[slidePath].async("text");
    const slideText = decodeXmlText(slideXml);

    if (slideText) {
      sections.push({
        locator: `slide ${slideNum}`,
        text: slideText
      });
    }

    const notesPath = `ppt/notesSlides/notesSlide${slideNum}.xml`;
    if (zip.files[notesPath]) {
      const notesXml = await zip.files[notesPath].async("text");
      const notesText = decodeXmlText(notesXml);
      if (notesText) {
        sections.push({
          locator: `slide ${slideNum} notes`,
          text: notesText
        });
      }
    }
  }

  return {
    text: sections.map((s) => `[${s.locator}] ${s.text}`).join("\n\n"),
    sections
  };
}

async function extractTxt(buffer) {
  const text = normalizeWhitespace(buffer.toString("utf-8"));
  return {
    text,
    sections: splitParagraphs(text).map((p, idx) => ({
      locator: `section ${idx + 1}`,
      text: p
    }))
  };
}

async function extractImage(buffer) {
  const result = await Tesseract.recognize(buffer, "eng");
  const text = normalizeWhitespace(result.data?.text || "");
  return {
    text,
    sections: splitParagraphs(text).map((p, idx) => ({
      locator: `ocr block ${idx + 1}`,
      text: p
    }))
  };
}

async function extractTextFromFile(file) {
  const buffer = Buffer.from(file.fileBase64, "base64");
  const filename = safeString(file.filename);
  const lower = filename.toLowerCase();

  try {
    if (lower.endsWith(".docx")) {
      const out = await extractDocx(buffer);
      return { filename, role: file.role || inferFileRole(filename), kind: "docx", ...out };
    }

    if (lower.endsWith(".pdf")) {
      const out = await extractPdf(buffer);
      return { filename, role: file.role || inferFileRole(filename), kind: "pdf", ...out };
    }

    if (lower.endsWith(".pptx")) {
      const out = await extractPptx(buffer);
      return { filename, role: file.role || inferFileRole(filename), kind: "pptx", ...out };
    }

    if (lower.endsWith(".txt")) {
      const out = await extractTxt(buffer);
      return { filename, role: file.role || inferFileRole(filename), kind: "txt", ...out };
    }

    if (/\.(png|jpg|jpeg|webp)$/i.test(lower)) {
      const out = await extractImage(buffer);
      return { filename, role: file.role || inferFileRole(filename), kind: "image", ...out };
    }

    return {
      filename,
      role: file.role || inferFileRole(filename),
      kind: "unsupported",
      text: "",
      sections: []
    };
  } catch (error) {
    console.error(`Extraction failed for ${filename}:`, error);
    return {
      filename,
      role: file.role || inferFileRole(filename),
      kind: "error",
      text: "",
      sections: []
    };
  }
}

/* --------------------------------------------------
   CHUNKING / EVIDENCE INDEX
-------------------------------------------------- */

function chunkSectionText(sectionText = "", maxSentences = 3) {
  const sentences = sentenceSplit(sectionText);
  if (!sentences.length) return [];
  if (sentences.length <= maxSentences) return [sectionText];

  const chunks = [];
  for (let i = 0; i < sentences.length; i += maxSentences) {
    chunks.push(sentences.slice(i, i + maxSentences).join(" "));
  }
  return chunks;
}

function buildEvidenceIndex(extractedFiles = []) {
  const chunks = [];

  for (const file of extractedFiles) {
    const sections = Array.isArray(file.sections) ? file.sections : [];

    if (!sections.length && file.text) {
      chunkSectionText(file.text, 4).forEach((chunkText, idx) => {
        chunks.push({
          filename: file.filename,
          role: file.role,
          locator: `block ${idx + 1}`,
          text: chunkText,
          tokens: tokenize(chunkText)
        });
      });
      continue;
    }

    sections.forEach((section) => {
      const chunkTexts = chunkSectionText(section.text, 3);
      chunkTexts.forEach((chunkText, idx) => {
        chunks.push({
          filename: file.filename,
          role: file.role,
          locator: chunkTexts.length > 1 ? `${section.locator}, part ${idx + 1}` : section.locator,
          text: chunkText,
          tokens: tokenize(chunkText)
        });
      });
    });
  }

  return chunks;
}

/* --------------------------------------------------
   BRIEF / CRITERIA PARSING
-------------------------------------------------- */

function parseCriteriaFromText(text = "") {
  const lines = normalizeWhitespace(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const found = [];
  const seen = new Set();

  for (const line of lines) {
    const match =
      line.match(/^([PMD]\d+)\s*[:\-–—]?\s+(.+)$/i) ||
      line.match(/\b([PMD]\d+)\b\s+(.+)/i);

    if (!match) continue;

    const code = normalizeCriterionCode(match[1]);
    const requirement = safeString(match[2]).replace(/\s+/g, " ");

    if (!code || !requirement || seen.has(code)) continue;
    seen.add(code);
    found.push({ code, requirement });
  }

  return found;
}

function inferUnitContext(text = "") {
  const lines = normalizeWhitespace(text)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const loLines = lines.filter((l) => /^LO\d+/i.test(l));
  return loLines.slice(0, 8).join("\n");
}

function inferEvidenceRequirements(text = "") {
  const lines = normalizeWhitespace(text)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  return lines
    .filter((line) =>
      /(presentation|report|notes|research|references|citation|evidence|diagram|example|process|plan)/i.test(line)
    )
    .slice(0, 12);
}

/* --------------------------------------------------
   MATCHING / SCORING
-------------------------------------------------- */

function getCriterionHints(requirement = "") {
  const requirementLower = requirement.toLowerCase();
  const tokens = tokenize(requirement);
  const hints = [...tokens];

  for (const [domain, terms] of Object.entries(DOMAIN_HINTS)) {
    if (requirementLower.includes(domain)) hints.push(...terms);
    for (const term of terms) {
      if (requirementLower.includes(term)) hints.push(term);
    }
  }

  const verb = extractCommandVerb(requirement);
  if (COMMAND_VERB_HINTS[verb]) hints.push(...COMMAND_VERB_HINTS[verb]);

  return unique(hints.filter((t) => t && t.length > 2));
}

function roleBonusForCriterion(requirement = "", role = "") {
  const req = requirement.toLowerCase();
  if (role === "presentation" && /(justify|tools|techniques|presentation|improve business performance)/i.test(req)) return 8;
  if (role === "notes" && /(justify|verbal|discussion|presentation|explain)/i.test(req)) return 6;
  if (role === "report" && /(report|cost|costing|process|plan|develop|taguchi)/i.test(req)) return 8;
  if (role === "appendix" && /(evidence|example|support)/i.test(req)) return 4;
  return 0;
}

function scoreChunkAgainstCriterion(chunk, criterion) {
  const criterionTokens = tokenize(criterion.requirement);
  const hintTokens = getCriterionHints(criterion.requirement);
  const overlap = intersectionCount(criterionTokens, chunk.tokens);
  const hintOverlap = intersectionCount(hintTokens, chunk.tokens);

  const criterionCoverage = criterionTokens.length
    ? overlap / criterionTokens.length
    : 0;

  const hintCoverage = hintTokens.length
    ? hintOverlap / hintTokens.length
    : 0;

  const verb = extractCommandVerb(criterion.requirement);
  const verbTerms = COMMAND_VERB_HINTS[verb] || [];
  const verbHit = verbTerms.some((term) => chunk.text.toLowerCase().includes(term)) ? 1 : 0;

  const exactPhraseBonus = chunk.text.toLowerCase().includes(criterion.requirement.toLowerCase().slice(0, 18)) ? 12 : 0;
  const roleBonus = roleBonusForCriterion(criterion.requirement, chunk.role);

  let score =
    criterionCoverage * 50 +
    hintCoverage * 28 +
    verbHit * 8 +
    exactPhraseBonus +
    roleBonus;

  score = clamp(Math.round(score), 0, 100);
  return score;
}

function selectTopEvidenceForCriterion(chunks, criterion, maxItems = 4) {
  const scored = chunks
    .map((chunk) => ({
      ...chunk,
      score: scoreChunkAgainstCriterion(chunk, criterion)
    }))
    .filter((item) => item.score >= 18)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems);

  return scored;
}

/* --------------------------------------------------
   OPTIONAL OPENAI SYNTHESIS
-------------------------------------------------- */

async function callOpenAIJson(messages, responseSchemaHint = "Return valid JSON only.") {
  if (!OPENAI_API_KEY) return null;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: responseSchemaHint },
        ...messages
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  const jsonMatch = content.match(/\{[\s\S]*\}$/);
  if (!jsonMatch) return null;

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

async function synthesizeCriterionJudgement({ criterion, evidence, mode }) {
  if (!OPENAI_API_KEY || !evidence.length) return null;

  const evidenceText = evidence
    .map((e, idx) =>
      `Evidence ${idx + 1}\nFile: ${e.filename}\nLocation: ${e.locator}\nScore: ${e.score}\nText: ${summarizeSnippet(e.text, 700)}`
    )
    .join("\n\n");

  const prompt = `
Criterion code: ${criterion.code}
Requirement: ${criterion.requirement}
Mode: ${mode}

Using only the evidence provided, return JSON with:
{
  "evidenceAndDepth": "...",
  "rationale": "...",
  "action": "...",
  "confidenceAdjustment": number from -10 to 10
}

Rules:
- Do not invent evidence.
- If evidence is partial, say so.
- Keep tutor-facing language professional and concise.
`;

  const out = await callOpenAIJson(
    [
      {
        role: "user",
        content: `${prompt}\n\n${evidenceText}`
      }
    ],
    "You are a careful assessment assistant. Return valid JSON only."
  );

  return out;
}

/* --------------------------------------------------
   GRADE ENGINE
-------------------------------------------------- */

async function gradeAgainstCriteria({ criteria = [], extractedFiles = [], mode = "assessor" }) {
  const evidenceIndex = buildEvidenceIndex(extractedFiles);
  const audit = [];

  for (const rawCriterion of criteria) {
    const criterion = {
      code: normalizeCriterionCode(rawCriterion.code),
      requirement: safeString(rawCriterion.requirement)
    };

    const evidence = selectTopEvidenceForCriterion(evidenceIndex, criterion, 4);
    const best = evidence[0] || null;
    const averageTopScore = evidence.length
      ? Math.round(evidence.reduce((sum, e) => sum + e.score, 0) / evidence.length)
      : 0;

    let confidenceScore = averageTopScore;
    let status = statusByConfidence(confidenceScore, mode);

    const evidencePage = best
      ? `${best.filename} - ${best.locator}`
      : "Evidence location not identified";

    let evidenceAndDepth = best
      ? `Matched evidence was found in ${best.filename} at ${best.locator}. ${summarizeSnippet(best.text, 420)}`
      : "No securely matched evidence was located across the submitted files.";

    let rationale = best
      ? `This judgement is based on the strongest matched evidence chunk and supporting related matches across the submission pack.`
      : `A secure judgement could not be confirmed from the extracted evidence across the submitted files.`;

    let action = mode === "student"
      ? "Strengthen this area with more direct evidence, clearer explanation, and explicit links to the criterion wording."
      : "Tutor review required. Check whether the evidence exists in diagrams, slides, notes, tables, or unstructured sections that may not have been matched strongly.";

    if (OPENAI_API_KEY && evidence.length) {
      try {
        const ai = await synthesizeCriterionJudgement({ criterion, evidence, mode });
        if (ai) {
          evidenceAndDepth = safeString(ai.evidenceAndDepth) || evidenceAndDepth;
          rationale = safeString(ai.rationale) || rationale;
          action = safeString(ai.action) || action;
          confidenceScore = clamp(confidenceScore + Number(ai.confidenceAdjustment || 0), 0, 100);
          status = statusByConfidence(confidenceScore, mode);
        }
      } catch (error) {
        console.warn(`AI synthesis failed for ${criterion.code}:`, error.message);
      }
    }

    if (confidenceScore < 40) {
      status = mode === "student" ? "Needs attention" : "Review Required";
      rationale = "Evidence was not confidently located across the submitted files. Tutor verification is required before any final judgement.";
      action = mode === "student"
        ? "Add clearer direct evidence and signpost exactly where the criterion is met."
        : "Review the full evidence pack manually, especially slides, speaker notes, diagrams, and appendices.";
    }

    audit.push({
      id: criterion.code,
      requirement: criterion.requirement,
      status,
      finalStatus: status,
      confidenceScore,
      evidencePage,
      evidenceAndDepth,
      rationale,
      action,
      evidenceTrace: evidence.map((e) => ({
        file: e.filename,
        role: e.role,
        locator: e.locator,
        score: e.score,
        snippet: summarizeSnippet(e.text, 220)
      }))
    });
  }

  return audit;
}

function buildOverallGrade(audit = [], mode = "assessor") {
  if (mode === "student") return "Pre-submission guidance";

  const statusFor = (codePrefix) =>
    audit.filter((a) => a.id.startsWith(codePrefix)).map((a) => a.finalStatus || a.status);

  const pass = statusFor("P");
  const merit = statusFor("M");
  const distinction = statusFor("D");

  const allAchieved = (arr) => arr.length > 0 && arr.every((s) => s === "Achieved");
  const anyReview = (arr) => arr.some((s) => s === "Review Required");

  if (pass.length && anyReview(pass)) return "Pass Pending Review";
  if (distinction.length && allAchieved(pass) && allAchieved(merit) && allAchieved(distinction)) return "Distinction";
  if (merit.length && allAchieved(pass) && allAchieved(merit)) return "Merit";
  if (pass.length && allAchieved(pass)) return "Pass";
  return "Pass Pending Review";
}

function buildTutorSummary(audit = [], mode = "assessor") {
  const strongStatuses = mode === "student" ? ["Strong evidence"] : ["Achieved"];
  const weakStatuses = mode === "student" ? ["Needs attention"] : ["Review Required"];

  const strong = audit.filter((a) => strongStatuses.includes(a.finalStatus || a.status)).map((a) => a.id);
  const weak = audit.filter((a) => weakStatuses.includes(a.finalStatus || a.status)).map((a) => a.id);

  if (mode === "student") {
    return strong.length
      ? `The submission appears strongest in ${strong.slice(0, 3).join(", ")}. Review is still needed for ${weak.slice(0, 3).join(", ") || "remaining criteria"}.`
      : `The submission currently needs further development. Add clearer direct evidence and stronger signposting to the criterion wording.`;
  }

  return strong.length
    ? `Secure evidence was matched most strongly for ${strong.slice(0, 3).join(", ")}. Tutor review remains important for ${weak.slice(0, 3).join(", ") || "criteria with weaker matches"}.`
    : `No criteria were matched with high confidence. Tutor review of the full evidence pack is required.`;
}

/* --------------------------------------------------
   API ENDPOINTS
-------------------------------------------------- */

app.get("/api/client-config", (req, res) => {
  res.json({ logoUrl: LOGO_URL });
});

app.post("/api/brief/scan-file", async (req, res) => {
  try {
    const { filename, fileBase64 } = req.body;
    if (!filename || !fileBase64) {
      return res.status(400).json({ error: "filename and fileBase64 are required" });
    }

    const extracted = await extractTextFromFile({ filename, fileBase64 });
    const criteria = parseCriteriaFromText(extracted.text);
    const unitContext = inferUnitContext(extracted.text);
    const evidenceRequirements = inferEvidenceRequirements(extracted.text);

    const assignmentContext = splitParagraphs(extracted.text)
      .filter((p) => /(task|scenario|brief|submission format|you should present|written report|presentation)/i.test(p))
      .slice(0, 8)
      .join("\n\n");

    res.json({
      result: {
        criteria,
        unit_context: unitContext,
        assignment_context: assignmentContext,
        evidence_requirements: evidenceRequirements,
        extraction_trace: {
          file: extracted.filename,
          role: extracted.role,
          kind: extracted.kind,
          sections: extracted.sections.slice(0, 20).map((s) => ({
            locator: s.locator,
            snippet: summarizeSnippet(s.text, 180)
          }))
        }
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Brief scan failed" });
  }
});

app.post("/api/grade/submission", async (req, res) => {
  try {
    const {
      filename,
      fileBase64,
      criteria = [],
      mode = "assessor"
    } = req.body;

    if (!filename || !fileBase64) {
      return res.status(400).json({ error: "filename and fileBase64 are required" });
    }

    const extracted = await extractTextFromFile({ filename, fileBase64 });
    const audit = await gradeAgainstCriteria({
      criteria,
      extractedFiles: [extracted],
      mode
    });

    const result = {
      fullName: filename.replace(/\.[^.]+$/, ""),
      grade: buildOverallGrade(audit, mode),
      audit,
      tutorSummary: buildTutorSummary(audit, mode),
      evidenceTrace: [
        {
          file: extracted.filename,
          role: extracted.role,
          kind: extracted.kind,
          sectionCount: extracted.sections.length
        }
      ],
      recordControl: {
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
      }
    };

    res.json({ result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Single submission failed" });
  }
});

app.post("/api/grade/submission-multi", async (req, res) => {
  try {
    const {
      submissionLabel = "Combined Submission",
      files = [],
      criteria = [],
      mode = "assessor"
    } = req.body;

    if (!Array.isArray(files) || !files.length) {
      return res.status(400).json({ error: "At least one file is required" });
    }

    const extractedFiles = [];
    for (const file of files) {
      extractedFiles.push(await extractTextFromFile(file));
    }

    const audit = await gradeAgainstCriteria({
      criteria,
      extractedFiles,
      mode
    });

    const result = {
      fullName: submissionLabel,
      grade: buildOverallGrade(audit, mode),
      audit,
      tutorSummary: buildTutorSummary(audit, mode),
      evidenceTrace: extractedFiles.map((f) => ({
        file: f.filename,
        role: f.role,
        kind: f.kind,
        sectionCount: f.sections.length
      })),
      recordControl: {
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
      }
    };

    res.json({ result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Multi submission failed" });
  }
});

/* --------------------------------------------------
   DEMO IN-MEMORY RECORD STORAGE
   Replace with Supabase when ready
-------------------------------------------------- */

let records = [];

app.post("/api/records/save", (req, res) => {
  try {
    const id = Date.now().toString();
    const unit = safeString(req.body.unit);
    const result = req.body.result || {};

    records.unshift({
      id,
      unit,
      learner_name: result.fullName || "Unnamed learner",
      grade: result.grade || "",
      record_status: result.recordControl?.recordStatus || "Draft",
      created_at: new Date().toISOString(),
      data: result
    });

    res.json({ id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not save record" });
  }
});

app.post("/api/records/update", (req, res) => {
  try {
    const { dbId, result } = req.body;
    const idx = records.findIndex((r) => r.id === dbId);

    if (idx === -1) {
      return res.status(404).json({ error: "Record not found" });
    }

    records[idx] = {
      ...records[idx],
      learner_name: result.fullName || records[idx].learner_name,
      grade: result.grade || records[idx].grade,
      record_status: result.recordControl?.recordStatus || records[idx].record_status,
      data: result
    };

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not update record" });
  }
});

app.get("/api/records/list", (req, res) => {
  res.json({ records });
});

app.post("/api/records/load", (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const selected = ids.length ? records.filter((r) => ids.includes(r.id)) : records;
  res.json({ records: selected });
});

/* --------------------------------------------------
   START
-------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`MGTS Feedback Server running on port ${PORT}`);
});
