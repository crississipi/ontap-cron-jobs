# OnTap Cron Jobs

Dedicated Next.js worker that hosts OnTap scheduled jobs under `/api/cron/*`.

This service connects to the **same** MySQL databases as `ontapnewsystem` and only exposes cron endpoints protected by `CRON_SECRET`. The original cron routes in `ontapnewsystem` are left untouched (duplicate copies).

## Security

- Every `/api/cron/*` route requires `Authorization: Bearer <CRON_SECRET>` (or `x-cron-secret`).
- If `CRON_SECRET` is missing, routes return `503` (`CRON_SECRET_MISSING`) — no open endpoints.
- Optional `CRON_ALLOWED_USER_AGENTS` further restricts callers (e.g. `cron-job.org`).
- Middleware returns `404` for any non-cron `/api/*` path.
- No login, admin UI, or public database APIs are exposed.

## Setup

```bash
cp .env.example .env.local
# fill in NEWDATABASE_URL, NEWANALYTICS_DATABASE_URL, CRON_SECRET, SMTP_*, FRONTEND_URL, etc.

npm install
npm run db:generate
npm run dev
```

Production:

```bash
npm run build
npm start
```

## Calling a job

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://YOUR_CRON_DOMAIN/api/cron/process-email-queue"
```

## Endpoints

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/cron/mail-queue` | **Preferred** alias (avoids Hostinger WAF false positives on `email`) |
| GET | `/api/cron/process-email-queue` | Same handler as `mail-queue` |
| GET | `/api/cron/retry-failed-emails` | |
| GET | `/api/cron/reset-email-counts` | |
| GET | `/api/cron/send-daily-digests` | |
| GET | `/api/cron/send-weekly-digests` | |
| GET | `/api/cron/send-scheduled-newsletters` | |
| GET | `/api/cron/subscription-expiry` | |
| GET | `/api/cron/order-feedback-requests` | |
| GET | `/api/cron/superadmin-user-report` | |
| GET | `/api/cron/superadmin-inactive-users` | |
| GET | `/api/cron/qr-queue` | **Preferred** alias for QR flush |
| GET | `/api/cron/process-qr-queue` | Same handler as `qr-queue` |
| GET | `/api/cron/init-subscription-system` | |
| GET | `/api/cron/cleanup-webhook-events` | |
| GET | `/api/cron/cleanup-checkout-sessions` | |
| GET | `/api/cron/cleanup-notifications` | |
| GET | `/api/cron/cleanup` | |
| GET | `/api/cron/company-daily-summary` | |
| GET | `/api/cron/company-weekly-summary` | |
| GET | `/api/cron/company-top-performer-alert` | |
| GET | `/api/cron/trial-experience-followup` | |
| GET | `/api/cron/bizcard-daily-report` | |
| POST | `/api/cron/abandoned-cart` | POST only |
| POST | `/api/cron/promos/update-status` | POST only |

## Hostinger notes

- Deploy as a separate Node.js app (same Hostinger plan / VPS as needed).
- Point external schedulers at this domain’s `/api/cron/*` URLs.
- Use small Prisma `connection_limit` values already baked into the DB clients (Hostinger-friendly).
- Do **not** run Prisma migrations from this app; it only generates clients against existing schemas.

### Troubleshooting `403 Forbidden` on cron-job.org

This app’s cron auth returns **`401`** (JSON with `code: CRON_UNAUTHORIZED` or `CRON_UA_REJECTED`), never **`403`**.

If cron-job.org shows **403**, the response is usually from **Hostinger ModSecurity / Imunify360**, not from `CRON_SECRET` mismatch:

1. Prefer WAF-safe URLs: `/api/cron/mail-queue` and `/api/cron/qr-queue`.
2. Confirm every job sends header `Authorization: Bearer <CRON_SECRET>` **and** (if set) a User-Agent containing `cron-job.org` when `CRON_ALLOWED_USER_AGENTS=cron-job.org`.
3. In Hostinger → Security → open ModSecurity / Imunify logs for the blocked request; whitelist the path or disable the false-positive rule.
4. Open the saved response body: HTML “Forbidden” = host WAF; JSON with `[CRON_AUTH]` = app auth (should be 401).

## Env

See [`.env.example`](.env.example) for required keys. Never commit real secrets.
