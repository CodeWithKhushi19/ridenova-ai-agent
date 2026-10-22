# RideNova AI — Smart Booking & Support Agent

An AI agent on top of the existing **RideNova – Vehicle & Fleet Management** Salesforce project. Customers chat in plain language to find free vehicles, check or cancel bookings, create bookings and raise support tickets. Admins get an insights view of pending bookings and open support issues.

It lives in this folder (`ridenova-agent/`) next to your `force-app/`. **Nothing in `force-app` was modified**, no schema was changed, and nothing was deleted.

> **Honest status.** Verified here: business rules, confirmation gate, Salesforce request shapes, schema names (against your real metadata), HTTP API, the Gemini and Claude request translation (against fake servers), and the UI in a real browser. **Not verified here (no keys / org / Google access in the build environment):** a live Salesforce org and a real AI model. Run `npm run check-llm` and the 10-minute [live verification](#live-verification-checklist) before the demo.

## What it can do

| Feature | Status |
|---|---|
| Polished chat UI (loading, error, empty states, mobile) | ✅ |
| Real LLM tool-calling agent: **Google Gemini (free tier available)** or Anthropic Claude (paid) | ✅ code complete — needs your API key |
| Vehicle availability from `Vehicle__c` + clashing `Booking__c` | ✅ |
| Booking lookup (own bookings only) | ✅ |
| Create booking (as **Pending**) after user confirmation | ✅ |
| Cancel booking after user confirmation | ✅ |
| Support-ticket classification + creation after confirmation | ✅ |
| Admin insights (pending bookings, open tickets, flags, optional AI summary) | ✅ |
| Labelled **demo mode** with sample data (never presented as Salesforce) | ✅ |

## Quick start (2 minutes, demo data)

Requires **Node 20+** (`node -v`). No `npm install` needed — zero dependencies.

```bash
cd ridenova-agent
cp .env.example .env          # Windows: copy .env.example .env
# edit .env and set  GEMINI_API_KEY=...   (free key: https://aistudio.google.com/apikey)
npm run check-llm             # 5-second test that your key + model can do tool calling
npm run demo                  # demo data (works on Windows, Mac, Linux)
```

### Choosing the AI model (free or paid)

| | Gemini (free tier available) | Claude (paid) |
|---|---|---|
| `.env` | `GEMINI_API_KEY=...` and optionally `GEMINI_MODEL=gemini-3.8-flash` | `ANTHROPIC_API_KEY=...` |
| Cost | Free tier per Google's pricing page; limits and rules can change | Pay per use |
| Privacy | Free-tier prompts may be used by Google to improve its products - **use demo/test data only** (the UI shows a notice) | Per Anthropic terms |

If both keys are set, Claude is used unless you set `LLM_PROVIDER=gemini`. If `check-llm` or chat says the model was not found, try another Gemini Flash / Flash-Lite model name from Google's model list in `GEMINI_MODEL` (for example `gemini-3.6-flash` or `gemini-2.5-flash`). On the free tier you may hit rate limits ("busy" message): wait a minute and retry.

Open http://localhost:3000. The console prints an **admin token** for the Admin tab. Demo customers: `aarav@example.com`, `priya@example.com`.
The yellow banner and "DEMO DATA" chip are always shown in this mode.

Without an AI key the app starts, but chat is disabled with a clear message (it deliberately has no keyword-matching fallback pretending to be AI).

## Run against your real Salesforce org

1. Get a short-lived token from the CLI you already use in VS Code:
   ```bash
   sf org display --target-org ActualRideNova --verbose --json
   ```
   Copy `accessToken` → `SF_ACCESS_TOKEN` and `instanceUrl` → `SF_INSTANCE_URL` in `.env`. (Your project's default org alias is `ActualRideNova`.)
2. Leave `MODE=` empty (auto) or set `MODE=salesforce`, then `npm start`.
3. The header chip must read **Live Salesforce**. If the connection fails the app shows a red error and does **not** silently switch to demo data.
4. Customers must be **Contacts with an Email** (that's how identification works). Add test Contacts and a few `Vehicle__c` records if your org is empty.

Tokens from `sf org display` expire (session timeout, commonly a couple of hours); rerun and restart when you get "session expired".

**Production-style auth (optional):** create a Connected App / External Client App with the *Client Credentials* flow, run-as a dedicated integration user, and set `SF_LOGIN_URL` (your My Domain URL), `SF_CLIENT_ID`, `SF_CLIENT_SECRET`. The backend fetches and refreshes tokens itself.

## Security model

- Salesforce and LLM credentials exist **only** in the server's environment (`.env`, git-ignored). The browser never receives them; the UI talks only to `/api/*` on the backend.
- **Writes are two-step and enforced on the backend.** The LLM can only *propose*; a proposal stores a single-use pending action server-side. Only the **Confirm** button (`POST /api/confirm`) executes it, after **re-validating against fresh data**. A replayed, expired, replaced or guessed action id does nothing.
- **Ownership:** the agent can only read/modify bookings whose `Customer__c` equals the identified contact. "Not yours" and "doesn't exist" return the same answer, so nothing leaks.
- **No duplicates:** overlapping Pending/Confirmed bookings on the same vehicle are rejected (inclusive of same-day handover); same-customer overlap gets a specific message; open tickets of the same type on the same booking are rejected; writes are serialised in-process.
- Inputs validated server-side: ISO dates, no past pickup, return after pickup, max 30 days, enum values from your real picklists, Salesforce ID format, booking-ref format; SOQL strings are escaped.
- Admin endpoints require `x-admin-token` (constant-time compare). Basic rate limit, body-size cap, CSP header, path-traversal-safe static serving.
- **Least privilege:** run the backend as a dedicated integration user. `optional-schema/RideNova_Agent_Integration.permissionset-meta.xml` is a starting point (**untested — review before deploying**). The app never deletes anything and only ever PATCHes `Booking_Status__c`.

## Known limitations (please read before presenting)

1. **Identification is email-match only, not authentication.** Anyone who knows a customer's email can act as them. Fine for a hackathon demo; production needs login/OTP (e.g. Experience Cloud or an identity provider).
2. **Cancelling triggers your existing flow** `Booking_Auto_Set_Vehicle_Available_After_Cancellation`, which sets the vehicle to *Available* even if it has another active booking (and the vehicle's status is controlled by 5 flows). That's existing behaviour I did not change; consider fixing it in Salesforce.
3. Bookings are created as **Pending**. Your flows only fire for *Confirmed*, so staff confirmation (or a later feature) triggers vehicle status changes.
4. **Ticket description:** `Support_Ticket__c` has no field for the customer's own words (only `Resolution_Notes__c`, meant for staff). Tickets are created with type/priority/booking; the description is **not stored** unless you deploy the optional `Issue_Description__c` field (`optional-schema/`) and set `TICKET_DESCRIPTION_FIELD`. The confirm card tells the user this.
5. Availability = vehicle status not *Under Maintenance/Out of Service* **and** no Pending/Confirmed booking overlapping the dates **and** insurance/RC not expiring before the return date. (The expiry rule is a policy I chose, using your real fields; remove it in `tools.js` if unwanted.)
6. Your existing **Customer Feedback → Support Ticket** flow sets only `Issue_Type__c` and `Ticket_Date__c`, but `Booking__c`, `Customer__c`, `Priority__c` and `Ticket_Status__c` are required on the ticket, so that flow may fail at runtime. I didn't test or change it; worth checking.
7. In-memory sessions (lost on restart), single server process, ~20 messages of memory per chat, 6 tool steps per message. No payments, no email/SMS.
8. Salesforce has no uniqueness constraint here, so duplicate protection is application-level (check-then-write, serialised per process). Two server processes could theoretically race.

## Live verification checklist

Do this once with your real key/org (≈10 minutes). Tick each in order:

1. `npm test` → all green (also re-checks every field name against your `force-app`).
2. `npm start` → chip says **Live Salesforce**; Admin tab loads real pending bookings/tickets.
3. Identify with a real Contact email. Ask: *"Which SUVs are free next Friday for 2 days?"* → cards match what you see in Salesforce.
4. *"Book the first one from Airport to Airport"* → confirm card → **Confirm** → open the record in Salesforce: Booking exists, status Pending, total = daily rent × days.
5. Repeat step 4 for the same dates → must be refused.
6. *"Cancel BKG-xxxxx"* → confirm → status Cancelled (and watch the vehicle flow side-effect, limitation 2).
7. *"My car broke down"* → ticket proposal shows Vehicle Breakdown / Critical-ish → confirm → ticket exists.
8. Try to cancel someone else's booking ref → refused.

## Project layout

```
ridenova-agent/
  server/  index.js (boot) · app.js (HTTP API) · agent.js (LLM loop) · tools.js (tools, validation, confirmation gate)
           salesforce.js (REST client + repo) · demo.js (labelled sample data) · insights.js · llm.js · schema.js · config.js · util.js
  public/  index.html · styles.css · app.js     (vanilla JS UI, no build step)
  test/    44 tests: schema conformance, rules, Salesforce client, Gemini adapter, end-to-end HTTP
  scripts/ check-llm.js (smoke-tests your real AI key)
  optional-schema/  optional Issue_Description__c field + least-privilege permission set
  docs/    ARCHITECTURE.md · DEMO_SCRIPT.md
```

Salesforce names used (all verified in your metadata by `test/schema.test.js`): `Vehicle__c`, `Booking__c`, `Support_Ticket__c`, `Contact` and the fields listed in `server/schema.js`.

## Tests

`npm test` runs 44 tests. The end-to-end tests drive the real server and agent loop with a **scripted stand-in for the LLM** (no key/network needed), so they prove orchestration, validation and the confirmation gate — not how well the real model chooses tools. Salesforce tests use a fake `fetch`, so they prove request shapes and field names, not that your org accepts them (hence the checklist above).

## Troubleshooting

| Symptom | Fix |
|---|---|
| "AI model is not configured" | set `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`) in `.env`, restart |
| Red banner "Salesforce connection failed… session expired" | re-run `sf org display …`, update `SF_ACCESS_TOKEN`, restart |
| "No customer with that email" | the Contact needs an Email; in demo use `aarav@example.com` |
| Model error 404 / "model not found" | set `GEMINI_MODEL` (or `ANTHROPIC_MODEL`) to a model your key can use |
| `check-llm` says "Model did not call a tool" | that model can't do tool calling reliably - pick another model |
| "free-tier limit reached" / busy | wait a minute; Gemini free tier has rate limits |
| Admin "token missing or wrong" | use the token printed in the server console, or set `ADMIN_TOKEN` |
