# Rainföll — Post-Signup Ladder Setup Guide

## What was built

Email signup → VIP $1 offer → decline → free survey  
                            → accept → Stripe → VIP survey  
Stripe webhook → marks signup as VIP in Firestore  
Admin dashboard → VIP metrics, funnel, survey breakdowns  

---

## 1. Cloudflare Worker — New Secret

Add `STRIPE_WEBHOOK_SECRET` to the Worker via the Cloudflare dashboard or Wrangler CLI.  
**Never hardcode this value in source files.**

```bash
# Using Wrangler CLI (run from rainfoll-worker/ directory):
wrangler secret put STRIPE_WEBHOOK_SECRET
# Paste the webhook signing secret from the Stripe dashboard when prompted.
```

Existing secrets still required (unchanged):
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `JWT_SECRET`
- `ADMIN_PASSWORD_HASH`

New secrets for transactional email and server-side conversion tracking:
- `RESEND_API_KEY` — Resend API key (domain `rainfoll.ca` must be verified in Resend first)
- `META_CAPI_ACCESS_TOKEN` — Meta Conversions API access token (Meta Events Manager → pixel `971805995701381`)
- `TIKTOK_EVENTS_API_ACCESS_TOKEN` — TikTok Events API access token (TikTok Events Manager → pixel `D8HHN53C77UDLID68NHG`)

```bash
wrangler secret put RESEND_API_KEY
wrangler secret put META_CAPI_ACCESS_TOKEN
wrangler secret put TIKTOK_EVENTS_API_ACCESS_TOKEN
```

---

## 2. Stripe Payment Link

### Create the Payment Link
1. Go to **Stripe Dashboard → Payment Links → New**
2. Add a product: "Rainföll VIP Deposit" — Price: $1.00 USD (one-time)
3. Under **After payment → Redirect customers to your website**, set:
   ```
   https://rainfoll.ca/vip-survey?session_id={CHECKOUT_SESSION_ID}
   ```
   (Stripe will substitute `{CHECKOUT_SESSION_ID}` automatically.)
4. Copy the Payment Link URL (format: `https://buy.stripe.com/XXXXXXXX`)

### Update the code
Open `landing/preorder.html` and replace the placeholder on this line:

```js
const STRIPE_PAYMENT_LINK = 'https://buy.stripe.com/TODO_REPLACE_WITH_PAYMENT_LINK';
```

Swap `TODO_REPLACE_WITH_PAYMENT_LINK` for your actual Payment Link ID/path.

---

## 3. Stripe Webhook

### Register the webhook endpoint
1. Go to **Stripe Dashboard → Webhooks → Add endpoint**
2. **Endpoint URL:**
   ```
   https://square-violet-0b51.vgagne11.workers.dev/api/stripe-webhook
   ```
3. **Events to subscribe to:**
   - `checkout.session.completed`
4. Click **Add endpoint**
5. Reveal the **Signing secret** (starts with `whsec_...`) and add it to the Worker as `STRIPE_WEBHOOK_SECRET` (see step 1 above)

---

## 4. Survey page URL (for reference)

| Page | URL |
|------|-----|
| Free survey | `https://rainfoll.ca/survey` |
| VIP survey | `https://rainfoll.ca/vip-survey` |
| VIP survey (Stripe redirect) | `https://rainfoll.ca/vip-survey?session_id={CHECKOUT_SESSION_ID}` |

---

## 5. Firestore Collections

Two collections are used (the Worker creates documents automatically — no manual setup needed):

| Collection | Purpose |
|------------|---------|
| `signups` | Email signups + VIP status + Stripe session ID |
| `surveys` | Survey responses (linked to signups via email) |

**New fields added to `signups` documents:**
- `utm_content` — UTM campaign parameter (stored on signup)
- `is_vip` — `true` once Stripe webhook fires
- `vipPaidAt` — ISO timestamp of VIP payment
- `stripeSessionId` — Stripe checkout session ID (used for idempotency)
- `amount` — always `1` for VIP deposits
- `surveyCompleted` — `true` once the user submits either survey
- `vipOnly` — `true` if Stripe payment arrived without a matching signup (rare edge case)

---

## 6. Test-mode walkthrough

Use Stripe test mode (your test Payment Link URL and test webhook) before going live.

### Step-by-step test

1. **Deploy the Worker** (with `STRIPE_WEBHOOK_SECRET` set to your test webhook secret):
   ```bash
   cd rainfoll-worker && wrangler deploy
   ```

2. **Open the signup page:** `https://rainfoll.ca/landing/preorder.html`

3. **Submit an email** → You should see the VIP offer appear (no page reload).  
   Check Firestore `signups` collection: a new document should exist with `is_vip: false`.

4. **Click "Become a VIP — $1"** → You should be redirected to Stripe.  
   Use test card `4242 4242 4242 4242`, any future expiry, any CVC.

5. **Stripe redirects to** `https://rainfoll.ca/vip-survey?session_id=cs_test_...`  
   - Purchase pixel fires once (reload the page — it should NOT re-fire)
   - Fill in the VIP survey and submit
   - Check Firestore `surveys` collection: a new document with `vip: true`

6. **Stripe webhook fires** (usually within seconds):  
   Check Firestore `signups`: the document for your test email should now have:
   - `is_vip: true`
   - `payment_status: "paid"`
   - `stripeSessionId: "cs_test_..."`
   - `vipPaidAt: <timestamp>`

7. **Test the decline path:** Sign up with a second test email → click "No thanks, continue" → complete the free survey → check Firestore `surveys` with `vip: false`

8. **Check admin dashboard** at `https://rainfoll.ca/landing/admin.html`:
   - Overview stats show the 2 signups, 1 VIP, $1 revenue
   - Funnel shows correct counts
   - Survey results show the 2 responses
   - Recent VIPs shows the VIP entry

9. **Switch to live mode** when ready:
   - Create a live Payment Link in Stripe (same settings)
   - Register a live webhook pointing to the same endpoint
   - Update `STRIPE_PAYMENT_LINK` in `landing/preorder.html`
   - Update `STRIPE_WEBHOOK_SECRET` Worker secret with the live signing secret

---

## 7. UTM + attribution tracking

`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, and `utm_id` are read from the URL on
the signup and survey pages and stored in:
- `sessionStorage` (survives navigation within the session)
- The Firestore `signups` document (on signup)
- The Firestore `surveys` document (on survey submit)

`utm_id` should be populated with the ad platform's stable ad-level ID (Meta's `{{ad.id}}` macro,
TikTok's ad-level ID macro) rather than the ad name, since names get renamed/duplicated but IDs
don't — it's the join key when the database and platform reporting disagree.

Click IDs and ad-platform cookies are also captured, since they're what Meta/TikTok actually use
server-side to match a Conversions API / Events API event back to the original ad click (matching
on hashed email alone is materially weaker):
- `fbclid` (URL param) and the `_fbc`/`_fbp` cookies set by the Meta Pixel
- `ttclid` (URL param) and the `_ttp` cookie set by the TikTok Pixel

These are stored on the `signups` doc and looked up by email in the Stripe webhook handler
(`handleStripeWebhook` in `rainfoll-worker/src/worker.js`) so the server-side Purchase event sent
to Meta CAPI / TikTok Events API includes them — see `sendMetaPurchaseEvent` /
`sendTikTokPurchaseEvent`. Sending is still gated on stored `consent_state === 'accepted'`, same as
before.
