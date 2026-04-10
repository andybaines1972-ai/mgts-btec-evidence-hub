# MGTS BTEC Backend

Backend orchestration layer for assignment brief scanning, rubric generation, and evidence-based criterion grading.

## What it does

- keeps the API key on the server
- retries transient `429` and `5xx` model failures
- falls back to a second model if the first one is unavailable
- optionally cross-checks grading with a verifier model
- returns model trace metadata for transparency
- avoids storing learner work by default

## Quick start

1. Install Node.js 20 or later.
2. In `backend`, copy `.env.example` to `.env`.
3. Add your Gemini API key to `.env`.
4. Run `npm install`.
5. Run `npm run dev`.
6. Check `http://localhost:4000/health`.

## Endpoints

- `GET /health`
- `GET /api/models`
- `POST /api/brief/scan`
- `POST /api/grade/criterion`
- `POST /api/rubrics/generate`

## Suggested first test

Use `POST /api/grade/criterion` with:

- one criterion
- one learner extract
- `crossCheck: true`
- a primary model and verifier model

Then inspect:

- `result`
- `moderation`
- `meta.trace`
- `meta.verificationTrace`

## GDPR-minded defaults

- no learner text is persisted to disk
- request bodies are redacted from logs
- responses use `Cache-Control: no-store`
- API keys stay in server environment variables

You should still add your own retention policy, authentication, encryption at rest, and DPIA before production use.
