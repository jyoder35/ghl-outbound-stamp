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
 *   POST /stamp   — GHL Marketplace webhook receiver. Writes
 *                   last_inbound_at / last_outbound_at to the contact.
 *   POST /decide  — Called by the GHL workflow's Custom Webhook action
 *                   after the 15-min wait. Compares the two timestamps and
 *                   returns { route: "AI_TAKEOVER" | "HUMAN_HANDLED" }.
 *   GET  /health  — Liveness check.
 *
 * Secrets (wrangler secret put / .dev.vars):
 *   GHL_API_TOKEN            Location PIT or OAuth access token (Bearer).
 *   GHL_INBOUND_FIELD_ID     Custom field id for last_inbound_at.
 *   GHL_OUTBOUND_FIELD_ID    Custom field id for last_outbound_at.
 *   GHL_WEBHOOK_PUBLIC_KEY   (optional) GHL's PEM public key to verify
 *                            webhook signatures. If unset, verification is
 *                            skipped (fine for first testing, enable later).
 *   DECIDE_SHARED_SECRET     (optional) Shared secret required on /decide
 *                            via the x-relay-secret header.
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

  let fieldId = null;
  if (type.includes('outbound')) fieldId = env.GHL_OUTBOUND_FIELD_ID;
  else if (type.includes('inbound')) fieldId = env.GHL_INBOUND_FIELD_ID;

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
