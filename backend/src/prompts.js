export function buildBriefScanPrompts({ briefText, detectedCodes }) {
    const system = [
        "You are a curriculum analyst preparing a BTEC grading sheet.",
        "The qualification scope is BTEC Levels 3, 4, and 5, but do not invent criteria or grading logic.",
        "Extract only real assessment criteria from the assignment brief.",
        "Map each criterion code to its exact learner requirement.",
        "If rubric cues or command verbs are present, preserve them precisely.",
        "Do not summarise loosely. Keep each requirement precise and assessor-friendly."
    ].join("\n");

    const user = [
        `Detected criteria codes: ${detectedCodes.join(", ")}`,
        "",
        "Assignment brief extract:",
        briefText.slice(0, 70000)
    ].join("\n");

    const schema = {
        type: "OBJECT",
        properties: {
            unit_title: { type: "STRING" },
            criteria: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: {
                        code: { type: "STRING" },
                        requirement: { type: "STRING" }
                    },
                    required: ["code", "requirement"]
                }
            },
            rubric_notes: { type: "STRING" }
        },
        required: ["criteria"]
    };

    return { system, user, schema };
}

export function buildCriterionPrompts({ unitInfo, watchouts, criterion, learnerText, qualificationLabel }) {
    const system = [
        `You are an experienced assessor for ${qualificationLabel || "BTEC"}.`,
        "Evaluate one criterion only. Base the decision on direct evidence from the learner submission.",
        "Rules:",
        "- Achieved: clear, substantial, and directly relevant evidence meets the criterion requirement in enough depth.",
        "- Not Yet Achieved: the evidence is absent, too thin, too brief, too descriptive for the command verb, off-task, or only mentioned without development.",
        "- Review Required: some evidence appears relevant but certainty is not high enough for release.",
        "- A heading, bullet list, sentence fragment, or passing mention is NOT enough to achieve a criterion.",
        "- Evidence must show developed content behind the criterion, not just a statement that the learner has touched on it.",
        "- For higher-level criteria, reject simple description when the verb requires analysis, justification, comparison, critique, or evaluation.",
        "- Always provide a page reference. Use the page labels exactly as they appear in the supplied extract.",
        "- In evidence_and_depth, explain in detail what the learner actually covers, quote short phrases where useful, and state whether the coverage is substantial, limited, or insufficient.",
        "- confidence_score must be a whole number from 0 to 100, where high confidence means the evidence is explicit and secure enough for assessor release.",
        "- Keep rationale concise but academically firm.",
        "- Keep action specific enough for a learner resubmission, but do not write the answer for them."
    ].join("\n");

    const user = [
        `Unit: ${unitInfo || "Not provided"}`,
        `Assessor watchouts: ${watchouts || "None"}`,
        `Criterion code: ${criterion.code}`,
        `Criterion requirement: ${criterion.requirement}`,
        "",
        "Learner submission extract:",
        learnerText
    ].join("\n");

    const schema = {
        type: "OBJECT",
        properties: {
            learner_name: { type: "STRING" },
            decision: { type: "STRING", enum: ["Achieved", "Not Yet Achieved", "Review Required"] },
            confidence_score: { type: "NUMBER" },
            evidence_page: { type: "STRING" },
            evidence_and_depth: { type: "STRING" },
            rationale: { type: "STRING" },
            action: { type: "STRING" }
        },
        required: ["learner_name", "decision", "confidence_score", "evidence_page", "evidence_and_depth", "rationale", "action"]
    };

    return { system, user, schema };
}

export function buildVerificationPrompts({ criterion, primaryResult, learnerText, unitInfo, watchouts, qualificationLabel }) {
    const system = [
        `You are a second independent assessor for ${qualificationLabel || "BTEC"}.`,
        "Review another model's grading decision for one criterion.",
        "You are not allowed to defer blindly to the first decision.",
        "Check whether the evidence is substantial enough to support the decision.",
        "If the first decision is too generous or too harsh, correct it.",
        "Be explicit about whether you agree, partly agree, or disagree."
    ].join("\n");

    const user = [
        `Unit: ${unitInfo || "Not provided"}`,
        `Assessor watchouts: ${watchouts || "None"}`,
        `Criterion code: ${criterion.code}`,
        `Criterion requirement: ${criterion.requirement}`,
        "",
        "Primary model result:",
        JSON.stringify(primaryResult, null, 2),
        "",
        "Learner submission extract:",
        learnerText
    ].join("\n");

    const schema = {
        type: "OBJECT",
        properties: {
            agreement: { type: "STRING", enum: ["agree", "partial", "disagree"] },
            reviewed_decision: { type: "STRING", enum: ["Achieved", "Not Yet Achieved", "Review Required"] },
            reviewed_evidence_page: { type: "STRING" },
            reviewed_evidence_and_depth: { type: "STRING" },
            reviewed_rationale: { type: "STRING" },
            reviewed_action: { type: "STRING" },
            issues: {
                type: "ARRAY",
                items: { type: "STRING" }
            },
            summary: { type: "STRING" }
        },
        required: [
            "agreement",
            "reviewed_decision",
            "reviewed_evidence_page",
            "reviewed_evidence_and_depth",
            "reviewed_rationale",
            "reviewed_action",
            "issues",
            "summary"
        ]
    };

    return { system, user, schema };
}

export function buildRubricPrompts({ assignmentText, qualificationLabel }) {
    const system = [
        `You are an assessor designing a rubric for ${qualificationLabel || "BTEC"}.`,
        "Create a practical assessment rubric from an assignment brief.",
        "Preserve the official criteria where present.",
        "Add clear evidence expectations, command verbs, and markers of insufficient depth.",
        "Return structured, teacher-ready rubric rows."
    ].join("\n");

    const user = [
        "Assignment brief extract:",
        assignmentText.slice(0, 70000)
    ].join("\n");

    const schema = {
        type: "OBJECT",
        properties: {
            rubric_title: { type: "STRING" },
            rows: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: {
                        criterion_code: { type: "STRING" },
                        criterion_requirement: { type: "STRING" },
                        expected_evidence: { type: "STRING" },
                        depth_expectation: { type: "STRING" },
                        insufficiency_flags: { type: "STRING" }
                    },
                    required: [
                        "criterion_code",
                        "criterion_requirement",
                        "expected_evidence",
                        "depth_expectation",
                        "insufficiency_flags"
                    ]
                }
            }
        },
        required: ["rows"]
    };

    return { system, user, schema };
}
