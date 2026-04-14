function tidy(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isSecureStatus(decision = "") {
  return String(decision).trim() === "Achieved";
}

export function buildCriterionActionPlan({
  decision = "Review Required",
  action = "",
  criterionCode = "This criterion",
  criterionRequirement = "",
  confidenceScore = 60
} = {}) {
  const cleanedAction = tidy(action);
  const code = tidy(criterionCode) || "This criterion";
  const requirement = tidy(criterionRequirement);
  const confidence = Math.max(0, Math.min(100, Number(confidenceScore) || 60));
  const thresholdHint = requirement
    ? `Threshold check: ensure your evidence explicitly meets "${requirement}".`
    : "Threshold check: ensure your evidence is explicit, detailed, and directly mapped to the criterion wording.";

  const consolidationStep = isSecureStatus(decision)
    ? `Next step: consolidate ${code} by adding one clearer example, justification, or evaluative point that deepens quality rather than repeating description.`
    : `Next step: strengthen ${code} by expanding evidence depth and directly linking each key point to the command verb in the criterion.`;

  const stretchStep = confidence >= 85
    ? "Pathway to improve: refine structure and precision so your strongest points are easier to verify quickly at assessor review."
    : "Pathway to improve: add sharper analysis, clearer justification, and explicit signposting so the evidence moves securely beyond the threshold.";

  if (!cleanedAction) {
    return `${consolidationStep} ${thresholdHint} ${stretchStep}`.trim();
  }

  return `${cleanedAction} ${thresholdHint} ${stretchStep}`.trim();
}
