# GHL Outbound/Inbound Message Stamper

Fills a gap GoHighLevel leaves open: **there is no native workflow trigger or
If/Else condition for "the last message direction" or "a human sent an outbound
message."** This small Cloudflare Worker listens to GHL's message webhooks,
stamps the time of the last inbound and last outbound message onto the contact,
and exposes a decision endpoint a workflow can call to ask "did a human reply
yet?"

## How it works

```
Contact sends SMS ─────────────► GHL fires "InboundMessage" webhook
                                          │
                                          ▼
                                  Worker /stamp  →  writes last_inbound_at on contact
LO/human replies in GHL ───────► GHL fires "OutboundMessage" webhook
                                          │
                                          ▼
                                  Worker /stamp  →  writes last_outbound_at on contact

Fallback workflow (trigger: Customer Replied):
   Wait 15 min
        │
        ▼
   Custom Webhook action ──POST /decide {contactId}──► Worker
        │                                               compares the two stamps
        ▼                                               returns { route }
   If/Else on webhook response:
        route == "AI_TAKEOVER"   → Conversation AI bot
        route == "HUMAN_HANDLED" → end
```

The decision rule: if `last_outbound_at` is newer than `last_inbound_at`, a human
already replied → **HUMAN_HANDLED**. Otherwise no one replied → **AI_TAKEOVER**.

## One-time setup

### 1. Create two custom fields in GHL
Settings → Custom Fields → add two **Date/Text** fields on the Contact object:
- `AZM Last Inbound At`  (you may already have "AZM SLA last inbound SMS" — reuse it)
- `AZM Last Outbound At`

Copy each field's **ID** (the long id, not the name).

### 2. Deploy the Worker
You need [Node.js](https://nodejs.org) installed. Then in this folder:

```powershell
npm install
npx wrangler login          # opens a browser, log into Cloudflare (free tier is fine)
npx wrangler deploy
```

Deploy prints your Worker URL, e.g. `https://ghl-outbound-stamp.<you>.workers.dev`.

### 3. Set the secrets
```powershell
npx wrangler secret put GHL_API_TOKEN          # paste your GHL PIT/location token
npx wrangler secret put GHL_INBOUND_FIELD_ID   # paste the inbound field ID
npx wrangler secret put GHL_OUTBOUND_FIELD_ID  # paste the outbound field ID
npx wrangler secret put DECIDE_SHARED_SECRET   # any random string (recommended)
# Optional, enable later for security hardening:
npx wrangler secret put GHL_WEBHOOK_PUBLIC_KEY # GHL's marketplace webhook public key (PEM)
```

Verify it's live: open `https://<your-worker-url>/health` → should return `{"ok":true}`.

### 4. Create a GHL Marketplace app + subscribe to message webhooks
**This is the only step with no API — it must be done in the GHL developer portal.**

1. Go to <https://marketplace.gohighlevel.com> → sign in → **My Apps** → **Create App**.
2. Name it (e.g. "AZM Outbound Stamper"). Distribution: **Sub-Account**, private/unlisted.
3. Under **Scopes**, add: `conversations/message.readonly`, `contacts.write`, `contacts.readonly`.
4. Under **Webhooks**, set the webhook URL to `https://<your-worker-url>/stamp`
   and subscribe to events: **InboundMessage** and **OutboundMessage**.
5. Save, then **install the app on the AZM Lending sub-account** (Settings →
   Integrations, or via the generated install link).
6. (Security) Copy the app's webhook **public key** and set it as
   `GHL_WEBHOOK_PUBLIC_KEY` (step 3). Until then, leave it blank.

### 5. Wire the fallback workflow
The companion workflow "AI Fallback — 15 Min No Human Response" is built as a
**draft** in your account. Open it and:
- In the **Custom Webhook** action, confirm the URL is `https://<your-worker-url>/decide`,
  method POST, body `{"contactId":"{{contact.id}}"}`, and (if set) header
  `x-relay-secret: <your DECIDE_SHARED_SECRET>`.
- In the **If/Else**, confirm the condition reads the webhook response field
  `route` equals `AI_TAKEOVER`.
- Select your Conversation AI bot in the AI step.
- Publish when you're satisfied.

## Local testing
```powershell
copy .dev.vars.example .dev.vars   # then fill in values
npm run dev                        # runs at http://localhost:8787
```
Simulate a webhook:
```powershell
curl -X POST http://localhost:8787/stamp -H "Content-Type: application/json" `
  -d '{"type":"OutboundMessage","contactId":"TEST123","dateAdded":"2026-06-11T14:30:00Z"}'
```

## Notes
- The Worker returns HTTP 200 even on internal errors for webhook routes, so GHL
  doesn't retry-storm. Check logs with `npx wrangler tail`.
- Cloudflare Workers free tier (100k requests/day) is far more than enough.
- If you'd rather avoid code entirely, the same inbound/outbound stamping can be
  done with a no-code Make.com or Zapier "LeadConnector" scenario — but this
  Worker is cheaper and has no per-task billing.
