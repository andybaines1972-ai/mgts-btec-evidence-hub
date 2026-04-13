import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
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
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

function getModelName(preferred) {
  return preferred || process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

function getFallbackModelName(preferred, primary = "") {
  const candidate =
    preferred ||
    process.env.GEMINI_FALLBACK_MODEL ||
    "gemini-2.5-flash-lite";

  if (!candidate) return "";
  if (candidate === primary) return "gemini-2.5-flash-lite";
  return candidate;
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim() || authHeader.trim();

  if (!token || token !== process.env.ADMIN_TOKEN_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  next();
@@ -210,60 +208,59 @@ function isRetryableModelError(error) {
    message.includes("timeout")
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
      const modelInstance = genAI.getGenerativeModel({
        model,
        generationConfig: {
          temperature: 0,
          topP: 0.1
        }
      });
      const result = await modelInstance.generateContent(prompt);
      const text = await extractTextResponse(result.response);
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
