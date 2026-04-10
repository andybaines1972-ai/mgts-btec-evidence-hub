# MGTS BTEC Evidence Hub Hosting Guide

## Repo Layout

- `apps/lite/index.html`
  Immediate-use browser version.
- `apps/full/index.html`
  Frontend for the hosted path.
- `backend/`
  Node/Express orchestration API.
- `index.html`
  Root launcher page.

## Local Run

### Backend

```powershell
cd "C:\Users\Admin\Documents\New project\backend"
Copy-Item .env.example .env
notepad .env
npm install
npm run dev
```

Set at least:
- `GEMINI_API_KEY`
- `ALLOWED_ORIGINS`

Check:
- `http://localhost:4000/health`

### Frontend

```powershell
cd "C:\Users\Admin\Documents\New project"
python -m http.server 8080
```

Open:
- `http://localhost:8080/`
- `http://localhost:8080/apps/lite/index.html`
- `http://localhost:8080/apps/full/index.html`

## Full Version Settings

In `apps/full/index.html`, use:
- Backend base URL: `http://localhost:4000`
- Primary model: `gemini-2.5-flash`
- Fallback model: `gemini-1.5-flash`
- Verifier model: `gemini-2.5-pro`

## Recommended Hosting Setup

### Frontend

Host the static frontend from the repo root on:
- Vercel
- Netlify
- Azure Static Web Apps

This serves:
- `/`
- `/apps/lite/index.html`
- `/apps/full/index.html`

### Backend

Host the backend separately on:
- Render
- Railway
- Azure App Service
- another managed Node host

The repo now includes `render.yaml` for a simple Render deployment baseline.

## Example Hosted Architecture

### Frontend

- Domain: `https://mgts-btec-evidence-hub.vercel.app`

### Backend

- Domain: `https://mgts-btec-evidence-hub-api.onrender.com`

### Backend environment variables

- `GEMINI_API_KEY`
- `DEFAULT_PRIMARY_MODEL=gemini-2.5-flash`
- `DEFAULT_FALLBACK_MODELS=gemini-1.5-flash`
- `DEFAULT_VERIFIER_MODEL=gemini-2.5-pro`
- `REQUEST_TIMEOUT_MS=45000`
- `ALLOWED_ORIGINS=https://mgts-btec-evidence-hub.vercel.app`

## Vercel Frontend Setup

1. Import the GitHub repo into Vercel.
2. Choose the repo root as the project root.
3. Framework preset:
   `Other`
4. Build command:
   leave empty
5. Output directory:
   leave empty
6. Deploy.

Because the site is static HTML, Vercel can serve it directly.

## Render Backend Setup

1. Create a new Web Service in Render from this GitHub repo.
2. Root directory:
   `backend`
3. Build command:
   `npm install`
4. Start command:
   `npm start`
5. Add the environment variables listed above.
6. Deploy and verify `/health`.

## After Hosting

Update `apps/full/index.html` in the hosted UI to point at the real backend URL.

For a stronger production version, the next steps are:
- authentication
- role permissions
- data storage
- audit trail
- assessor and IV approval states
- retention and deletion controls
- privacy notice and centre workflow integration
