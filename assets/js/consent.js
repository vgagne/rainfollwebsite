(function () {
  'use strict';

  var GA_ID = 'G-NLM0KNT900';
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
        initGA4();
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
          initGA4();
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
    initGA4();
  } else if (stored === 'declined') {
    // GA4 stays off
  } else {
    checkGeo();
  }
}());
