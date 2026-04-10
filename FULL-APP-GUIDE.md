# MGTS BTEC Evidence Hub: Lite and Full

## Files

- `index-lite.html`
  Immediate-use browser version. Good for local testing and workflow refinement.
- `index-full.html`
  Frontend that calls the backend instead of Gemini directly.
- `backend/`
  Node/Express backend that keeps the API key server-side, retries failures, and can cross-check with a verifier model.
- `START-HERE.html`
  Simple launcher page.

## Version Summary

### Lite

Use this right now when you need a working local tool fast.

What it does:
- runs as a single HTML file
- uses direct browser-to-Gemini calls
- includes confidence badges and collapsible criterion feedback
- is good for controlled local drafting and experimentation

Limits:
- not the final hosted compliance architecture
- API key is handled in the browser
- not the right long-term model for Pearson-facing deployment

### Full

Use this as the route to the real hosted app.

What it does:
- calls your backend instead of Gemini directly
- keeps the Gemini key in server environment variables
- supports primary, fallback, and verifier model strategy
- adds release-control checkboxes before learner processing

## Run The Full Version Locally

### 1. Start the backend

From `backend/`:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set:
- `GEMINI_API_KEY`
- `ALLOWED_ORIGINS`
- any model defaults you want

Then run:

```powershell
cd "C:\Users\Admin\OneDrive - Midland Group Training Services Limited\Documents\New project\backend"
npm install
npm run dev
```

Health check:

```powershell
http://localhost:4000/health
```

### 2. Serve the frontend over HTTP

From the project root:

```powershell
cd "C:\Users\Admin\OneDrive - Midland Group Training Services Limited\Documents\New project"
python -m http.server 8080
```

Open:

- `http://localhost:8080/START-HERE.html`
- then choose `index-full.html`

### 3. Configure the full frontend

In `index-full.html`, set:
- Backend base URL: `http://localhost:4000`
- Primary model: `gemini-2.5-flash`
- Fallback model: `gemini-1.5-flash`
- Verifier model: `gemini-2.5-pro`

Enable cross-checking if you want second-model moderation support.

## Turning It Into A Hosted App

### Phase 1. Hosting baseline

- Host the frontend on Vercel, Netlify, or Azure Static Web Apps.
- Host the backend on Render, Railway, Azure App Service, or a locked-down VM.
- Store secrets only in backend environment variables.
- Restrict CORS to the real frontend domain.
- Use HTTPS only.

### Phase 2. Controls needed for the real release

- add login and role-based access for assessors, IVs, and admins
- store audit records in a database
- track draft, assessor-reviewed, IV-sampled, released, archived states
- log who ran feedback, who approved it, and when
- add retention and deletion controls
- add centre policy wording and privacy notice links
- require human sign-off before exporting or releasing learner-facing feedback

### Phase 3. Pearson-defensible workflow

The target release workflow should be:

1. Upload and parse
2. AI draft generated
3. Assessor review and edit
4. IV sample/review where required
5. Release decision logged
6. Archive with record history

## What Still Needs Building For Production

- authentication
- role permissions
- database and audit trail
- export history
- release approval workflow
- learner/assessor/IV status tracking
- privacy notice and retention implementation
- DPIA and supplier review process outside the codebase

## Practical Recommendation

- Use `index-lite.html` to improve prompts and workflow now.
- Use `index-full.html` plus `backend/` as the active build path.
- Treat the full version as the foundation for the hosted app rather than the finished compliance endpoint.
