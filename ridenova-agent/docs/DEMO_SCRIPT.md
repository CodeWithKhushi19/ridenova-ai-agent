# 3-minute hackathon demo script

**Before you go on:** run `npm start` (live) or `npm run demo`; open the app in two tabs (customer + admin); have Salesforce open on the Bookings tab; copy the admin token. Do the live checklist once beforehand. Have a screen recording as backup.

| Time | Do | Say |
|---|---|---|
| 0:00 | Show the header chip + banner | "RideNova is our Salesforce fleet system — vehicles, bookings, support tickets, flows. We added an AI agent on top. This chip shows whether we're on live Salesforce or labelled demo data — we never mix them." |
| 0:20 | Enter customer email → Continue | "Customers identify by email; the agent can only touch that customer's own records." |
| 0:30 | Type: *"Which automatic SUVs are free next Friday for 2 days?"* | "Plain language. The model picks a tool, we query Salesforce, and the backend checks real clashes with other bookings." Point at the **agent steps** chips and the cards. |
| 1:00 | Click **Book this** on one card, add *"Airport to Airport"* if asked | "Notice it doesn't book yet — it prepares the booking and shows me exactly what will happen." Point at the confirm card. |
| 1:20 | Click **Confirm** → switch to Salesforce, refresh | "Only this button writes — the AI can't. The backend re-validates, then creates the record. Here it is: status Pending, rent calculated from the vehicle's daily rate." |
| 1:45 | Ask to book the same dates again | "Duplicate protection — it's refused with a reason. And if I ask to cancel someone else's booking…" (try a ref not yours) "…it's refused, no information leaked." |
| 2:05 | Type: *"The car I rented broke down on the highway"* | "It classifies the problem: type Vehicle Breakdown, priority Critical/High, linked to my booking — again waiting for my confirmation." Confirm. |
| 2:30 | Switch to **Admin insights**, paste token, Load, click **AI summary** | "Admins see pending bookings and open tickets from retrieved records — flagged by age and urgency. The summary is generated only from these rows. The ticket and booking we just made are here." |
| 2:55 | Close | "Reusing the existing RideNova schema, secure backend, human-in-the-loop writes, and an honest demo mode. Next: real customer login, Experience Cloud, Copado pipeline for the agent." |

**If something fails live:** say what the red message says (they're specific), switch to `npm run demo`, or play the recording. Don't claim demo data is Salesforce.

## Technologies in plain words

- **Salesforce** – your existing objects, fields and flows; accessed through its REST API.
- **LLM tool calling (Google Gemini or Anthropic Claude)** – the model decides *which function to call*; our code runs the function and returns facts. That's what makes it an agent rather than a chatbot.
- **Node.js backend (no dependencies)** – keeps secrets safe, validates every action, talks to Salesforce and the LLM.
- **Vanilla JS front end** – a single page; no build step.
- **node:test** – 44 automated tests incl. a check that every field name exists in your metadata.
