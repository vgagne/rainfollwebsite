import { compareSync } from 'bcryptjs';

const PROJECT_ID   = 'rainfoll-143ef';
const COLLECTION   = 'signups';
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
  const { access_token } = await res.json();
  return access_token;
}

// ── Firestore helpers ──────────────────────────────────────────────────
function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string')  fields[k] = { stringValue: v };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
  }
  return fields;
}

function fromDoc(doc) {
  const f = doc.fields || {};
  return {
    id:             doc.name?.split('/').pop(),
    email:          f.email?.stringValue          || '',
    created_at:     f.created_at?.stringValue     || '',
    vip:            f.vip?.booleanValue           || false,
    payment_status: f.payment_status?.stringValue || 'none',
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

// ── Rate limiting ──────────────────────────────────────────────────────
const MAX_ATTEMPTS     = 10;
const LOCKOUT_SECONDS  = 900; // 15 min

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

// ── POST /auth/login ───────────────────────────────────────────────────
async function handleLogin(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { password } = await request.json();

  const limit = await checkRateLimit(ip, env);
  if (limit.blocked)
    return json({ error: 'Too many failed attempts', locked_until: limit.lockedUntil, retry_after_seconds: limit.retry_after_seconds }, 429);

  const hash = (await env.ADMIN_RATE_LIMIT.get('admin:password_hash')) || env.ADMIN_PASSWORD_HASH;
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
  const currentHash = (await env.ADMIN_RATE_LIMIT.get('admin:password_hash')) || env.ADMIN_PASSWORD_HASH;

  if (!compareSync(old_password, currentHash))
    return json({ error: 'Current password is incorrect' }, 403);

  await env.ADMIN_RATE_LIMIT.put('admin:password_hash', new_password_hash);
  return json({ success: true });
}

// ── GET /?action=list ──────────────────────────────────────────────────
async function handleList(request, env) {
  if (!await requireAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  const token = await getFirestoreToken(env);
  const res   = await fetch(`${FIRESTORE_BASE}/${COLLECTION}?pageSize=1000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return json({ error: 'Failed to fetch signups' }, 500);

  const data = await res.json();
  return json({ documents: (data.documents || []).map(fromDoc) });
}

// ── POST / ─────────────────────────────────────────────────────────────
async function handlePost(request, env) {
  const body   = await request.json();
  const action = body.action;
  const email  = (body.email || '').trim().toLowerCase();

  if (!email) return json({ error: 'Missing email' }, 400);

  const token = await getFirestoreToken(env);

  // ── signup ─────────────────────────────────────────────────────────
  if (action === 'signup') {
    const existing = await findByEmail(email, token);
    if (existing) return json({ duplicate: true }, 409);

    const docId  = crypto.randomUUID();
    const putRes = await fetch(`${FIRESTORE_BASE}/${COLLECTION}?documentId=${docId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFields({ id: docId, email, created_at: new Date().toISOString(), vip: false, payment_status: 'none' }),
      }),
    });
    if (!putRes.ok) return json({ error: 'Failed to save signup' }, 500);
    return json({ success: true });
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

    if (request.method === 'POST' && url.pathname === '/auth/login')           return handleLogin(request, env);
    if (request.method === 'POST' && url.pathname === '/auth/change-password') return handleChangePassword(request, env);
    if (request.method === 'GET'  && url.searchParams.get('action') === 'list') return handleList(request, env);
    if (request.method === 'GET')  return json({ error: 'Not found' }, 404);
    if (request.method === 'POST') return handlePost(request, env);

    return json({ error: 'Method Not Allowed' }, 405);
  },
};
