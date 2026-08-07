# Deploy Attest to Fly.io

Step-by-step guide to deploy the Attest app to Fly.io (100% free tier, no time limit).

---

## 0. Prerequisites

- [Fly.io account](https://fly.io/app/sign-up) (email + credit card required for verification, **not charged** on free tier)
- [flyctl CLI](https://fly.io/docs/flyctl/install/) installed
- Git repository with the Attest source code

### Install flyctl (Windows, one-time)

```powershell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

Then **close and reopen VS Code** so PowerShell sees `flyctl` on PATH.

Verify:

```powershell
flyctl version
```

---

## 1. First-time setup

### 1.1 Login

```powershell
flyctl auth signup
# or
flyctl auth login
```

### 1.2 Launch the app

From the project root:

```powershell
flyctl launch
```

When prompted:
- App name: `attest` (or choose your own — update `fly.toml` accordingly)
- Region: choose the closest to your users (e.g. `iad` for US East, `lhr` for Europe)
- PostgreSQL: **No** (we use SQLite)
- Redis: **No**
- Deploy now: **No** (we need to set up the volume first)

### 1.3 Create the persistent volume

SQLite needs a persistent volume so data survives deploys and restarts:

```powershell
flyctl volumes create attest_data --size 1 --region iad
```

> `--size 1` = 1 GB (free allowance includes 3 GB). Replace `iad` with your region.

Verify:

```powershell
flyctl volumes list
```

### 1.4 Set secrets

```powershell
flyctl secrets set JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

> This generates a random 64-character hex secret for JWT signing.

---

## 2. Deploy

```powershell
flyctl deploy
```

This builds the Docker image, pushes it to Fly.io's registry, and starts the app.

### 2.1 Check status

```powershell
flyctl status
```

### 2.2 View logs

```powershell
flyctl logs
```

### 2.3 Open in browser

```powershell
flyctl open
```

---

## 3. First-run setup (in the browser)

1. Open the app URL (e.g. `https://attest.fly.dev`)
2. The app will detect no admin users exist
3. Use the **Setup** endpoint to create the first admin:

```powershell
curl -X POST https://YOUR_APP.fly.dev/api/auth/setup `
  -H "Content-Type: application/json" `
  -d '{"email":"admin@yourdomain.com","password":"admin"}'
```

4. Login at `/api/auth/login` to get a JWT token
5. Use the token in the `Authorization: Bearer <token>` header for all API calls
6. Visit the app in the browser — in production mode, you'll need to inject the token

> For production use without IAP, implement a login page in the frontend that stores the JWT token in localStorage and sends it with every request.

---

## 4. Upload Excel data

1. Login as admin
2. Navigate to `/admin.html`
3. Open the **Data Sources (Upload Excel)** panel
4. Drag & drop `Roles Approvers.xlsx` and `Transactions.xlsx`
5. Data is reloaded instantly

---

## 5. Updating the app

```powershell
git pull
flyctl deploy
```

The persistent volume (`/app/data/roledict.db` and `/app/data/reports/`) is preserved across deploys.

---

## 6. Monitoring

```powershell
# App status
flyctl status

# Real-time logs
flyctl logs

# SSH into the running machine
flyctl ssh console

# Check SQLite database
flyctl ssh console -C "sqlite3 /app/data/attest.db '.tables'"
```

---

## 7. Free tier limits

| Resource | Limit | RoleDict usage |
|---|---|---|
| VMs | 3 shared | 1 used |
| RAM per VM | 256 MB | ~100 MB used |
| Storage | 3 GB total | ~1 GB volume |
| Bandwidth | 100 GB/month | Well under limit |
| **Cost** | **$0/month** | ✅ |

---

## 8. Troubleshooting

### Build fails on `better-sqlite3`

Make sure the Dockerfile has `RUN apk add --no-cache python3 make g++` before `npm ci`.

### App starts but can't write to SQLite

Check that the volume is mounted:
```powershell
flyctl ssh console -C "ls -la /app/data/"
```

If missing, verify `fly.toml` has the `[mounts]` section and the volume was created.

### Cold start delay

Fly.io scales to zero on free tier. First request after inactivity takes ~3-5 seconds. Set `auto_stop_machines = false` in `fly.toml` to keep one machine always running (uses free allowance).

---

## 9. Custom domain (optional)

```powershell
flyctl certs create yourdomain.com
```

Then add the CNAME record in your DNS provider pointing to `attestapp.fly.dev`.
