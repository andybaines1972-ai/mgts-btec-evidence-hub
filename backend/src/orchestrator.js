import { config } from "./config.js";
import { callGemini } from "./providers/gemini.js";

const retryDelays = [1200, 2600, 5000];

function normaliseStrategy(strategy = {}) {
    return {
        primaryModel: strategy.primaryModel || config.defaultPrimaryModel,
        fallbackModels: Array.isArray(strategy.fallbackModels) && strategy.fallbackModels.length
            ? strategy.fallbackModels
            : config.defaultFallbackModels,
        verifierModel: strategy.verifierModel || config.defaultVerifierModel,
        crossCheck: Boolean(strategy.crossCheck)
    };
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function completeWithFailover({ system, user, schema, strategy }) {
    const resolved = normaliseStrategy(strategy);
    const modelQueue = [resolved.primaryModel, ...resolved.fallbackModels.filter((model) => model !== resolved.primaryModel)];
    const trace = [];

    for (const model of modelQueue) {
        let lastError = null;

        for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
            try {
                const result = await callGemini({ model, system, user, schema });
                trace.push({
                    stage: "completion",
                    model,
                    attempt: attempt + 1,
                    outcome: "success"
                });
                return {
                    text: result.text,
                    modelUsed: model,
                    trace,
                    strategy: resolved
                };
            } catch (error) {
                lastError = error;
                trace.push({
                    stage: "completion",
                    model,
                    attempt: attempt + 1,
                    outcome: "failure",
                    retryable: Boolean(error.retryable),
                    message: error.message
                });

                if (!error.retryable || attempt === retryDelays.length) {
                    break;
                }

                await wait(retryDelays[attempt]);
            }
        }

        if (!lastError?.retryable) {
            break;
        }
    }

    const finalError = trace[trace.length - 1]?.message || "No model completed successfully.";
    throw new Error(finalError);
}

export async function verifyWithSecondModel({ system, user, schema, strategy }) {
    const resolved = normaliseStrategy(strategy);
    if (!resolved.crossCheck || !resolved.verifierModel) {
        return null;
    }

    const result = await completeWithFailover({
        system,
        user,
        schema,
        strategy: {
            primaryModel: resolved.verifierModel,
            fallbackModels: resolved.fallbackModels.filter((model) => model !== resolved.verifierModel),
            crossCheck: false
        }
    });

    return {
        ...result,
        verifierModel: resolved.verifierModel
    };
}

export function mergeCriterionDecision(primaryParsed, verificationParsed) {
    if (!verificationParsed) {
        return {
            final: primaryParsed,
            moderation: null
        };
    }

    const moderation = {
        agreement: verificationParsed.agreement,
        issues: verificationParsed.issues,
        summary: verificationParsed.summary
    };

    if (verificationParsed.agreement === "agree") {
        return {
            final: {
                ...primaryParsed
            },
            moderation
        };
    }

    return {
        final: {
            learner_name: primaryParsed.learner_name,
            decision: "Review Required",
            confidence_score: Math.min(
                Number(primaryParsed.confidence_score || 55),
                55
            ),
            evidence_page: verificationParsed.reviewed_evidence_page || primaryParsed.evidence_page,
            evidence_and_depth: verificationParsed.reviewed_evidence_and_depth || primaryParsed.evidence_and_depth,
            rationale: verificationParsed.reviewed_rationale || primaryParsed.rationale,
            action: verificationParsed.reviewed_action || primaryParsed.action
        },
        moderation
    };
}
