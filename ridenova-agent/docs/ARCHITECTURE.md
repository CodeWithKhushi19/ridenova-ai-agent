# Architecture & agent workflow

```
 Browser (public/)                Node backend (server/)                         External
┌──────────────────┐  /api/*   ┌──────────────────────────────────────┐
│ Chat UI          │──────────▶│ app.js  HTTP API, sessions, limits   │
│ Confirm card     │           │   │                                  │      ┌───────────────┐
│ Admin insights   │           │   ▼                                  │ ───▶ │ Gemini / Claude│
└──────────────────┘           │ agent.js  LLM tool-calling loop      │ ◀─── │ (tool calling) │
        ▲                      │   │ tool_use                         │      └───────────────┘
        │ cards, steps,        │   ▼                                  │
        │ pending action       │ tools.js  validate · propose · gate  │      ┌───────────────┐
        │                      │   │                                  │ ───▶ │ Salesforce    │
        └──────────────────────│ repo: salesforce.js | demo.js        │ ◀─── │ REST API v65  │
                               └──────────────────────────────────────┘      └───────────────┘
```

## One chat turn (understand → select tool → retrieve → evaluate → respond)

1. **Understand** – the user's message + conversation history + a system prompt (today's date, identity, rules) go to the LLM with 6 tool definitions.
2. **Select tool** – the LLM replies with `tool_use` (e.g. `search_vehicles {start, end, type}`) or plain text.
3. **Retrieve** – the backend executes the tool against Salesforce (SOQL via REST) or demo data and returns JSON to the LLM.
4. **Evaluate** – tools apply business rules (clashing bookings, blocked statuses, expiring documents, ownership). The LLM sees the verdict/error and can ask a follow-up, try a different tool, or stop. Loop limit: 6 steps.
5. **Respond** – final text goes to the UI along with the **agent steps** (what was checked), **cards** built from real tool output (so numbers come from data, not from the model's prose), and a **pending action** if a write was proposed.

## Writes: propose → confirm → re-validate → execute

```
LLM: propose_booking(...) ─▶ validate ─▶ store single-use pending action in session ─▶ UI shows Confirm card
User presses Confirm ─▶ POST /api/confirm {actionId}
   ─▶ pending removed first (no replay) ─▶ re-run ALL validation on fresh data ─▶ write ─▶ re-read record ─▶ report
```
The LLM has no tool that writes. Even a prompt-injected or confused model can only create a proposal the human must approve.

## Tools

| Tool | Type | Salesforce objects |
|---|---|---|
| `search_vehicles` | read | `Vehicle__c`, `Booking__c` |
| `get_my_bookings`, `get_booking` | read (own only) | `Booking__c`, `Vehicle__c`, `Contact` |
| `propose_booking` | proposal → write on confirm | creates `Booking__c` (Pending/Pending) |
| `propose_cancellation` | proposal → write on confirm | updates `Booking__c.Booking_Status__c = Cancelled` |
| `propose_support_ticket` | proposal → write on confirm | creates `Support_Ticket__c` (Open) |

Ticket classification: the LLM picks `issue_type` and `priority` from your real picklists; the backend rejects anything else.

## Modes

- **salesforce** – `SalesforceRepo`; failure to connect is shown, never masked.
- **demo** – `DemoRepo` (in-memory, dates relative to today); UI/API label it "Demo data (not Salesforce)".

## Interaction with your existing flows

Creating a *Pending* booking fires none of your 8 flows. Cancelling fires `Booking_Auto_Set_Vehicle_Available_After_Cancellation`. Support ticket creation fires none (`Support_Ticket_Auto_Fill_Resolution_Date` only on Closed).

## AI providers
`server/llm.js` translates the agent's internal message format to either Google Gemini `generateContent` (free tier available) or Anthropic Messages. Gemini's own response parts are stored and replayed verbatim on later turns so its reasoning/"thought signature" metadata is preserved. All safety rules live in `tools.js`, so they are identical for both providers.
