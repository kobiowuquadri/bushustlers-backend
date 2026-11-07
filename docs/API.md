# Bushustlers API

Base path: `/api/v1`. Every response uses the same envelope:

```json
{ "message": "Order created", "success": true, "statusCode": 201, "data": { } }
```

Errors use the same shape with `success: false`. `data.code` is a stable machine-readable code (e.g. `access_expired`, `csrf_failed`, `link_expired`, `provider_unavailable`); validation failures return `422` with `data.errors: [{ field, message }]`; unexpected errors return `500` with `data.requestId` (also sent as the `X-Request-Id` header).

**Money** is always a string: integer minor units (kobo) in fields ending in `Minor` (e.g. `"4500000"` = ₦45,000), or an exact decimal string for stablecoin amounts (e.g. `"30.012345"`). Never parse money as a float.

## Authentication and CSRF

- Sessions use HttpOnly cookies (`bh_access` short-lived JWT, `bh_session` rotating refresh token; `__Host-` prefixed when cookies are secure). Tokens are never returned in response bodies.
- State-changing merchant and auth requests must send `X-CSRF-Token` equal to the readable `bh_csrf` cookie (issued by any `/api/v1` response, or `GET /auth/csrf`), and a browser `Origin` from `CORS_ORIGIN`.
- `401 access_expired` → call `POST /auth/refresh` once, then retry. `401 session_ended`/`unauthenticated` → sign in again.
- Public checkout and webhook routes don't use cookies, so CSRF doesn't apply.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/auth/csrf` | Ensures the CSRF cookie exists |
| POST | `/auth/register` | `{ fullName, email, password }` → session cookies; queues a verification email |
| POST | `/auth/login` | `{ email, password }`; rate limited per IP and per email |
| POST | `/auth/refresh` | Rotates the refresh token (reuse of an old token ends the session) |
| POST | `/auth/logout` | Revokes the current session |
| POST | `/auth/logout-others` | Revokes all other sessions |
| GET / PATCH | `/auth/me` | Profile + onboarding state / update `{ fullName }` |
| POST | `/auth/verify-email` | `{ token }` (single use) |
| POST | `/auth/resend-verification` | Rate limited |
| POST | `/auth/forgot-password` | `{ email }`; same response whether or not the account exists |
| POST | `/auth/reset-password` | `{ token, password }`; signs out every device |
| POST | `/auth/change-password` | `{ currentPassword, newPassword }`; signs out other devices |

## Business (signed in)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/business` | Onboarding: `{ ownerName?, businessName, category, phone?, orderPrefix?, settlementPreference? }` |
| GET | `/business` | Profile, environment (payments mode, capabilities, email delivery), categories |
| PATCH | `/business` | Profile, order prefix, notification toggles |
| GET | `/overview?period=7d\|30d\|90d` | Reconciled metrics; no "available balance" is computed |

## Orders, customers and payment links (signed in, scoped to the merchant's business)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/orders?view=&search=&customer=&page=&limit=` | Views: `all, awaiting_payment, to_fulfil, needs_review, fulfilled, draft, closed` |
| POST | `/orders` | `{ customer: { id } \| { name, email?, phone?, handle? }, items: [{ name, quantity, unitPriceMinor }], deliveryFeeMinor?, note? }` — totals are calculated server-side |
| GET | `/orders/:orderId` | Items, customer, links, payments, settlements, history, allowed actions |
| PUT | `/orders/:orderId` | Edit a draft (locked while a link is active or money has arrived) |
| POST | `/orders/:orderId/cancel` | Unpaid orders only; disables links, closes open instructions |
| POST | `/orders/:orderId/fulfilment` | `{ status: dispatched\|delivered, note? }`; paid orders only |
| POST | `/orders/:orderId/links` | `{ expiresInHours: 24\|72\|168 }`; one active link per order |
| GET | `/orders/:orderId/receipt` | Paid orders only |
| GET | `/links?status=active\|expired\|disabled\|completed` | |
| POST | `/links/:linkId/disable` | Unpaid links only; late funds are still watched |
| GET | `/customers?search=` · GET/PATCH `/customers/:customerId` | |

## Payments, transactions and settlements (signed in)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/transactions?status=&route=&search=` | Payment attempts with provider references, amounts, fees |
| GET | `/transactions/:transactionId` | Detail, timeline, provider notifications, settlement, allowed actions |
| POST | `/transactions/:transactionId/refresh` | Authenticated lookup at the provider, then reconciliation |
| POST | `/transactions/:transactionId/resolve` | `{ decision: accept\|hold, note? }` for payments held for review (no refunds are started) |
| POST | `/transactions/:transactionId/simulate` | Non-production only. Demo: `{ outcome: paid\|underpaid\|overpaid\|processing\|failed\|expired }`; Busha sandbox bank transfers: `paid\|failed` via `/v1/transfers/simulate-deposit` |
| GET | `/settlements?status=pending\|settled\|failed` | Records + totals + integration status (payouts are not automated) |
| POST | `/settlements/:settlementId/simulate` | Demo settlements only: `{ outcome: settled\|failed }` |

## Public checkout (no account)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/checkout/:linkId` | Merchant name, order summary, available methods, the buyer's payments, mode |
| POST | `/checkout/:linkId/payments` | Header `Idempotency-Key` (16-80 chars). Body `{ route: bank_transfer }` or `{ route: stablecoin, asset, network, email, name? }`. Same key → same payment; valid instructions for the same method are reused |
| POST | `/checkout/:linkId/payments/:attemptId/refresh` | "Check payment status": a throttled provider lookup. It can never mark an order paid by itself |
| GET | `/checkout/:linkId/receipt` | After verified payment only |
| GET | `/public/config` | Payments mode, proposed pricing, stablecoin options (used by the website) |

## Webhooks

`POST /webhooks/busha` — raw body. `x-bu-signature` must equal base64(HMAC-SHA256(raw body, `BUSHA_WEBHOOK_SECRET`)). Verified events are stored (deduplicated by SHA-256 of the body, since Busha events carry no id) before `200` is returned, then processed: the referenced transfer / payment request is fetched from Busha and reconciled. Unmatched events are kept and marked `ignored`; failures are retried by the reconciler.

`POST /webhooks/demo` — same pipeline for the explicit demo provider (signed with a key derived from `SECRET_KEY`).

## Health

`GET /health` → `{ database: up|down, paymentsMode, uptime }` (no configuration or secrets).
