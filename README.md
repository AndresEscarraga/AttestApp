# Role Dictionary Review App

Node.js and Express application for the Role Dictionary review process.

The app serves a static frontend, reads source role data from Excel files,
records review submissions in SQLite, and provides admin pages for audit,
activity, and admin user management.

## Main Features

- JWT-based authentication (email + password).
- Local development identity through `DEV_AUTH_EMAIL`.
- Business role review table with approver role assignment.
- Role permissions acknowledgement workflow.
- Role rejection workflow with required rejection reason.
- PDF generation for keep/change/rejection outcomes.
- Admin Log with filters, CSV/PDF export, RITM editing, action details, and rejection reason.
- Activity Log for access, authorization, submission, and RITM events.
- Admin Users page for adding/removing admin email addresses.
- Excel upload from Admin UI for autonomous data maintenance.
- Protected superadmin accounts that cannot be removed.

## Repository Layout

```text
server.js                 Express server and API routes
logStore.js               Submission log persistence (SQLite)
activityStore.js          Application activity persistence (SQLite)
adminUserStore.js         Admin user persistence (SQLite)
dataStore.js              Excel source-data backend (local files)
fileSafety.js             Secure file system utilities
public/                   Frontend pages, scripts, styles, and assets
Reports/                  Excel source files
data/                     SQLite database and runtime data
scripts/                  Utility scripts (sample data generator)
deploy/                   Deployment guides
docs/                     Documentation
Dockerfile                Container image definition
fly.toml                  Fly.io deployment configuration
package.json              Node dependencies and scripts
```

## Local Development

Install dependencies:

```powershell
npm install
```

Generate synthetic sample data:

```powershell
node scripts/generate-sample-data.js
```

Run locally as an admin:

```powershell
npm.cmd run start:local:admin
```

Run locally as an approver:

```powershell
npm.cmd run start:local:approver
```

Open:

```text
http://localhost:3000
```

Local mode uses SQLite persistence under `data/attest.db`.

## Deployment (Fly.io)

See `deploy/README-DEPLOY-FLY.md` for detailed instructions.

Quick start:

```powershell
flyctl launch
flyctl volumes create roledict_data --size 1
flyctl secrets set JWT_SECRET=<your-secret>
flyctl deploy
```

## Runtime Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_STORE` | `local` | Always `local` |
| `REPORTS_DIR` | `./Reports` | Directory for Excel source files |
| `DB_PATH` | `./data/attest.db` | SQLite database path |
| `ROLES_FILE_NAME` | `Roles Approvers.xlsx` | Roles/approvers source file name |
| `TX_FILE_NAME` | `Transactions.xlsx` | Transactions source file name |
| `JWT_SECRET` | (required) | Secret key for JWT token signing |
| `DEV_AUTH_EMAIL` | (dev only) | Override auth email for local development |

## Source Data

The roles/approvers and transactions Excel files are read from the `Reports/`
directory. Administrators can upload updated Excel files directly from the
Admin page UI without needing to redeploy the application.


To upload source files to GCS:

```powershell
gcloud storage cp "Reports/Roles Approvers.xlsx" "gs://YOUR_BUCKET/"
gcloud storage cp "Reports/Transactions.xlsx" "gs://YOUR_BUCKET/"
```

Admins can force a data reload on the current Cloud Run instance with:

```powershell
Invoke-RestMethod "$URL/api/admin/reload-data" -Method POST
```

## Build Context

Cloud Run deploys from the source repo with `gcloud run deploy --source .`.

- `.gcloudignore` controls what is uploaded to Cloud Build.
- `.dockerignore` controls what is copied into the Docker build context.
- The Dockerfile copies only runtime source files, `public/`, and `Reports/`.
- Dependencies are installed inside the image with `npm ci --omit=dev`.
