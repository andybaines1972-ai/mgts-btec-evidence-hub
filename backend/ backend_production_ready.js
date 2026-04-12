import express from "express";
import cors from "cors";
import helmet from "helmet";
import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "2mb" }));

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);

function corsOrigin(origin, callback) {
  if (!origin) return callback(null, true);

  const exactAllowed = allowedOrigins.includes(origin);
  const isVercelPreview = /^https:\/\/mgts-btec-[a-z0-9-]+\.vercel\.app$/i.test(origin);

  if (exactAllowed || isVercelPreview) return callback(null, true);
  callback(new Error(`Origin not allowed: ${origin}`));
}

app.use(cors({
  origin: corsOrigin,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors());

function readSecret(name, fallback = "") {
  try {
    return fs.readFileSync(`/etc/secrets/${name}`, "utf8").trim();
  } catch {
    return process.env[name] || fallback;
  }
}

const AUTH_SECRET = readSecret("AUTH_SECRET", "change-me");
const ADMIN_PASSWORD = readSecret("ADMIN_PASSWORD", "change-me");
const GEMINI_API_KEY = readSecret("GEMINI_API_KEY", "");
const MODEL = process.env.MODEL || "gemini-2.5-flash";

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes(".")) return null;

  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("base64url");
  if (sig !== expected) return null;

  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!parsed.exp || Date.now() > parsed.exp) return null;
  return parsed;
}

function requireAdmin(req, res, next) {
  const token = req.headers.authorization || "";
  const session = verifyToken(token);
  if (!session || session.role !== "admin") {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, model: MODEL });
});

app.post("/api/auth/admin-login", (req, res) => {
  const { password } = req.body || {};

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }

  const token = signToken({
    role: "admin",
    exp: Date.now() + 1000 * 60 * 60 * 8
  });

  res.json({ token });
});

function extractJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("Empty AI response");

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }

  throw new Error("Could not parse AI JSON response");
}

async function callGemini(prompt, model = MODEL) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "Gemini request failed");
  }

  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

app.post("/api/brief/scan", requireAdmin, async (req, res) => {
  try {
    const briefText = String(req.body?.briefText || "");
    if (briefText.length < 20) {
      return res.status(400).json({ error: "Brief text is too short." });
    }

    const prompt = `
You are extracting BTEC assessment criteria from an assignment brief.

Return valid JSON only in this shape:
{
  "criteria": [
    { "code": "P1", "requirement": "..." }
  ]
}

Rules:
- Extract only genuine criterion codes like P1, P2, M1, D1.
- Keep requirement text concise but accurate.
- Do not invent codes.
- If unsure, omit rather than guess.

Brief:
${briefText.slice(0, 20000)}
`;

    const raw = await callGemini(prompt);
    let parsed;

    try {
      parsed = extractJson(raw);
    } catch {
      const matches = [...new Set((briefText.match(/\b[PMD]\d+\b/gi) || []).map(v => v.toUpperCase()))];
      parsed = {
        criteria: matches.map(code => ({
          code,
          requirement: "Detected from brief. Review and edit as needed."
        }))
      };
    }

    const criteria = Array.isArray(parsed.criteria) ? parsed.criteria : [];
    res.json({ result: { criteria } });
  } catch (error) {
    res.status(500).json({ error: error.message || "Brief scan failed." });
  }
});

app.post("/api/grade/criterion", requireAdmin, async (req, res) => {
  try {
    const {
      mode = "assessor",
      qualificationLabel = "",
      unitInfo = "",
      assessmentMode = "",
      pathway = "",
      watchouts = "",
      evidencePrinciples = "",
      learnerText = "",
      criterion = {},
      strategy = {}
    } = req.body || {};

    if (!learnerText || learnerText.length < 20) {
      return res.status(400).json({ error: "Learner text is too short." });
    }

    if (!criterion.code || !criterion.requirement) {
      return res.status(400).json({ error: "Criterion is missing code or requirement." });
    }

    const primaryModel = String(strategy.primaryModel || MODEL).trim() || MODEL;
    const fallbackModels = Array.isArray(strategy.fallbackModels)
      ? strategy.fallbackModels.filter(Boolean)
      : [];
    const modelsToTry = [primaryModel, ...fallbackModels].filter(Boolean);

    const studentOrAssessor = mode === "student"
      ? `
This is a student pre-submission guidance check.
Do not write as if you are confirming final achievement.
Use supportive, guidance-led language.
`
      : `
This is assessor-facing draft feedback.
Use professional, tutor-led wording grounded in visible evidence.
`;

    const prompt = `
You are an experienced BTEC assessor.

${studentOrAssessor}

Qualification: ${qualificationLabel}
Unit info: ${unitInfo}
Assessment mode: ${assessmentMode}
Pathway: ${pathway}

Evidence principles:
${evidencePrinciples || "None provided"}

Watchouts:
${watchouts || "None provided"}

Criterion:
${criterion.code}: ${criterion.requirement}

Learner submission:
${learnerText.slice(0, 50000)}

Return valid JSON only in this exact shape:
{
  "decision": "Achieved | Not Yet Achieved | Review Required",
  "evidence_and_depth": "Concise evidence summary",
  "evidence_page": "Page reference or best estimate",
  "rationale": "Why this judgement has been made",
  "action": "Clear next step",
  "confidence_score": 0
}

Rules:
- Do not invent evidence.
- If evidence is thin or unclear, use Review Required or Not Yet Achieved.
- confidence_score must be 0 to 100.
- Keep action useful and specific.
`;

    async function sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function callGeminiWithTimeout(prompt, model, timeoutMs = 45000) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.2,
                responseMimeType: "application/json"
              }
            })
          }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data?.error?.message || `Gemini request failed for model ${model}`);
        }

        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (!text) {
          throw new Error(`Empty AI response from model ${model}`);
        }

        return text;
      } finally {
        clearTimeout(timeout);
      }
    }

    async function tryModel(modelName, maxAttempts = 2) {
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const raw = await callGeminiWithTimeout(prompt, modelName, 45000);
          const parsed = extractJson(raw);

          return {
            ok: true,
            modelUsed: modelName,
            parsed
          };
        } catch (err) {
          lastError = err;
          if (attempt < maxAttempts) {
            await sleep(1200 * attempt);
          }
        }
      }

      return {
        ok: false,
        modelUsed: modelName,
        error: lastError
      };
    }

    let finalResult = null;
    const modelErrors = [];

    for (const modelName of modelsToTry) {
      const attempt = await tryModel(modelName, 2);

      if (attempt.ok) {
        finalResult = attempt;
        break;
      }

      modelErrors.push(`${modelName}: ${attempt.error?.message || "Unknown error"}`);
      await sleep(800);
    }

    if (!finalResult) {
      return res.json({
        result: {
          decision: "Review Required",
          evidence_and_depth: "Automatic analysis could not be completed reliably because the AI service was temporarily unavailable or overloaded.",
          evidence_page: "Not determined",
          rationale: "The submission should be reviewed manually for this criterion because the automated model call failed.",
          action: "Re-run this criterion later or review it manually before confirming judgement.",
          confidence_score: 15
        },
        meta: {
          modelUsed: "fallback-safe-response",
          warning: "AI model unavailable",
          modelErrors
        }
      });
    }

    const parsed = finalResult.parsed || {};

    res.json({
      result: {
        decision: parsed.decision || "Review Required",
        evidence_and_depth: parsed.evidence_and_depth || "",
        evidence_page: parsed.evidence_page || "",
        rationale: parsed.rationale || "",
        action: parsed.action || "",
        confidence_score: Number(parsed.confidence_score) || 50
      },
      meta: {
        modelUsed: finalResult.modelUsed
      }
    });
  } catch (error) {
    res.json({
      result: {
        decision: "Review Required",
        evidence_and_depth: "An unexpected backend error occurred while analysing this criterion.",
        evidence_page: "Not determined",
        rationale: "The backend could not complete the automated analysis for this criterion.",
        action: "Review manually or retry once service demand has reduced.",
        confidence_score: 10
      },
      meta: {
        modelUsed: "backend-safe-response",
        warning: error.message || "Unexpected backend error"
      }
    });
  }
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`MGTS backend listening on port ${port}`);
});
