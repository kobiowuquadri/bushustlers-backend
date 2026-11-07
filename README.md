# Bushustlers API

Express + TypeScript + Sequelize (MySQL) backend for Bushustlers: payment links, buyer checkout, provider-verified payment status, reconciliation and settlement records for small businesses. The frontend lives in `../bushustler`.

**Send a link. Confirm the payment. Fulfil the order.** An order only becomes *Paid* when the backend has confirmed the payment with the provider and the status, amount, currency and reference all match.

## Run it

Requirements: Node 20+, a MySQL 8 database.

```bash
npm install
cp .env.example .env          # fill in DB_*, SECRET_KEY (32+ chars), FRONTEND_URL; see comments
npm run db:migrate            # additive migrations (or set DB_MIGRATE_ON_START=true)
npm run dev                   # http://localhost:5000  (nodemon + tsx)
```

Optional demo data for **Amaka Clothing** (fictional people; refuses to run in production, only with the demo provider, and only when you name the database explicitly):

```bash
npm run db:seed:dev -- --confirm=<DB_NAME>
# sign in as amaka@example.com / Amaka-Demo-104!  (override with SEED_DEMO_PASSWORD)
```

Build and run compiled code: `npm run build && npm start`. Type check: `npm run typecheck`.

### Tests

`npm test` runs 44 integration tests (auth, CSRF, merchant isolation, orders, links, checkout, webhooks, reconciliation, Busha adapter against a fake Busha HTTP server). They need a **disposable local MySQL** and never touch the shared database: the setup refuses anything that is not `localhost` with a database name ending in `_test`, then drops and recreates it.

```bash
docker run -d --name bushustlers-test-db -p 3307:3306 -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=bushustlers_test -e MYSQL_USER=bushustlers -e MYSQL_PASSWORD=local-dev-only mysql:8.0
npm test     # defaults: 127.0.0.1:3307, user bushustlers / local-dev-only; override with TEST_DB_*
```

## Environments

| `APP_ENV` | Use | Notes |
| --- | --- | --- |
| `development` | Your machine | Demo provider by default, dev mailbox when no email provider, relaxed cookies |
| `sandbox` | Hosted test (Render) | Secure `__Host-` cookies, `FRONTEND_URL` required, demo or Busha sandbox only |
| `production` | Live money | Refuses to start unless `PAYMENTS_PROVIDER=busha`, `BUSHA_ENV=production`, explicit `BUSHA_BASE_URL` and `ALLOW_LIVE_PAYMENTS=true` |

Startup validates configuration and refuses to run with missing/invalid values or pending migrations.

## Payments

| Mode | How to enable | What happens |
| --- | --- | --- |
| Demo | `PAYMENTS_PROVIDER=demo` | Clearly fake instructions (`DEMO-` account numbers, `demo-` addresses, labelled demo rate). Merchant-side tools simulate buyer/provider outcomes, delivered as signed notifications through the real webhook → lookup → reconcile pipeline |
| Busha sandbox | `PAYMENTS_PROVIDER=busha`, `BUSHA_ENV=sandbox`, `BUSHA_PUBLIC_KEY`, `BUSHA_SECRET_KEY`, `BUSHA_WEBHOOK_SECRET` | NGN bank transfer: `POST /v1/quotes` (NGN→NGN, `pay_in.type=temporary_bank_account`) then `POST /v1/transfers`; status via `GET /v1/transfers/{id}`. Stablecoin: `POST /v1/payments/requests` (public key, `quote_currency=NGN`, settles to NGN); status via `GET /v1/payments/requests/{id}`. Webhooks verified with `x-bu-signature`. Sandbox deposits can be simulated with `POST /v1/transfers/simulate-deposit` from the transaction page |
| Production | as above with `BUSHA_ENV=production`, `APP_ENV=production`, `ALLOW_LIVE_PAYMENTS=true`, `BUSHA_BASE_URL` | Not exercised. Only after Busha production access and the checks are in place |

Register the webhook URL `https://<api-host>/api/v1/webhooks/busha` in the Busha dashboard (Settings → Developer tools → Webhooks) and copy its secret into `BUSHA_WEBHOOK_SECRET`.

### Correctness rules (enforced in `services/payments/reconciliationService.ts`)

- Financial state changes only through `applyProviderState`, inside one DB transaction with the attempt and order rows locked.
- Webhooks: raw-body HMAC check → stored once (SHA-256 dedupe) → acknowledged → authenticated provider lookup → reconcile. The event body never sets state directly.
- Status only moves forward: a late `pending` never downgrades `confirmed`; repeated events count once.
- Underpayment, overpayment, multiple deposits, late payment (after expiry/closure), currency or reference mismatch → *needs review*. A second genuine payment for a paid order is recorded and flagged, never discarded or double-credited.
- Idempotent payment initiation (`Idempotency-Key`, unique per link), reuse of still-valid instructions, provider calls outside DB transactions.
- A background reconciler retries failed events, polls open payments, closes lapsed instructions, expires links, and watches closed payments for late funds for 48 hours.
- Money: BigInt minor units for naira, exact decimal strings for stablecoins; no floating point.
- Fees (proposed pricing, paid by the business): 1% per verified naira payment capped at ₦1,000; 1.5% per stablecoin checkout. A settlement record (gross, provider fee, platform fee, net) is created on confirmation; it stays *pending* until a payout is recorded (payouts are not automated).

## Email

Emails are **queued** (`email_outbox`) by requests and sent by a background worker (every 5 s) through Brevo (preferred) or Gmail SMTP, with retries (30 s, 2 m, 10 m, 30 m; 5 attempts) and atomic claiming so several API instances never send twice. The rendered HTML is deleted once sent. Without any provider in local development, emails are captured and shown at `http://localhost:3000/dev/mailbox` (loopback connections only; never on a hosted server).

Brevo: the sender must be verified, and if **Security → Authorised IPs** is enabled, the API host's IP must be allowed (or the blocking turned off), otherwise Brevo answers `401 unrecognised IP address`.

## Security notes

HttpOnly session cookies with rotation and reuse detection, double-submit CSRF + Origin checks, CORS limited to `CORS_ORIGIN`, rate limits on auth, email and checkout, request IDs on every response, log redaction of secrets and personal data, generic 500s, optional DB TLS (`DB_SSL`), merchant isolation on every query. `npm audit` reports a moderate `uuid` advisory through Sequelize that affects buffer arguments Bushustlers does not use.

## Deploy (Render)

`render.yaml` builds with `npm install --include=dev && npm run build`, starts `npm start`, health-checks `/health`, runs migrations on start, and sets `APP_ENV=sandbox`. Set the `sync: false` variables in the dashboard: `FRONTEND_URL` (e.g. `https://bushustlers.vercel.app`), `CORS_ORIGIN` (frontend origins, comma-separated), `SECRET_KEY`, `DB_*`, Brevo and Busha keys. Keep `DB_POOL_MAX` low on small hosted MySQL plans.

See [docs/API.md](docs/API.md) for every endpoint.
