# MGTS BTEC Evidence Hub

Evidence-led BTEC assessment tooling with two delivery paths:

- `apps/lite`
  Immediate-use local browser version for workflow testing and drafting.
- `apps/full`
  Frontend for the hosted path, designed to call the backend rather than Gemini directly.
- `backend`
  Node/Express orchestration layer that keeps the API key server-side, retries transient failures, and supports verifier-model cross-checking.

## Project Structure

```text
.
|-- apps/
|   |-- full/
|   |   `-- index.html
|   `-- lite/
|       `-- index.html
|-- backend/
|   |-- src/
|   |-- .env.example
|   |-- package.json
|   `-- README.md
|-- docs/
|   `-- HOSTING.md
|-- index.html
|-- .gitignore
|-- README.md
|-- render.yaml
`-- vercel.json
```

## Which Version To Use

### Lite

Use this when you need something running immediately on your own machine.

Good for:
- prompt tuning
- workflow testing
- local assessor drafting

Not ideal for:
- hosted delivery
- secure secret handling
- formal Pearson-facing release workflows

### Full

Use this as the real build path.

Good for:
- server-side API key control
- central model failover
- verifier model cross-checking
- progression toward audit, approval, and IV workflow

## Local Run

### Lite

Serve the repo root over HTTP:

```powershell
cd "C:\Users\Admin\Documents\New project"
python -m http.server 8080
```

Open:

- `http://localhost:8080/apps/lite/index.html`

### Full

Start the backend:

```powershell
cd "C:\Users\Admin\Documents\New project\backend"
Copy-Item .env.example .env
notepad .env
npm install
npm run dev
```

In a second terminal:

```powershell
cd "C:\Users\Admin\Documents\New project"
python -m http.server 8080
```

Open:

- `http://localhost:8080/apps/full/index.html`

Then set the backend URL in the UI to:

- `http://localhost:4000`

## Hosting Strategy

- Host the static frontend from the repo root on Vercel or Netlify.
- Host the backend separately on Render, Railway, Azure App Service, or another controlled Node platform.
- Set backend `ALLOWED_ORIGINS` to the real frontend domain.
- Keep all API secrets in backend environment variables only.

See [docs/HOSTING.md](docs/HOSTING.md) for the full deployment guide.

## Production Direction

The full version is the correct route for:

- assessor review states
- IV sampling states
- audit trail
- controlled release
- hosted access
- GDPR-centred secret handling

The current repo is a strong foundation, but still needs authentication, data storage, approval workflow, retention controls, and release logging before it should be treated as a production Pearson-defensible platform.
