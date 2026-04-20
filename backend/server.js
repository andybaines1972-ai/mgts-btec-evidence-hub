require('dotenv').config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Set up memory storage for files (limit to 20MB for inline Gemini API processing)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const SCAN_MODELS = (process.env.GEMINI_SCAN_MODELS |

| "gemini-2.5-flash,gemini-1.5-flash").split(",").map(s => s.trim()).filter(Boolean);
const GRADE_MODELS = (process.env.GEMINI_GRADE_MODELS |

| "gemini-2.5-pro,gemini-1.5-pro").split(",").map(s => s.trim()).filter(Boolean);
const RETRIES = Number(process.env.GEMINI_RETRIES |

| 3);

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

const jsonResponse = (res, status, data) => res.status(status).json(data);

function extractJson(text) {
    let cleaned = text.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    else if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    return JSON.parse(cleaned);
}

async function callGemini(systemInstruction, parts, models) {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is missing.");
    
    let lastErr = null;
    for (const model of models) {
        for (let attempt = 0; attempt < RETRIES; attempt++) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
                
                const payload = {
                    contents: [{ role: "user", parts: parts }],
                    systemInstruction: { parts: [{ text: systemInstruction }] },
                    generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
                };

                const res = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });

                if (!res.ok) throw new Error(`Gemini API Error: ${await res.text()}`);
                const data = await res.json();
                return extractJson(data.candidates.content.parts.text);
            } catch (err) {
                lastErr = err;
                await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
            }
        }
    }
    throw lastErr;
}

app.post("/api/scan-brief", async (req, res) => {
    try {
        const { briefText } = req.body;
        const sysPrompt = `Extract ALL BTEC grading criteria (Pass, Merit, Distinction). Return ONLY a valid JSON array: [{"code": "P1", "description": "..."}]`;
        const criteria = await callGemini(sysPrompt,, SCAN_MODELS);
        return jsonResponse(res, 200, { criteria });
    } catch (err) {
        return jsonResponse(res, 500, { error: err.message });
    }
});

app.post("/api/generate-feedback", upload.single('studentFile'), async (req, res) => {
    try {
        const criteria = JSON.parse(req.body.criteria |

| "");
        const studentWork = req.body.studentWork |

| "";
        const file = req.file;

        if (criteria.length === 0 |

| (!studentWork &&!file)) {
            return jsonResponse(res, 400, { error: "Criteria and student evidence are required." });
        }

        const sysPrompt = `You are an expert BTEC Assessor for Levels 3, 4, and 5.
Evaluate the student's work against the provided criteria.
Output MUST be a valid JSON object:
{
  "criteriaEvaluation": [
    { 
      "code": "P1", 
      "status": "Met" | "Not Met", 
      "feedback": "Objective justification...",
      "citation": "Exact quote or specific description of the diagram from the student's work that justifies this decision."
    }
  ],
  "overallStrengths": "Summary...",
  "overallImprovements": "Summary..."
}`;

        let promptParts =;
        
        if (studentWork) {
            promptParts.push({ text: `Criteria:\n${JSON.stringify(criteria)}\n\nStudent Work Text:\n${studentWork}` });
        } else {
            promptParts.push({ text: `Criteria:\n${JSON.stringify(criteria)}\n\nStudent Work is attached as a file.` });
        }
        
        // Pass file as inline base64 data for Gemini Multimodal Vision
        if (file) {
            promptParts.push({
                inlineData: {
                    mimeType: file.mimetype,
                    data: file.buffer.toString("base64")
                }
            });
        }

        const feedback = await callGemini(sysPrompt, promptParts, GRADE_MODELS);
        
        // Log to Supabase Audit Trail
        if (supabase) {
            const token = req.headers.authorization?.replace("Bearer ", "");
            if (token) {
                const { data: { user } } = await supabase.auth.getUser(token);
                if (user) {
                    await supabase.from("audit_events").insert([{
                        user_id: user.id,
                        action: 'generate_feedback',
                        details: { criteria_evaluated: criteria.length }
                    }]);
                }
            }
        }

        return jsonResponse(res, 200, { feedback });
    } catch (err) {
        console.error(err);
        return jsonResponse(res, 500, { error: err.message });
    }
});

const PORT = process.env.PORT |

| 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
