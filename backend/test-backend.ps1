$baseUrl = "http://localhost:4000"

Write-Host "Checking health..."
Invoke-RestMethod -Method Get -Uri "$baseUrl/health"

$criterionBody = @{
    qualificationLabel = "BTEC Level 3 / 4 / 5"
    unitInfo = "Unit 1 Example"
    watchouts = "Require substantial evidence, not a brief mention."
    learnerText = @"
[Page 1] The learner explains the core principles of health and safety in a workshop environment, including risk assessment, PPE use, and reporting procedures. The discussion gives examples of why each control matters in practice.

[Page 2] The learner analyses how poor housekeeping increases accident risk by creating trip hazards and obstructing emergency routes. The learner compares proactive and reactive safety controls and justifies why regular monitoring reduces incident likelihood.
"@
    criterion = @{
        code = "P1"
        requirement = "Explain the principles of health and safety practice in the workshop."
    }
    strategy = @{
        primaryModel = "gemini-2.5-flash"
        fallbackModels = @("gemini-2.5-flash-lite", "gemini-2.5-pro")
        verifierModel = "gemini-2.5-pro"
        crossCheck = $true
    }
} | ConvertTo-Json -Depth 6

Write-Host "`nTesting criterion grading..."
Invoke-RestMethod -Method Post -Uri "$baseUrl/api/grade/criterion" -ContentType "application/json" -Body $criterionBody
