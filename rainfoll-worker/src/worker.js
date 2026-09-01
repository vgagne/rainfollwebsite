import { compareSync } from 'bcryptjs';
import signupHtmlRaw from './emails/signup.html';
import signupTextRaw from './emails/signup.txt';
import vipHtmlRaw from './emails/vip.html';
import vipTextRaw from './emails/vip.txt';
import surveyReminderHtmlRaw from './emails/survey-reminder.html';
import surveyReminderTextRaw from './emails/survey-reminder.txt';

const PROJECT_ID     = 'rainfoll-143ef';
const COLLECTION     = 'signups';
const SURVEYS_COLL   = 'surveys';
const FIRESTORE_API_ROOT = 'https://firestore.googleapis.com/v1';
const FIRESTORE_BASE = `${FIRESTORE_API_ROOT}/projects/${PROJECT_ID}/databases/(default)/documents`;

const EMAIL_FROM        = 'Rainföll Inc. <info@rainfoll.ca>';
const EMAIL_REPLY_TO    = 'info@rainfoll.ca';
const COMPANY_ADDRESS   = '1444 Hallmark Pl., Ottawa, Ontario, Canada, K1B 3X3';
const LOGO_URL           = 'https://rainfoll.ca/assets/images/logo/rainfoll-logo-white-noback.png';
const WORKER_BASE_URL    = 'https://square-violet-0b51.vgagne11.workers.dev';
const SITE_BASE_URL      = 'https://rainfoll.ca';
const META_PIXEL_ID      = '971805995701381';
const TIKTOK_PIXEL_ID    = 'D8HHN53C77UDLID68NHG';

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

// ── UTM normalization (case/whitespace-insensitive attribution) ────────
function normalizeUtm(v) {
  return String(v || '').trim().toLowerCase().slice(0, 200);
}

// ── Firestore helpers ──────────────────────────────────────────────────
function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v))             fields[k] = { arrayValue: { values: v.map(s => ({ stringValue: String(s) })) } };
    else if (typeof v === 'string')   fields[k] = { stringValue: v };
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
    utm_source:      f.utm_source?.stringValue      || '',
    utm_medium:      f.utm_medium?.stringValue      || '',
    utm_campaign:    f.utm_campaign?.stringValue    || '',
    utm_content:     f.utm_content?.stringValue     || '',
    vipPaidAt:       f.vipPaidAt?.stringValue       || '',
    stripeSessionId: f.stripeSessionId?.stringValue || '',
    amount:          f.amount?.doubleValue          || 0,
    surveyCompleted: f.surveyCompleted?.booleanValue || false,
    vipOnly:         f.vipOnly?.booleanValue        || false,
    unsubscribed:    f.unsubscribed?.booleanValue   || false,
    unsubscribed_at: f.unsubscribed_at?.stringValue || '',
    surveyReminderSentAt: f.surveyReminderSentAt?.stringValue || '',
    consent_state:   f.consent_state?.stringValue   || '',
  };
}

// Cookie consent state, as reported by the browser at signup time (see
// assets/js/consent.js). Anything other than an explicit 'accepted' is
// treated as no consent — CAPI/TikTok Events API calls are gated on this
// (see sendMetaPurchaseEvent/sendTikTokPurchaseEvent callers).
function normalizeConsentState(v) {
  return v === 'accepted' || v === 'declined' ? v : 'unknown';
}

// Price fields were stored as stringValue before the v3_pre_offer schema
// switched them to doubleValue (see git history around the flow reorder) —
// older survey docs still have their price answers under stringValue.
function parseNumericField(f) {
  if (!f) return null;
  if (f.doubleValue !== undefined) return f.doubleValue;
  if (f.integerValue !== undefined) return Number(f.integerValue);
  if (f.stringValue !== undefined && f.stringValue !== '') {
    const n = Number(f.stringValue);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// appeal was a single stringValue before the multi-select redesign switched
// it to an arrayValue — older survey docs still have it as a plain string.
function parseAppealField(f) {
  const values = f?.arrayValue?.values;
  if (Array.isArray(values) && values.length) return values.map(v => v.stringValue).filter(Boolean);
  if (f?.stringValue) return [f.stringValue];
  return [];
}

function fromSurvey(doc) {
  const f = doc.fields || {};
  return {
    id:                  doc.name?.split('/').pop(),
    email:               f.email?.stringValue               || '',
    vip:                 f.vip?.booleanValue                || false,
    session_id:          f.session_id?.stringValue          || '',
    survey_version:      f.survey_version?.stringValue      || '',
    price_too_expensive: parseNumericField(f.price_too_expensive),
    price_expensive:     parseNumericField(f.price_expensive),
    price_bargain:       parseNumericField(f.price_bargain),
    price_too_cheap:     parseNumericField(f.price_too_cheap),
    appeal:              parseAppealField(f.appeal),
    tenure:              f.tenure?.stringValue              || '',
    utm_source:          f.utm_source?.stringValue          || '',
    utm_medium:          f.utm_medium?.stringValue          || '',
    utm_campaign:        f.utm_campaign?.stringValue        || '',
    utm_content:         f.utm_content?.stringValue         || '',
    submitted_at:        f.submitted_at?.stringValue        || '',
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

async function findLatestSurveyByEmail(email, token) {
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: SURVEYS_COLL }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'email' },
              op: 'EQUAL',
              value: { stringValue: email },
            },
          },
          orderBy: [{ field: { fieldPath: 'submitted_at' }, direction: 'DESCENDING' }],
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

// ── Resend transactional email ─────────────────────────────────────────
async function sendEmail({ to, subject, html, text, unsubscribeUrl }, env) {
  try {
    if (!env.RESEND_API_KEY) { console.error('RESEND_API_KEY not configured'); return; }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: EMAIL_FROM, to, subject, html, text, reply_to: EMAIL_REPLY_TO,
        ...(unsubscribeUrl ? {
          headers: {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        } : {}),
      }),
    });
    if (!res.ok) console.error('Resend send failed:', await res.text());
  } catch (e) {
    console.error('Resend send error:', e.message);
  }
}

function emailShell(bodyHtml, unsubscribeUrl) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f2ef;font-family:Georgia,'Times New Roman',serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ef;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#0d0d0d;border-radius:12px;overflow:hidden;">
          <tr><td style="padding:32px 32px 16px;text-align:center;">
            <img src="${LOGO_URL}" alt="Rainföll" width="140" style="display:inline-block;" />
          </td></tr>
          <tr><td style="padding:0 32px 32px;color:#d1d5db;font-size:15px;line-height:1.6;">
            ${bodyHtml}
          </td></tr>
          <tr><td style="padding:16px 32px 32px;border-top:1px solid rgba(220,201,182,0.2);color:#8a8a8a;font-size:12px;text-align:center;">
            Rainföll Inc. &middot; <a href="https://rainfoll.ca" style="color:#DCC9B6;">rainfoll.ca</a><br/>
            <a href="${unsubscribeUrl}" style="color:#8a8a8a;">Unsubscribe</a><br/>
            <span style="font-size:9px;color:#5a5a5a;">${COMPANY_ADDRESS}</span>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

// ── Editable email content (see src/emails/*.html + *.txt) ─────────────
function parseTemplate(raw) {
  const m = raw.match(/^<!--\s*SUBJECT:\s*(.+?)\s*-->/);
  return {
    subject: m ? m[1] : '',
    body: m ? raw.slice(m[0].length).trim() : raw.trim(),
  };
}

function renderTemplate(str, vars) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));
}

async function buildEmail(htmlRaw, textRaw, vars, env) {
  const { subject, body } = parseTemplate(htmlRaw);
  const { pageUrl, apiUrl } = await buildUnsubscribeUrls(vars.email, env);
  const allVars = { ...vars, unsubscribe_url: pageUrl };
  const html = emailShell(renderTemplate(body, allVars), pageUrl);
  const text = `${renderTemplate(textRaw, allVars)}\n\nUnsubscribe: ${pageUrl}`;
  return { subject: renderTemplate(subject, allVars), html, text, unsubscribeUrl: apiUrl };
}

// ── Unsubscribe tokens (HMAC-signed, reuses the session JWT helpers) ───
// pageUrl: shown to humans in the email body/footer (rainfoll.ca — no workers.dev URL visible).
// apiUrl: the real worker endpoint, used only for the invisible List-Unsubscribe header
// (mail-client one-click POST targets this directly; it can't execute the page's JS).
async function buildUnsubscribeUrls(email, env) {
  const token = await signSessionJWT(
    { purpose: 'unsubscribe', email, exp: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600 },
    env.JWT_SECRET
  );
  const encoded = encodeURIComponent(token);
  return {
    pageUrl: `${SITE_BASE_URL}/unsubscribe/?token=${encoded}`,
    apiUrl: `${WORKER_BASE_URL}/api/unsubscribe?token=${encoded}`,
  };
}

function htmlPage(message, status = 200) {
  return new Response(
    `<!doctype html><html><body style="font-family:Georgia,serif;background:#f4f2ef;padding:48px 16px;text-align:center;color:#0d0d0d;"><p>${message}</p></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

// ── SHA-256 hex (Meta/TikTok advanced matching) ────────────────────────
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Server-side conversion events (Meta CAPI / TikTok Events API) ──────
async function sendMetaPurchaseEvent({ email, sessionId, amount }, env) {
  try {
    if (!env.META_CAPI_ACCESS_TOKEN) { console.error('META_CAPI_ACCESS_TOKEN not configured'); return; }
    const hashedEmail = await sha256Hex(email.trim().toLowerCase());
    const res = await fetch(`https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events?access_token=${env.META_CAPI_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [{
          event_name: 'Purchase',
          event_time: Math.floor(Date.now() / 1000),
          event_id: sessionId,
          action_source: 'website',
          event_source_url: 'https://rainfoll.ca/vip-survey',
          user_data: { em: [hashedEmail] },
          custom_data: { currency: 'USD', value: amount },
          // Limited Data Use — country/state left at 0 so Meta geolocates the
          // user and applies the restriction only where legally required.
          data_processing_options: ['LDU'],
          data_processing_options_country: 0,
          data_processing_options_state: 0,
        }],
      }),
    });
    if (!res.ok) console.error('Meta CAPI send failed:', await res.text());
  } catch (e) {
    console.error('Meta CAPI send error:', e.message);
  }
}

async function sendTikTokPurchaseEvent({ email, sessionId, amount }, env) {
  try {
    if (!env.TIKTOK_EVENTS_API_ACCESS_TOKEN) { console.error('TIKTOK_EVENTS_API_ACCESS_TOKEN not configured'); return; }
    const hashedEmail = await sha256Hex(email.trim().toLowerCase());
    const res = await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
      method: 'POST',
      headers: { 'Access-Token': env.TIKTOK_EVENTS_API_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event_source: 'web',
        event_source_id: TIKTOK_PIXEL_ID,
        data: [{
          event: 'CompletePayment',
          event_id: sessionId,
          event_time: Math.floor(Date.now() / 1000),
          user: { email: hashedEmail },
          properties: { currency: 'USD', value: amount },
          limited_data_use: true,
        }],
      }),
    });
    if (!res.ok) console.error('TikTok Events API send failed:', await res.text());
  } catch (e) {
    console.error('TikTok Events API send error:', e.message);
  }
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

// ── POST /api/backfill-survey-vip ───────────────────────────────────────
// One-time reconciliation: the survey.vip flag and the signup.surveyCompleted
// flag were both silently failing to write (see the doc.name URL bug fix) for
// as long as the reordered signup->survey->VIP flow has existed. This walks
// existing records and corrects them; it's idempotent, safe to re-run.
async function handleBackfillSurveyVip(request, env) {
  if (!await requireAuth(request, env)) return json({ error: 'Unauthorized' }, 401);

  let token;
  try { token = await getFirestoreToken(env); }
  catch (e) { return json({ error: 'Firestore auth failed', detail: e.message }, 500); }

  const [signupsRes, surveysRes] = await Promise.all([
    fetch(`${FIRESTORE_BASE}/${COLLECTION}?pageSize=1000`, { headers: { Authorization: `Bearer ${token}` } }),
    fetch(`${FIRESTORE_BASE}/${SURVEYS_COLL}?pageSize=1000`, { headers: { Authorization: `Bearer ${token}` } }),
  ]);
  if (!signupsRes.ok || !surveysRes.ok) return json({ error: 'Failed to fetch data for reconciliation' }, 500);

  const signups = ((await signupsRes.json()).documents || []).map(doc => ({ raw: doc, data: fromDoc(doc) }));
  const surveys = ((await surveysRes.json()).documents || []).map(doc => ({ raw: doc, data: fromSurvey(doc) }));

  // Latest survey per email (mirrors findLatestSurveyByEmail's ordering)
  const latestSurveyByEmail = new Map();
  const emailsWithSurvey = new Set();
  for (const s of surveys) {
    if (!s.data.email) continue;
    emailsWithSurvey.add(s.data.email);
    const existing = latestSurveyByEmail.get(s.data.email);
    if (!existing || s.data.submitted_at > existing.data.submitted_at) latestSurveyByEmail.set(s.data.email, s);
  }

  let vipFixed = 0, vipSkipped = 0, vipErrors = 0;
  let completedFixed = 0, completedSkipped = 0, completedErrors = 0;

  for (const { raw, data } of signups) {
    if (!data.email) continue;

    // 1) Survey vip flag should be true for anyone who is actually a VIP now
    if (data.is_vip) {
      const survey = latestSurveyByEmail.get(data.email);
      if (!survey || survey.data.vip) {
        vipSkipped++;
      } else {
        const mask = ['vip', 'session_id'].map(f => `updateMask.fieldPaths=${f}`).join('&');
        const patchRes = await fetch(`${FIRESTORE_API_ROOT}/${survey.raw.name}?${mask}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: toFields({ vip: true, session_id: data.stripeSessionId || survey.data.session_id || '' }) }),
        });
        if (patchRes.ok) { vipFixed++; survey.data.vip = true; } else vipErrors++;
      }
    }

    // 2) surveyCompleted should be true for anyone with a survey doc on file
    if (!data.surveyCompleted && emailsWithSurvey.has(data.email)) {
      const patchRes = await fetch(`${FIRESTORE_API_ROOT}/${raw.name}?updateMask.fieldPaths=surveyCompleted`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { surveyCompleted: { booleanValue: true } } }),
      });
      if (patchRes.ok) completedFixed++; else completedErrors++;
    } else if (!data.surveyCompleted) {
      completedSkipped++;
    }
  }

  return json({
    success: true,
    vip: { fixed: vipFixed, skipped: vipSkipped, errors: vipErrors },
    surveyCompleted: { fixed: completedFixed, skipped: completedSkipped, errors: completedErrors },
  });
}

// ── Scheduled: survey reminder (daily cron) ─────────────────────────────
// Reminds signups who haven't completed the pricing survey once they cross
// the one-week mark. The cron runs daily, so the window is 7-8 days old
// (not "exactly 7 days") to guarantee everyone gets caught by some run.
async function handleSurveyReminders(env) {
  let token;
  try { token = await getFirestoreToken(env); }
  catch (e) { console.error('Survey reminder: Firestore auth failed:', e.message); return; }

  const res = await fetch(`${FIRESTORE_BASE}/${COLLECTION}?pageSize=1000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) { console.error('Survey reminder: failed to fetch signups:', await res.text()); return; }

  const data = await res.json();
  const docs = (data.documents || []);

  const MS_DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const windowOld = now - 8 * MS_DAY;
  const windowNew = now - 7 * MS_DAY;

  let sent = 0, errors = 0;
  for (const doc of docs) {
    const signup = fromDoc(doc);
    if (!signup.email || !signup.email.includes('@')) continue;
    if (signup.surveyCompleted || signup.unsubscribed) continue;
    if (signup.surveyReminderSentAt) continue;

    const createdMs = Date.parse(signup.created_at);
    if (!Number.isFinite(createdMs)) continue;
    if (createdMs < windowOld || createdMs >= windowNew) continue;

    try {
      const survey_url = `${SITE_BASE_URL}/survey?email=${encodeURIComponent(signup.email)}`;
      const { subject, html, text, unsubscribeUrl } = await buildEmail(
        surveyReminderHtmlRaw, surveyReminderTextRaw, { email: signup.email, survey_url }, env
      );
      await sendEmail({ to: signup.email, subject, html, text, unsubscribeUrl }, env);

      await fetch(`${FIRESTORE_API_ROOT}/${doc.name}?updateMask.fieldPaths=surveyReminderSentAt`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: toFields({ surveyReminderSentAt: new Date().toISOString() }) }),
      });
      sent++;
    } catch (e) {
      console.error('Survey reminder: failed to send to', signup.email, e.message);
      errors++;
    }
  }

  console.log(`Survey reminders: sent=${sent} errors=${errors}`);
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

  const email = surveyEmail;

  const price_too_expensive = Number(body.price_too_expensive);
  const price_expensive     = Number(body.price_expensive);
  const price_bargain       = Number(body.price_bargain);
  const price_too_cheap     = Number(body.price_too_cheap);
  for (const n of [price_too_expensive, price_expensive, price_bargain, price_too_cheap]) {
    if (!Number.isFinite(n) || n < 1 || n > 2000) return json({ error: 'Invalid price values' }, 400);
  }

  const appeal        = Array.isArray(body.appeal) ? body.appeal.map(a => String(a).slice(0, 200)).slice(0, 2) : [];
  const tenure         = String(body.tenure     || '').slice(0, 100);
  const utm_source     = normalizeUtm(body.utm_source);
  const utm_medium     = normalizeUtm(body.utm_medium);
  const utm_campaign   = normalizeUtm(body.utm_campaign);
  const utm_content    = normalizeUtm(body.utm_content);

  let token;
  try { token = await getFirestoreToken(env); }
  catch (e) { return json({ error: 'Firestore auth failed' }, 500); }

  const docId  = crypto.randomUUID();
  const putRes = await fetch(`${FIRESTORE_BASE}/${SURVEYS_COLL}?documentId=${docId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: toFields({
        id: docId, email, vip: false, session_id: '', survey_version: 'v3_pre_offer',
        price_too_expensive, price_expensive, price_bargain, price_too_cheap,
        appeal, tenure,
        utm_source, utm_medium, utm_campaign, utm_content,
        submitted_at: new Date().toISOString(),
      }),
    }),
  });

  if (!putRes.ok) return json({ error: 'Failed to save survey' }, 500);

  // Mark surveyCompleted on the signup doc
  if (email !== 'anonymous') {
    try {
      const signupDoc = await findByEmail(email, token);
      if (signupDoc) {
        await fetch(`${FIRESTORE_API_ROOT}/${signupDoc.name}?updateMask.fieldPaths=surveyCompleted`, {
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

  let vipEmail = '';
  let vipUnsubscribed = false;
  // Default-deny: only a stored 'accepted' consent state permits server-side
  // conversion events. Records with no consent info on file (e.g. the vipOnly
  // fallback below, which has no prior signup to read consent from) stay gated off.
  let vipConsentAccepted = false;

  if (signupDoc) {
    // Idempotency: skip if already processed
    const existing = fromDoc(signupDoc);
    if (existing.stripeSessionId === sessionId) return json({ received: true });

    const mask = ['is_vip', 'payment_status', 'vipPaidAt', 'stripeSessionId', 'amount']
      .map(f => `updateMask.fieldPaths=${f}`).join('&');
    const patchRes = await fetch(`${FIRESTORE_API_ROOT}/${signupDoc.name}?${mask}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFields({ is_vip: true, payment_status: 'paid', vipPaidAt: new Date().toISOString(), stripeSessionId: sessionId, amount: 1 }),
      }),
    });
    if (!patchRes.ok) console.error('Failed to patch signup:', await patchRes.text());
    else {
      vipEmail = existing.email || customerEmail;
      vipUnsubscribed = existing.unsubscribed;
      vipConsentAccepted = existing.consent_state === 'accepted';
    }
  } else {
    // No matching signup: create a vipOnly record so revenue is tracked
    const email  = customerEmail || clientRef || 'unknown';
    const docId  = crypto.randomUUID();
    const createRes = await fetch(`${FIRESTORE_BASE}/${COLLECTION}?documentId=${docId}`, {
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
    if (createRes.ok && email.includes('@')) vipEmail = email;
  }

  if (vipEmail) {
    await Promise.allSettled([
      vipUnsubscribed ? Promise.resolve() : (async () => {
        const { subject, html, text, unsubscribeUrl } = await buildEmail(vipHtmlRaw, vipTextRaw, { email: vipEmail }, env);
        await sendEmail({ to: vipEmail, subject, html, text, unsubscribeUrl }, env);
      })(),
      vipConsentAccepted ? sendMetaPurchaseEvent({ email: vipEmail, sessionId, amount: 1 }, env) : Promise.resolve(),
      vipConsentAccepted ? sendTikTokPurchaseEvent({ email: vipEmail, sessionId, amount: 1 }, env) : Promise.resolve(),
      (async () => {
        try {
          const surveyDoc = await findLatestSurveyByEmail(vipEmail, token);
          if (!surveyDoc) return; // No survey on file for this email — nothing to update
          const mask = ['vip', 'session_id'].map(f => `updateMask.fieldPaths=${f}`).join('&');
          await fetch(`${FIRESTORE_API_ROOT}/${surveyDoc.name}?${mask}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: toFields({ vip: true, session_id: sessionId }) }),
          });
        } catch (e) {
          console.error('Failed to write back VIP status to survey doc:', e.message);
        }
      })(),
    ]);
  }

  return json({ received: true });
}

// ── GET/POST /api/unsubscribe ───────────────────────────────────────────
async function handleUnsubscribe(request, env) {
  const url   = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  const isPost = request.method === 'POST';

  const payload = token && await verifySessionJWT(token, env.JWT_SECRET);
  if (!payload || payload.purpose !== 'unsubscribe' || !payload.email) {
    return isPost ? json({ error: 'Invalid or expired link' }, 400) : htmlPage('This unsubscribe link is invalid or has expired.', 400);
  }

  let fToken;
  try { fToken = await getFirestoreToken(env); }
  catch (e) {
    return isPost ? json({ error: 'Server error' }, 500) : htmlPage('Something went wrong. Please try again later.', 500);
  }

  try {
    const doc = await findByEmail(payload.email, fToken);
    if (doc) {
      const mask = ['unsubscribed', 'unsubscribed_at'].map(f => `updateMask.fieldPaths=${f}`).join('&');
      await fetch(`${FIRESTORE_API_ROOT}/${doc.name}?${mask}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${fToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: toFields({ unsubscribed: true, unsubscribed_at: new Date().toISOString() }) }),
      });
    }
  } catch (e) {
    console.error('Failed to record unsubscribe:', e.message);
    return isPost ? json({ error: 'Server error' }, 500) : htmlPage('Something went wrong. Please try again later.', 500);
  }

  if (isPost) return json({ success: true });
  return htmlPage("You've been unsubscribed and won't receive further emails from Rainföll.");
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

    const consent_state = normalizeConsentState(body.consent_state);

    const existing = await findByEmail(email, token);
    if (existing) {
      const existingData = fromDoc(existing);
      if (!existingData.unsubscribed) return json({ duplicate: true }, 409);

      // Previously unsubscribed: treat a fresh signup as opting back in
      const mask = ['unsubscribed', 'consent_state'].map(f => `updateMask.fieldPaths=${f}`).join('&');
      await fetch(`${FIRESTORE_API_ROOT}/${existing.name}?${mask}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: toFields({ unsubscribed: false, consent_state }) }),
      });

      const { subject, html, text, unsubscribeUrl } = await buildEmail(signupHtmlRaw, signupTextRaw, { email }, env);
      await sendEmail({ to: email, subject, html, text, unsubscribeUrl }, env);

      return json({ success: true, docId: existingData.id, resubscribed: true });
    }

    const utm_source   = normalizeUtm(body.utm_source);
    const utm_medium   = normalizeUtm(body.utm_medium);
    const utm_campaign = normalizeUtm(body.utm_campaign);
    const utm_content  = normalizeUtm(body.utm_content);
    const docId  = crypto.randomUUID();
    const putRes = await fetch(`${FIRESTORE_BASE}/${COLLECTION}?documentId=${docId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFields({
          id: docId, email, is_vip: false, payment_id: '', payment_status: 'none',
          created_at: new Date().toISOString(), utm_source, utm_medium, utm_campaign, utm_content,
          consent_state,
        }),
      }),
    });
    if (!putRes.ok) return json({ error: 'Failed to save signup' }, 500);

    const { subject, html, text, unsubscribeUrl } = await buildEmail(signupHtmlRaw, signupTextRaw, { email }, env);
    await sendEmail({ to: email, subject, html, text, unsubscribeUrl }, env);

    return json({ success: true, docId });
  }

  // ── update-payment ─────────────────────────────────────────────────
  if (action === 'update-payment') {
    const { payment_status } = body;
    if (!['none', 'paid'].includes(payment_status))
      return json({ error: 'Invalid payment_status. Use "none" or "paid".' }, 400);

    const doc = await findByEmail(email, token);
    if (!doc) return json({ error: 'Email not found' }, 404);

    const patchRes = await fetch(`${FIRESTORE_API_ROOT}/${doc.name}?updateMask.fieldPaths=payment_status`, {
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
    if (request.method === 'POST' && url.pathname === '/api/backfill-survey-vip') return handleBackfillSurveyVip(request, env);
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/api/unsubscribe') return handleUnsubscribe(request, env);
    if (request.method === 'GET'  && url.searchParams.get('action') === 'list')          return handleList(request, env);
    if (request.method === 'GET'  && url.searchParams.get('action') === 'list-surveys')  return handleListSurveys(request, env);

    if (request.method === 'GET')  return json({ error: 'Not found' }, 404);
    if (request.method === 'POST') return handlePost(request, env);

    return json({ error: 'Method Not Allowed' }, 405);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleSurveyReminders(env));
  },
};
