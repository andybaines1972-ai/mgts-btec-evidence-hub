import dotenv from "dotenv";

dotenv.config();

function splitCsv(value) {
    return String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

export const config = {
    port: Number(process.env.PORT || 4000),
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    defaultPrimaryModel: process.env.DEFAULT_PRIMARY_MODEL || "gemini-2.5-flash",
    defaultFallbackModels: splitCsv(process.env.DEFAULT_FALLBACK_MODELS),
    defaultVerifierModel: process.env.DEFAULT_VERIFIER_MODEL || "",
    allowedOrigins: splitCsv(process.env.ALLOWED_ORIGINS),
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 45000)
};
