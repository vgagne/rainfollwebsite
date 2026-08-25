(function () {
  'use strict';

  var GA_ID = 'G-NLM0KNT900';
  var META_PIXEL_ID = '971805995701381';
  var TIKTOK_PIXEL_ID = 'D8HHN53C77UDLID68NHG';
  var STORAGE_KEY = 'cookie_consent';

  function initGA4() {
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { dataLayer.push(arguments); };
    gtag('js', new Date());
    gtag('config', GA_ID);
  }

  function initMetaPixel() {
    if (window.fbq) return;
    !function(f,b,e,v,n,t,s)
    {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
    n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s)}(window, document,'script',
    'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', META_PIXEL_ID);
    fbq('track', 'PageView');
  }

  function initTikTokPixel() {
    if (window.ttq && window.ttq.loaded) return;
    !function (w, d, t) {
      w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(
      var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js",o=n&&n.partner;ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};n=document.createElement("script")
      ;n.type="text/javascript",n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;e=document.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};
      ttq.load(TIKTOK_PIXEL_ID);
      ttq.page();
    }(window, document, 'ttq');
  }

  function initTracking() {
    initGA4();
    initMetaPixel();
    initTikTokPixel();
  }

  function hideBanner() {
    var el = document.getElementById('consent-banner');
    if (el) el.remove();
  }

  function showBanner() {
    function render() {
      var banner = document.createElement('div');
      banner.id = 'consent-banner';
      banner.setAttribute('role', 'dialog');
      banner.setAttribute('aria-label', 'Cookie consent');
      banner.style.cssText = [
        'position:fixed', 'bottom:0', 'left:0', 'right:0', 'z-index:99999',
        'background:#0d0d0d',
        'border-top:1px solid rgba(220,201,182,0.4)',
        'padding:16px 24px',
        'display:flex', 'align-items:center', 'justify-content:space-between',
        'gap:16px', 'flex-wrap:wrap',
        'font-family:Inter,system-ui,-apple-system,sans-serif',
        'font-size:14px', 'color:#d1d5db',
        'box-shadow:0 -4px 24px rgba(0,0,0,0.5)'
      ].join(';');

      var text = document.createElement('p');
      text.style.cssText = 'margin:0;line-height:1.6;flex:1;min-width:200px';
      text.innerHTML = 'We use analytics cookies to understand how visitors use our site. '
        + 'You can accept or decline non-essential cookies. '
        + '<a href="/privacy-policy.html" '
        + 'style="color:#DCC9B6;text-decoration:underline;white-space:nowrap">'
        + 'Privacy Policy</a>';

      var btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:10px;flex-shrink:0';

      var decline = document.createElement('button');
      decline.textContent = 'Decline';
      decline.style.cssText = [
        'padding:8px 20px', 'border-radius:9999px',
        'border:1px solid rgba(220,201,182,0.45)',
        'background:transparent', 'color:#d1d5db',
        'font-size:13px', 'font-weight:500', 'cursor:pointer',
        'font-family:inherit'
      ].join(';');
      decline.onmouseover = function () { this.style.borderColor = '#DCC9B6'; };
      decline.onmouseout  = function () { this.style.borderColor = 'rgba(220,201,182,0.45)'; };

      var accept = document.createElement('button');
      accept.textContent = 'Accept';
      accept.style.cssText = [
        'padding:8px 20px', 'border-radius:9999px',
        'border:1px solid transparent',
        'background:#DCC9B6', 'color:#0d0d0d',
        'font-size:13px', 'font-weight:600', 'cursor:pointer',
        'font-family:inherit'
      ].join(';');
      accept.onmouseover = function () { this.style.background = '#c9b49f'; };
      accept.onmouseout  = function () { this.style.background = '#DCC9B6'; };

      decline.addEventListener('click', function () {
        localStorage.setItem(STORAGE_KEY, 'declined');
        hideBanner();
      });

      accept.addEventListener('click', function () {
        localStorage.setItem(STORAGE_KEY, 'accepted');
        hideBanner();
        initTracking();
      });

      btns.appendChild(decline);
      btns.appendChild(accept);
      banner.appendChild(text);
      banner.appendChild(btns);
      document.body.appendChild(banner);
    }

    if (document.body) {
      render();
    } else {
      document.addEventListener('DOMContentLoaded', render);
    }
  }

  function checkGeo() {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, 5000);

    fetch('https://ipapi.co/json/', controller ? { signal: controller.signal } : {})
      .then(function (r) { return r.json(); })
      .then(function (data) {
        clearTimeout(timer);
        if (data && data.country_code === 'US') {
          initTracking();
        } else {
          showBanner();
        }
      })
      .catch(function () {
        clearTimeout(timer);
        showBanner();
      });
  }

  // ── Entry point ──────────────────────────────────────────────
  var stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'accepted') {
    initTracking();
  } else if (stored === 'declined') {
    // Tracking stays off
  } else {
    checkGeo();
  }
}());
