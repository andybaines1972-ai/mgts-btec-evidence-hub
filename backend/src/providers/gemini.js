import { config } from "../config.js";

function shouldRetry(statusCode) {
    return statusCode === 429 || statusCode >= 500;
}

export async function callGemini({ model, system, user, schema }) {
    if (!config.geminiApiKey) {
        throw new Error("GEMINI_API_KEY is not configured.");
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            signal: controller.signal,
            body: JSON.stringify({
                systemInstruction: {
                    parts: [{ text: system }]
                },
                contents: [
                    {
                        parts: [{ text: user }]
                    }
                ],
                generationConfig: {
                    temperature: 0,
                    topP: 0.1,
                    topK: 1,
                    maxOutputTokens: 4096,
                    responseMimeType: "application/json",
                    responseSchema: schema || undefined
                }
            })
        });

        const data = await response.json();
        if (!response.ok || data.error) {
            const error = new Error(data.error?.message || `Gemini request failed with ${response.status}`);
            error.statusCode = response.status;
            error.retryable = shouldRetry(response.status);
            throw error;
        }

        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
            const error = new Error("Gemini returned an empty response.");
            error.retryable = true;
            throw error;
        }

        return {
            text,
            model
        };
    } finally {
        clearTimeout(timeout);
    }
}
