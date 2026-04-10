# MGTS BTEC Backend

Backend orchestration layer for the hosted `full` version of the MGTS BTEC Evidence Hub.

## Responsibilities

- keep the Gemini API key server-side
- retry transient `429` and `5xx` model failures
- fall back to a second model if the first one is unavailable
- optionally cross-check criterion grading with a verifier model
- return trace metadata for moderation visibility
- avoid persisting learner text by default

## Quick Start

```powershell
cd "C:\Users\Admin\Documents\New project\backend"
Copy-Item .env.example .env
notepad .env
npm install
npm run dev
```

Check:

- `http://localhost:4000/health`

## Endpoints

- `GET /health`
- `GET /api/models`
- `POST /api/brief/scan`
- `POST /api/grade/criterion`
- `POST /api/rubrics/generate`

## Environment Variables

- `PORT`
- `ALLOWED_ORIGINS`
- `GEMINI_API_KEY`
- `DEFAULT_PRIMARY_MODEL`
- `DEFAULT_FALLBACK_MODELS`
- `DEFAULT_VERIFIER_MODEL`
- `REQUEST_TIMEOUT_MS`

## Production Notes

This backend is a strong base for the hosted version, but a full production release should still add:

- authentication
- role permissions
- database-backed audit trail
- release workflow states
- retention and deletion controls
- centre governance and DPIA processes

See `../docs/HOSTING.md` for the full deployment path.
