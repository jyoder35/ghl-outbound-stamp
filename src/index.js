/**
 * GHL Outbound/Inbound Message Stamper + Decision Relay
 * ------------------------------------------------------
 * A Cloudflare Worker that fills the gap GHL leaves: there is no native
 * "a human/user sent an outbound message" workflow trigger. This relay
 * subscribes (via a GHL Marketplace app webhook) to InboundMessage and
 * OutboundMessage events and stamps timestamps onto the contact, so a
 * workflow can later decide whether a human responded.
 *
 * Routes:
 *   POST /stamp             — GHL Marketplace webhook receiver. Writes
 *                             last_inbound_at / last_outbound_at /
 *                             last_ai_outbound_at to the contact.
 *   POST /decide            — Called by a GHL workflow Custom Webhook after
 *                             the 15-min wait. Compares timestamps and
 *                             returns { route: "AI_TAKEOVER"|"HUMAN_HANDLED" }.
 *   POST /backfill-contact  — Retroactively stamps a contact from SMS
 *                             history. Requires x-relay-secret. Call from
 *                             a GHL Smart List workflow or a local script.
 *                             Populates inbound + LO outbound only (AI
 *                             outbound cannot be distinguished from history).
 *   GET  /health            — Liveness check.
 *
 * Secrets (Cloudflare dashboard → Settings → Variables and secrets → Runtime):
 *   GHL_API_TOKEN              Location PIT or OAuth access token (Bearer).
 *   GHL_INBOUND_FIELD_ID       Field id: AZM SLA — Last inbound SMS (stamp).
 *   GHL_OUTBOUND_FIELD_ID      Field id: AZM SLA — Last LO outbound SMS (stamp).
 *   GHL_AI_OUTBOUND_FIELD_ID   Field id: AZM SLA — Last AI outbound (stamp).
 *                              Stamped in /stamp when webhook payload has no
 *                              userId (system/AI-sent message). Not populated
 *                              by /backfill-contact (indistinguishable from
 *                              history).
 *   GHL_WEBHOOK_PUBLIC_KEY     (optional) GHL PEM public key for webhook
 *                              signature verification.
 *   DECIDE_SHARED_SECRET       (optional) Required on /decide and
 *                              /backfill-contact via x-relay-secret header.
 */

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, service: 'ghl-outbound-stamp' });
      }
      if (request.method === 'POST' && url.pathname === '/stamp') {
        return await handleStamp(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/decide') {
        return await handleDecide(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/backfill-contact') {
        return await handleBackfill(request, env);
      }
      return json({ error: 'not_found', path: url.pathname }, 404);
    } catch (err) {
      // Never 500 a webhook hard — GHL will retry and hammer us. Log + 200.
      console.error('Unhandled error:', err && err.stack ? err.stack : err);
      return json({ error: 'internal', message: String(err && err.message || err) }, 200);
    }
  },
};

// ─── /stamp ──────────────────────────────────────────────────────────────

async function handleStamp(request, env) {
  const raw = await request.text();

  // Optional signature verification (GHL signs marketplace webhooks).
  if (env.GHL_WEBHOOK_PUBLIC_KEY) {
    const sig = request.headers.get('x-wh-signature') || '';
    const valid = await verifySignature(raw, sig, env.GHL_WEBHOOK_PUBLIC_KEY);
    if (!valid) {
      console.warn('Rejected webhook: bad signature');
      return json({ error: 'bad_signature' }, 401);
    }
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'bad_json' }, 200);
  }

  // GHL marketplace message webhooks carry `type` and `contactId`.
  const type = String(body.type || '').toLowerCase();
  const contactId = body.contactId || body.contact_id;
  if (!contactId) {
    return json({ error: 'no_contact_id', received: body.type }, 200);
  }

  // Prefer the event's own timestamp; fall back to now.
  const stamp = normalizeStamp(body.dateAdded || body.dateUpdated) || new Date().toISOString();

  // Distinguish AI-sent outbound (no userId in payload) from LO-sent outbound.
  let fieldId = null;
  if (type.includes('outbound')) {
    const isAi = !body.userId && env.GHL_AI_OUTBOUND_FIELD_ID;
    fieldId = isAi ? env.GHL_AI_OUTBOUND_FIELD_ID : env.GHL_OUTBOUND_FIELD_ID;
  } else if (type.includes('inbound')) {
    fieldId = env.GHL_INBOUND_FIELD_ID;
  }

  if (!fieldId) {
    return json({ skipped: true, reason: 'unhandled_type', type: body.type }, 200);
  }

  await updateContactField(env, contactId, fieldId, stamp);
  return json({ ok: true, contactId, field: fieldId, stamp, type: body.type });
}

// ─── /decide ─────────────────────────────────────────────────────────────

async function handleDecide(request, env) {
  if (env.DECIDE_SHARED_SECRET) {
    const provided = request.headers.get('x-relay-secret') || '';
    if (provided !== env.DECIDE_SHARED_SECRET) {
      return json({ error: 'unauthorized' }, 401);
    }
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    /* allow empty body, fall through to validation */
  }

  const contactId = body.contactId || body.contact_id;
  if (!contactId) return json({ error: 'no_contact_id' }, 400);

  const contact = await getContact(env, contactId);
  const inbound = readFieldDate(contact, env.GHL_INBOUND_FIELD_ID);
  const outbound = readFieldDate(contact, env.GHL_OUTBOUND_FIELD_ID);

  // Decision: if there is no outbound after the latest inbound, no human
  // responded → hand the conversation to the AI. If outbound is newer (or
  // equal), a human already covered it → stay quiet.
  let route;
  if (!inbound) {
    // We were triggered by an inbound, so this should exist; if not, be safe.
    route = 'HUMAN_HANDLED';
  } else if (!outbound) {
    route = 'AI_TAKEOVER';
  } else {
    route = outbound > inbound ? 'HUMAN_HANDLED' : 'AI_TAKEOVER';
  }

  return json({
    route,
    contactId,
    last_inbound_at: inbound ? inbound.toISOString() : null,
    last_outbound_at: outbound ? outbound.toISOString() : null,
  });
}

// ─── /backfill-contact ───────────────────────────────────────────────────

async function handleBackfill(request, env) {
  if (env.DECIDE_SHARED_SECRET) {
    const provided = request.headers.get('x-relay-secret') || '';
    if (provided !== env.DECIDE_SHARED_SECRET) {
      return json({ error: 'unauthorized' }, 401);
    }
  }

  let body = {};
  try { body = await request.json(); } catch {}

  const contactId = body.contactId || body.contact_id;
  if (!contactId) return json({ error: 'no_contact_id' }, 400);

  // Need locationId to search conversations — pull it from the contact record.
  const contact = await getContact(env, contactId);
  const locationId = contact.locationId;
  if (!locationId) return json({ error: 'no_location_id', contactId }, 200);

  // Find the contact's conversation.
  const convRes = await fetch(
    `${GHL_API_BASE}/conversations/search?contactId=${encodeURIComponent(contactId)}&locationId=${encodeURIComponent(locationId)}&limit=1`,
    { method: 'GET', headers: ghlHeaders(env) }
  );
  if (!convRes.ok) {
    const t = await convRes.text();
    throw new Error(`searchConversations ${convRes.status}: ${t}`);
  }
  const convData = await convRes.json();
  const conversations = convData.conversations || convData.data || [];
  if (!conversations.length) {
    return json({ ok: true, contactId, skipped: 'no_conversation' });
  }
  const convId = conversations[0].id;

  // Fetch up to 100 most recent messages (GHL returns newest first).
  const msgRes = await fetch(
    `${GHL_API_BASE}/conversations/${encodeURIComponent(convId)}/messages?limit=100`,
    { method: 'GET', headers: ghlHeaders(env) }
  );
  if (!msgRes.ok) {
    const t = await msgRes.text();
    throw new Error(`getMessages ${msgRes.status}: ${t}`);
  }
  const msgData = await msgRes.json();
  // GHL wraps messages under messages.messages
  const messages = (msgData.messages && msgData.messages.messages) || msgData.messages || [];

  // Find last inbound and last outbound SMS (type 1).
  // AI outbound cannot be reliably distinguished from LO outbound in history,
  // so GHL_AI_OUTBOUND_FIELD_ID is intentionally not backfilled here.
  let lastInbound = null;
  let lastOutbound = null;
  for (const msg of messages) {
    if (msg.type !== 2) continue; // SMS only (GHL type 2 = TYPE_SMS; type 1 = call)
    const ts = new Date(msg.dateAdded);
    if (isNaN(ts.getTime())) continue;
    if (msg.direction === 'inbound' && (!lastInbound || ts > lastInbound)) lastInbound = ts;
    if (msg.direction === 'outbound' && (!lastOutbound || ts > lastOutbound)) lastOutbound = ts;
  }

  const updates = [];
  if (lastInbound && env.GHL_INBOUND_FIELD_ID) {
    await updateContactField(env, contactId, env.GHL_INBOUND_FIELD_ID, lastInbound.toISOString());
    updates.push('inbound');
  }
  if (lastOutbound && env.GHL_OUTBOUND_FIELD_ID) {
    await updateContactField(env, contactId, env.GHL_OUTBOUND_FIELD_ID, lastOutbound.toISOString());
    updates.push('lo_outbound');
  }

  return json({
    ok: true,
    contactId,
    convId,
    updates,
    last_inbound_at: lastInbound ? lastInbound.toISOString() : null,
    last_outbound_at: lastOutbound ? lastOutbound.toISOString() : null,
  });
}

// ─── GHL API helpers ─────────────────────────────────────────────────────

function ghlHeaders(env) {
  return {
    Authorization: `Bearer ${env.GHL_API_TOKEN}`,
    Version: GHL_API_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function updateContactField(env, contactId, fieldId, value) {
  const res = await fetch(`${GHL_API_BASE}/contacts/${contactId}`, {
    method: 'PUT',
    headers: ghlHeaders(env),
    body: JSON.stringify({ customFields: [{ id: fieldId, value }] }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`updateContactField ${res.status}: ${text}`);
  }
}

async function getContact(env, contactId) {
  const res = await fetch(`${GHL_API_BASE}/contacts/${contactId}`, {
    method: 'GET',
    headers: ghlHeaders(env),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`getContact ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.contact || data;
}

/** Pull a custom field value off a contact and parse it as a Date. */
function readFieldDate(contact, fieldId) {
  if (!fieldId || !contact) return null;
  const fields = contact.customFields || contact.customField || [];
  for (const f of fields) {
    const id = f.id || f.fieldId;
    if (id === fieldId) {
      const d = new Date(f.value);
      return isNaN(d.getTime()) ? null : d;
    }
  }
  return null;
}

// ─── Utilities ───────────────────────────────────────────────────────────

function normalizeStamp(input) {
  if (!input) return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Verify a GHL marketplace webhook signature.
 * GHL signs the raw request body with RSA-SHA256; the base64 signature is in
 * the x-wh-signature header. The public key (PEM, SPKI) is published by GHL.
 */
async function verifySignature(rawBody, signatureB64, pemPublicKey) {
  try {
    const key = await importRsaPublicKey(pemPublicKey);
    const sig = base64ToBytes(signatureB64);
    const data = new TextEncoder().encode(rawBody);
    return await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      sig,
      data
    );
  } catch (err) {
    console.error('Signature verify failed:', err);
    return false;
  }
}

async function importRsaPublicKey(pem) {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  const der = base64ToBytes(b64);
  return crypto.subtle.importKey(
    'spki',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
