import { compareSync } from 'bcryptjs';

const PROJECT_ID     = 'rainfoll-143ef';
const COLLECTION     = 'signups';
const SURVEYS_COLL   = 'surveys';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// ── CORS ───────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ── Firebase service-account → access token ───────────────────────────
async function getFirestoreToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    sub: env.FIREBASE_CLIENT_EMAIL,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/datastore',
    iat: now,
    exp: now + 3600,
  };

  const b64url = (obj) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const unsigned = `${b64url(header)}.${b64url(payload)}`;

  const pem = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const keyBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${unsigned}.${sig}`,
  });
  const tokenRes = await res.json();
  if (!tokenRes.access_token) throw new Error(`OAuth failed: ${JSON.stringify(tokenRes)}`);
  return tokenRes.access_token;
}

// ── Firestore helpers ──────────────────────────────────────────────────
function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string')        fields[k] = { stringValue: v };
    else if (typeof v === 'boolean')  fields[k] = { booleanValue: v };
    else if (typeof v === 'number')   fields[k] = { doubleValue: v };
  }
  return fields;
}

function fromDoc(doc) {
  const f = doc.fields || {};
  return {
    id:              doc.name?.split('/').pop(),
    email:           f.email?.stringValue           || '',
    is_vip:          f.is_vip?.booleanValue         || false,
    payment_id:      f.payment_id?.stringValue      || '',
    payment_status:  f.payment_status?.stringValue  || 'none',
    created_at:      f.created_at?.stringValue      || '',
    utm_content:     f.utm_content?.stringValue     || '',
    vipPaidAt:       f.vipPaidAt?.stringValue       || '',
    stripeSessionId: f.stripeSessionId?.stringValue || '',
    amount:          f.amount?.doubleValue          || 0,
    surveyCompleted: f.surveyCompleted?.booleanValue || false,
    vipOnly:         f.vipOnly?.booleanValue        || false,
  };
}

function fromSurvey(doc) {
  const f = doc.fields || {};
  return {
    id:           doc.name?.split('/').pop(),
    email:        f.email?.stringValue        || '',
    vip:          f.vip?.booleanValue         || false,
    session_id:   f.session_id?.stringValue   || '',
    q1:           f.q1?.stringValue           || '',
    q2:           f.q2?.stringValue           || '',
    q3:           f.q3?.stringValue           || '',
    q4:           f.q4?.stringValue           || '',
    q5:           f.q5?.stringValue           || '',
    submitted_at: f.submitted_at?.stringValue || '',
    utm_content:  f.utm_content?.stringValue  || '',
  };
}

async function findByEmail(email, token) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: COLLECTION }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'email' },
              op: 'EQUAL',
              value: { stringValue: email },
            },
          },
          limit: 1,
        },
      }),
    }
  );
  const rows = await res.json();
  return rows.find((r) => r.document)?.document || null;
}

async function findById(docId, collection, token) {
  const res = await fetch(`${FIRESTORE_BASE}/${collection}/${docId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const doc = await res.json();
  return doc.name ? doc : null;
}

// ── Session JWT (HMAC-SHA256) ─────────────────────────────────────────
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function signSessionJWT(payload, secret) {
  const hdr  = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const body = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const data = `${hdr}.${body}`;
  const key  = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig  = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}

async function verifySessionJWT(token, secret) {
  try {
    const [hdr, body, sig] = token.split('.');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(`${hdr}.${body}`));
    if (!ok) return null;
    const pl = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    if (pl.exp < Date.now() / 1000) return null;
    return pl;
  } catch { return null; }
}

async function requireAuth(request, env) {
  const auth  = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  return verifySessionJWT(token, env.JWT_SECRET);
}

// ── Admin rate limiting ────────────────────────────────────────────────
const MAX_ATTEMPTS    = 10;
const LOCKOUT_SECONDS = 900;

async function checkRateLimit(ip, env) {
  const raw = await env.ADMIN_RATE_LIMIT.get(`rl:${ip}`);
  if (!raw) return { blocked: false, attempts: 0 };
  const d = JSON.parse(raw);
  if (d.lockedUntil && d.lockedUntil > Date.now())
    return { blocked: true, lockedUntil: d.lockedUntil, retry_after_seconds: Math.ceil((d.lockedUntil - Date.now()) / 1000) };
  return { blocked: false, attempts: d.attempts || 0 };
}

async function recordFail(ip, env) {
  const raw = await env.ADMIN_RATE_LIMIT.get(`rl:${ip}`);
  const d   = raw ? JSON.parse(raw) : { attempts: 0 };
  d.attempts = (d.attempts || 0) + 1;
  if (d.attempts >= MAX_ATTEMPTS) d.lockedUntil = Date.now() + LOCKOUT_SECONDS * 1000;
  await env.ADMIN_RATE_LIMIT.put(`rl:${ip}`, JSON.stringify(d), { expirationTtl: LOCKOUT_SECONDS * 2 });
  return d;
}

async function clearRateLimit(ip, env) {
  await env.ADMIN_RATE_LIMIT.delete(`rl:${ip}`);
}

// ── Survey rate limiting (max 5 per IP per hour) ──────────────────────
async function checkSurveyRateLimit(ip, env) {
  const raw = await env.ADMIN_RATE_LIMIT.get(`sv:${ip}`);
  if (!raw) return false;
  const d = JSON.parse(raw);
  return (d.count || 0) >= 5 && d.resetAt > Date.now();
}

async function recordSurveySubmit(ip, env) {
  const raw = await env.ADMIN_RATE_LIMIT.get(`sv:${ip}`);
  const d   = raw ? JSON.parse(raw) : { count: 0, resetAt: Date.now() + 3600000 };
  if (d.resetAt < Date.now()) { d.count = 0; d.resetAt = Date.now() + 3600000; }
  d.count++;
  await env.ADMIN_RATE_LIMIT.put(`sv:${ip}`, JSON.stringify(d), { expirationTtl: 3600 });
}

// ── Stripe webhook signature verification ────────────────────────────
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = (sigHeader || '').split(',');
  const t  = (parts.find(p => p.startsWith('t='))  || '').slice(2);
  const v1 = (parts.find(p => p.startsWith('v1=')) || '').slice(3);
  if (!t || !v1) return false;

  // Reject events older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(t, 10)) > 300) return false;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

  if (computed.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// ── POST /auth/login ───────────────────────────────────────────────────
async function handleLogin(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { password } = await request.json();

  const limit = await checkRateLimit(ip, env);
  if (limit.blocked)
    return json({ error: 'Too many failed attempts', locked_until: limit.lockedUntil, retry_after_seconds: limit.retry_after_seconds }, 429);

  const hash = ((await env.ADMIN_RATE_LIMIT.get('admin:password_hash')) || env.ADMIN_PASSWORD_HASH || '').trim();
  let valid = false;
  try {
    valid = compareSync(password, hash);
  } catch (e) {
    return json({ error: 'Password check failed', detail: e.message }, 500);
  }

  if (!valid) {
    const d = await recordFail(ip, env);
    if (d.lockedUntil)
      return json({ error: 'Too many failed attempts. Locked for 15 minutes.', locked_until: d.lockedUntil, retry_after_seconds: LOCKOUT_SECONDS }, 429);
    return json({ error: 'Invalid password', remaining_attempts: MAX_ATTEMPTS - d.attempts }, 401);
  }

  await clearRateLimit(ip, env);
  const token = await signSessionJWT(
    { sub: 'admin', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 },
    env.JWT_SECRET
  );
  return json({ token });
}

// ── POST /auth/change-password ─────────────────────────────────────────
async function handleChangePassword(request, env) {
  if (!await requireAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const { old_password, new_password_hash } = await request.json();
  const currentHash = ((await env.ADMIN_RATE_LIMIT.get('admin:password_hash')) || env.ADMIN_PASSWORD_HASH || '').trim();

  if (!compareSync(old_password, currentHash))
    return json({ error: 'Current password is incorrect' }, 403);

  await env.ADMIN_RATE_LIMIT.put('admin:password_hash', new_password_hash);
  return json({ success: true });
}

// ── GET /?action=list ──────────────────────────────────────────────────
async function handleList(request, env) {
  if (!await requireAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  let token;
  try { token = await getFirestoreToken(env); }
  catch (e) { return json({ error: 'Firestore auth failed', detail: e.message }, 500); }

  const res = await fetch(`${FIRESTORE_BASE}/${COLLECTION}?pageSize=1000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const detail = await res.text();
    return json({ error: 'Firestore fetch failed', status: res.status, detail }, 500);
  }

  const data = await res.json();
  return json({ documents: (data.documents || []).map(fromDoc) });
}

// ── GET /?action=list-surveys ──────────────────────────────────────────
async function handleListSurveys(request, env) {
  if (!await requireAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  let token;
  try { token = await getFirestoreToken(env); }
  catch (e) { return json({ error: 'Firestore auth failed', detail: e.message }, 500); }

  const res = await fetch(`${FIRESTORE_BASE}/${SURVEYS_COLL}?pageSize=1000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const detail = await res.text();
    return json({ error: 'Firestore fetch failed', status: res.status, detail }, 500);
  }

  const data = await res.json();
  return json({ documents: (data.documents || []).map(fromSurvey) });
}

// ── POST /api/survey ───────────────────────────────────────────────────
async function handleSurvey(request, env) {
  const ip   = request.headers.get('CF-Connecting-IP') || 'unknown';
  const body = await request.json();

  // Honeypot: bots fill this field, humans don't
  if (body.website) return json({ success: true });

  // Test-email bypass: skip DB write
  const surveyEmail = (body.email || '').trim().toLowerCase() || 'anonymous';
  if (env.TEST_EMAIL && surveyEmail === env.TEST_EMAIL.trim().toLowerCase()) {
    return json({ success: true, test: true });
  }

  if (await checkSurveyRateLimit(ip, env))
    return json({ error: 'Too many submissions' }, 429);

  const email      = surveyEmail;
  const vip        = !!body.vip;
  const session_id = String(body.session_id || '').slice(0, 200);
  const q1         = String(body.q1 || '').slice(0, 500);
  const q2         = String(body.q2 || '').slice(0, 500);
  const q3         = String(body.q3 || '').slice(0, 500);
  const q4         = String(body.q4 || '').slice(0, 500);
  const q5         = String(body.q5 || '').slice(0, 500);
  const utm_content = String(body.utm_content || '').slice(0, 200);

  let token;
  try { token = await getFirestoreToken(env); }
  catch (e) { return json({ error: 'Firestore auth failed' }, 500); }

  const docId  = crypto.randomUUID();
  const putRes = await fetch(`${FIRESTORE_BASE}/${SURVEYS_COLL}?documentId=${docId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: toFields({ id: docId, email, vip, session_id, q1, q2, q3, q4, q5, utm_content, submitted_at: new Date().toISOString() }),
    }),
  });

  if (!putRes.ok) return json({ error: 'Failed to save survey' }, 500);

  // Mark surveyCompleted on the signup doc
  if (email !== 'anonymous') {
    try {
      const signupDoc = await findByEmail(email, token);
      if (signupDoc) {
        await fetch(`${signupDoc.name}?updateMask.fieldPaths=surveyCompleted`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { surveyCompleted: { booleanValue: true } } }),
        });
      }
    } catch (_) {}
  }

  await recordSurveySubmit(ip, env);
  return json({ success: true });
}

// ── POST /api/stripe-webhook ───────────────────────────────────────────
async function handleStripeWebhook(request, env) {
  const rawBody   = await request.text();
  const sigHeader = request.headers.get('stripe-signature') || '';
  const secret    = env.STRIPE_WEBHOOK_SECRET || '';

  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    return json({ error: 'Webhook secret not configured' }, 500);
  }

  const valid = await verifyStripeSignature(rawBody, sigHeader, secret);
  if (!valid) return json({ error: 'Invalid signature' }, 400);

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  // Acknowledge events we don't handle
  if (event.type !== 'checkout.session.completed') return json({ received: true });

  const session    = event.data?.object;
  if (!session) return json({ received: true });

  const sessionId     = session.id || '';
  const customerEmail = (session.customer_details?.email || session.customer_email || '').trim().toLowerCase();
  const clientRef     = (session.client_reference_id || '').trim().toLowerCase();

  let token;
  try { token = await getFirestoreToken(env); }
  catch (e) { console.error('Firestore auth failed:', e.message); return json({ received: true }); }

  // Locate signup doc: try clientRef as UUID doc ID first, then as email, then customerEmail
  let signupDoc = null;
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientRef);
  if (isUUID) {
    signupDoc = await findById(clientRef, COLLECTION, token);
  }
  if (!signupDoc && customerEmail) {
    signupDoc = await findByEmail(customerEmail, token);
  }
  if (!signupDoc && clientRef && !isUUID && clientRef !== customerEmail) {
    signupDoc = await findByEmail(clientRef, token);
  }

  if (signupDoc) {
    // Idempotency: skip if already processed
    const existing = fromDoc(signupDoc);
    if (existing.stripeSessionId === sessionId) return json({ received: true });

    const mask = ['is_vip', 'payment_status', 'vipPaidAt', 'stripeSessionId', 'amount']
      .map(f => `updateMask.fieldPaths=${f}`).join('&');
    const patchRes = await fetch(`${signupDoc.name}?${mask}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFields({ is_vip: true, payment_status: 'paid', vipPaidAt: new Date().toISOString(), stripeSessionId: sessionId, amount: 1 }),
      }),
    });
    if (!patchRes.ok) console.error('Failed to patch signup:', await patchRes.text());
  } else {
    // No matching signup: create a vipOnly record so revenue is tracked
    const email  = customerEmail || clientRef || 'unknown';
    const docId  = crypto.randomUUID();
    await fetch(`${FIRESTORE_BASE}/${COLLECTION}?documentId=${docId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFields({
          id: docId, email, is_vip: true, payment_id: '', payment_status: 'paid',
          created_at: new Date().toISOString(), vipPaidAt: new Date().toISOString(),
          stripeSessionId: sessionId, amount: 1, vipOnly: true,
        }),
      }),
    });
  }

  return json({ received: true });
}

// ── POST / ─────────────────────────────────────────────────────────────
async function handlePost(request, env) {
  const body   = await request.json();
  const action = body.action;
  const email  = (body.email || '').trim().toLowerCase();

  if (!email) return json({ error: 'Missing email' }, 400);

  let token;
  try { token = await getFirestoreToken(env); }
  catch (e) { return json({ error: 'Firestore auth failed', detail: e.message }, 500); }

  // ── signup ─────────────────────────────────────────────────────────
  if (action === 'signup') {
    // Test-email bypass: skip DB read/write, return success without pixels
    if (env.TEST_EMAIL && email === env.TEST_EMAIL.trim().toLowerCase()) {
      return json({ success: true, docId: 'test-doc-id', test: true });
    }

    const existing = await findByEmail(email, token);
    if (existing) return json({ duplicate: true }, 409);

    const utm_content = String(body.utm_content || '').slice(0, 200);
    const docId  = crypto.randomUUID();
    const putRes = await fetch(`${FIRESTORE_BASE}/${COLLECTION}?documentId=${docId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFields({
          id: docId, email, is_vip: false, payment_id: '', payment_status: 'none',
          created_at: new Date().toISOString(), utm_content,
        }),
      }),
    });
    if (!putRes.ok) return json({ error: 'Failed to save signup' }, 500);
    return json({ success: true, docId });
  }

  // ── update-payment ─────────────────────────────────────────────────
  if (action === 'update-payment') {
    const { payment_status } = body;
    if (!['none', 'paid'].includes(payment_status))
      return json({ error: 'Invalid payment_status. Use "none" or "paid".' }, 400);

    const doc = await findByEmail(email, token);
    if (!doc) return json({ error: 'Email not found' }, 404);

    const patchRes = await fetch(`${doc.name}?updateMask.fieldPaths=payment_status`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { payment_status: { stringValue: payment_status } } }),
    });
    if (!patchRes.ok) return json({ error: 'Failed to update payment status' }, 500);
    return json({ success: true });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
}

// ── Main fetch handler ─────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders() });

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/auth/login')            return handleLogin(request, env);
    if (request.method === 'POST' && url.pathname === '/auth/change-password')  return handleChangePassword(request, env);
    if (request.method === 'POST' && url.pathname === '/api/survey')            return handleSurvey(request, env);
    if (request.method === 'POST' && url.pathname === '/api/stripe-webhook')    return handleStripeWebhook(request, env);
    if (request.method === 'GET'  && url.searchParams.get('action') === 'list')          return handleList(request, env);
    if (request.method === 'GET'  && url.searchParams.get('action') === 'list-surveys')  return handleListSurveys(request, env);

    if (request.method === 'GET' && url.searchParams.get('action') === 'debug-hash') {
      const h     = ((await env.ADMIN_RATE_LIMIT.get('admin:password_hash')) || env.ADMIN_PASSWORD_HASH || '').trim();
      const email = env.FIREBASE_CLIENT_EMAIL || '';
      const key   = env.FIREBASE_PRIVATE_KEY  || '';
      return json({
        hash: { length: h.length, prefix: h.substring(0, 7), last4: h.slice(-4), starts_with_2b: h.startsWith('$2b$') },
        firebase: {
          email_set: email.length > 0,
          email_preview: email.substring(0, 20),
          key_set: key.length > 0,
          key_length: key.length,
          key_prefix: key.substring(0, 27),
        }
      });
    }
    if (request.method === 'GET')  return json({ error: 'Not found' }, 404);
    if (request.method === 'POST') return handlePost(request, env);

    return json({ error: 'Method Not Allowed' }, 405);
  },
};
