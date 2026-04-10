import cors from "cors";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import { z } from "zod";
import { config } from "./config.js";
import { completeWithFailover, mergeCriterionDecision, verifyWithSecondModel } from "./orchestrator.js";
import {
    buildBriefScanPrompts,
    buildCriterionPrompts,
    buildRubricPrompts,
    buildVerificationPrompts
} from "./prompts.js";

const app = express();

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
});
app.use(pinoHttp({
    redact: ["req.headers.authorization", "req.body"]
}));
app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false
}));
app.use(cors({
    origin(origin, callback) {
        if (!origin || config.allowedOrigins.includes(origin) || config.allowedOrigins.includes("null")) {
            callback(null, true);
            return;
        }
        callback(new Error("Origin not allowed by backend policy."));
    }
}));

const strategySchema = z.object({
    primaryModel: z.string().optional(),
    fallbackModels: z.array(z.string()).optional(),
    verifierModel: z.string().optional(),
    crossCheck: z.boolean().optional()
}).optional();

const briefSchema = z.object({
    qualificationLabel: z.string().optional(),
    briefText: z.string().min(20),
    detectedCodes: z.array(z.string()).default([]),
    strategy: strategySchema
});

const criterionSchema = z.object({
    qualificationLabel: z.string().optional(),
    unitInfo: z.string().optional(),
    watchouts: z.string().optional(),
    learnerText: z.string().min(20),
    criterion: z.object({
        code: z.string().min(1),
        requirement: z.string().min(1)
    }),
    strategy: strategySchema
});

const rubricSchema = z.object({
    qualificationLabel: z.string().optional(),
    assignmentText: z.string().min(20),
    strategy: strategySchema
});

app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        configured: Boolean(config.geminiApiKey),
        defaults: {
            primaryModel: config.defaultPrimaryModel,
            fallbackModels: config.defaultFallbackModels,
            verifierModel: config.defaultVerifierModel
        }
    });
});

app.get("/api/models", (_req, res) => {
    res.json({
        primaryModel: config.defaultPrimaryModel,
        fallbackModels: config.defaultFallbackModels,
        verifierModel: config.defaultVerifierModel
    });
});

app.post("/api/brief/scan", async (req, res, next) => {
    try {
        const payload = briefSchema.parse(req.body);
        const prompts = buildBriefScanPrompts({
            briefText: payload.briefText,
            detectedCodes: payload.detectedCodes
        });

        const completion = await completeWithFailover({
            ...prompts,
            strategy: payload.strategy
        });

        res.json({
            result: JSON.parse(completion.text),
            meta: {
                modelUsed: completion.modelUsed,
                trace: completion.trace
            }
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/grade/criterion", async (req, res, next) => {
    try {
        const payload = criterionSchema.parse(req.body);
        const prompts = buildCriterionPrompts(payload);
        const primary = await completeWithFailover({
            ...prompts,
            strategy: payload.strategy
        });
        const primaryParsed = JSON.parse(primary.text);

        const verificationPrompts = buildVerificationPrompts({
            criterion: payload.criterion,
            primaryResult: primaryParsed,
            learnerText: payload.learnerText,
            unitInfo: payload.unitInfo,
            watchouts: payload.watchouts,
            qualificationLabel: payload.qualificationLabel
        });

        const verification = await verifyWithSecondModel({
            ...verificationPrompts,
            strategy: payload.strategy
        });

        const verificationParsed = verification ? JSON.parse(verification.text) : null;
        const merged = mergeCriterionDecision(primaryParsed, verificationParsed);

        res.json({
            result: merged.final,
            moderation: merged.moderation,
            meta: {
                modelUsed: primary.modelUsed,
                trace: primary.trace,
                verificationModelUsed: verification?.modelUsed || null,
                verificationTrace: verification?.trace || []
            }
        });
    } catch (error) {
        next(error);
    }
});

app.post("/api/rubrics/generate", async (req, res, next) => {
    try {
        const payload = rubricSchema.parse(req.body);
        const prompts = buildRubricPrompts(payload);
        const completion = await completeWithFailover({
            ...prompts,
            strategy: payload.strategy
        });

        res.json({
            result: JSON.parse(completion.text),
            meta: {
                modelUsed: completion.modelUsed,
                trace: completion.trace
            }
        });
    } catch (error) {
        next(error);
    }
});

app.use((error, _req, res, _next) => {
    const isValidationError = error instanceof z.ZodError;
    const status = isValidationError ? 400 : 500;
    res.status(status).json({
        error: isValidationError ? "Invalid request body." : error.message || "Unexpected backend error.",
        details: isValidationError ? error.flatten() : undefined
    });
});

app.listen(config.port, () => {
    console.log(`MGTS backend listening on http://localhost:${config.port}`);
});
