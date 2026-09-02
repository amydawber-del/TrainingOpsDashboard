/**
 * =====================================================================
 * STREET TRAINING DASHBOARD — HOLIDAY ICS FIX PATCH  v2.3
 * =====================================================================
 *
 * Changes vs v2.2
 * ---------------
 *  • Humaans calendar-feeds URLs are NO LONGER treated as dead. v2.2
 *    wiped them from localStorage on every load and blanked the Cal
 *    Settings input, which is why the leave feed kept "unsyncing".
 *
 *  • Humaans feeds are now fetched via the Apps Script backend
 *    (?action=getIcs&url=…) which uses UrlFetchApp and is not subject
 *    to browser CORS. The public CORS proxies are only used as a
 *    fallback if the Apps Script route fails.
 *
 *  • Only the genuinely dead legacy shape
 *    (app.humaans.io/api/public-holidays/ical/) is still blocked.
 *
 *  • bankHolidayMap backfill (GOV.UK) is kept as a last resort for
 *    public holidays if every route fails.
 *
 *  • getBookingDates invalid-Date guard, Cal Settings tidy-up and
 *    retry-button fix are unchanged from v2.2.
 *
 * REQUIRES: a `getIcs` action in Code.gs (see gas-getIcs-snippet.gs).
 * =====================================================================
 */
(function () {
  'use strict';

  // Genuinely dead — old token-based public-holiday endpoint only
  var DEAD_FRAGMENTS = [
    'app.humaans.io/api/public-holidays/ical/',
  ];
  // Feeds we route through Apps Script (CORS-safe)
  var PROXY_FRAGMENTS = [
    'app.humaans.io/calendar-feeds/',
  ];

  function _isDead(url) {
    if (typeof url !== 'string') return false;
    return DEAD_FRAGMENTS.some(function (f) { return url.includes(f); });
  }
  function _isProxied(url) {
    if (typeof url !== 'string') return false;
    return PROXY_FRAGMENTS.some(function (f) { return url.includes(f); });
  }

  // Synchronously wipe only the legacy dead URL from localStorage
  (function () {
    try {
      ['calHolidayIcs', 'calLeaveIcs'].forEach(function (key) {
        var val = localStorage.getItem(key) || '';
        if (_isDead(val)) {
          localStorage.removeItem(key);
          _log('Removed legacy dead Humaans URL from localStorage (' + key + ').');
        }
      });
    } catch (e) {}
  }());

  var _attempts = 0;
  function bootstrap() {
    _attempts++;
    var ready = typeof window.fetchIcs       === 'function'
             && typeof window.loadIcsData    === 'function'
             && typeof window.renderCalendar === 'function';
    if (!ready && _attempts < 80) { setTimeout(bootstrap, 150); return; }
    patch_fetchIcs();
    patch_loadIcsData();
    patch_getBookingDates();
    patch_calSettings();
    inject_retryFix();
    _log('Loaded after ' + _attempts + ' attempt(s).');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  // ── 1. fetchIcs — block legacy dead URL, route Humaans via Apps Script ──
  function patch_fetchIcs() {
    var _orig = window.fetchIcs;
    window.fetchIcs = async function (url) {
      if (_isDead(url)) {
        _log('Blocked legacy dead Humaans URL — no network request made: ' + url);
        return '';
      }
      if (_isProxied(url)) {
        var viaGas = await _fetchIcsViaAppsScript(url);
        if (viaGas) return viaGas;
        _log('Apps Script route failed — falling back to browser proxies for: ' + url);
      }
      return _orig.apply(this, arguments);
    };
  }

  // Fetch an ICS body through the Apps Script web app.
  // Expects { success: true, ics: "BEGIN:VCALENDAR…" } from ?action=getIcs
  async function _fetchIcsViaAppsScript(url) {
    var base = (typeof window.SCRIPT_URL !== 'undefined' && window.SCRIPT_URL)
            || (typeof SCRIPT_URL !== 'undefined' && SCRIPT_URL) || '';
    if (!base) { _log('SCRIPT_URL not set — cannot proxy ICS via Apps Script.'); return ''; }
    try {
      var res  = await fetch(base + '?action=getIcs&url=' + encodeURIComponent(url) + '&t=' + Date.now(),
                             { method: 'GET', redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var json = await res.json();
      if (!json || !json.success || typeof json.ics !== 'string') {
        throw new Error((json && json.error) || 'No ICS in response');
      }
      if (!json.ics.includes('BEGIN:VCALENDAR') && !json.ics.includes('BEGIN:VEVENT')) {
        throw new Error('Not valid iCal data');
      }
      _log('ICS fetched via Apps Script (' + json.ics.length + ' chars): ' + url);
      return json.ics;
    } catch (e) {
      _log('Apps Script ICS fetch error: ' + (e && e.message));
      return '';
    }
  }

  // ── 2. After loadIcsData, backfill public holidays if still empty ──
  function patch_loadIcsData() {
    var _orig = window.loadIcsData;
    window.loadIcsData = async function () {
      await _orig.apply(this, arguments);
      if (window.calIcsEvents && window.calIcsEvents.length > 0) {
        _log('Holiday feed returned data — no backfill needed.');
        if (window.calLeaveEvents && window.calLeaveEvents.length > 0) _dismissFeedBanner();
        return;
      }
      _backfill();
    };
  }

  // ── _backfill: read bankHolidayMap (no extra network request) ─────
  function _backfill(attempt) {
    attempt = attempt || 0;
    var map  = window.bankHolidayMap;
    var keys = map ? Object.keys(map) : [];

    if (!keys.length) {
      if (attempt < 20) {
        _log('bankHolidayMap not ready — retrying in 500 ms (attempt ' + (attempt + 1) + ').');
        setTimeout(function () { _backfill(attempt + 1); }, 500);
      } else {
        _log('bankHolidayMap still empty after retries — giving up.');
      }
      return;
    }

    window.calIcsEvents = keys.map(function (dateStr) {
      var parts = dateStr.split('-');
      var y = parseInt(parts[0], 10);
      var m = parseInt(parts[1], 10) - 1;
      var d = parseInt(parts[2], 10);
      return { summary: map[dateStr], start: new Date(y, m, d), end: new Date(y, m, d + 1), type: 'holiday' };
    });

    _log('Synthesised ' + window.calIcsEvents.length + ' bank holidays from bankHolidayMap.');
    _updateStatusBar();
    if (typeof window.renderCalendar === 'function') window.renderCalendar();
  }

  // ── 3. Guard getBookingDates against invalid Date objects ─────────
  function patch_getBookingDates() {
    if (typeof window.getBookingDates !== 'function') {
      _log('getBookingDates not found — skipping guard patch.');
      return;
    }
    var _orig = window.getBookingDates;
    window.getBookingDates = function (r) {
      if (r && r.bookedOn) {
        var t = r.bookedOn instanceof Date ? r.bookedOn.getTime() : NaN;
        if (isNaN(t)) {
          _log('Skipping row with invalid bookedOn: ' + JSON.stringify(r.bookedOn));
          return [];
        }
      }
      return _orig.apply(this, arguments);
    };
  }

  // ── 4. Cal Settings modal — only clear the legacy dead URL ─────────
  function patch_calSettings() {
    var _origOpen = window.openCalSettings;
    if (typeof _origOpen !== 'function') return;
    window.openCalSettings = function () {
      _origOpen.apply(this, arguments);
      ['calHolidayIcsInput', 'calLeaveIcsInput'].forEach(function (id) {
        var input = document.getElementById(id);
        if (!input) return;
        if (_isDead(input.value)) input.value = '';
      });
      var input = document.getElementById('calHolidayIcsInput');
      if (input) {
        var hint = input.nextElementSibling;
        if (hint && hint.classList.contains('form-hint')) {
          hint.innerHTML =
            'Humaans calendar-feeds URLs are fetched via Apps Script. '
            + 'If left blank or the feed fails, public holidays fall back to GOV.UK (England &amp; Wales).';
        }
      }
    };
  }

  // ── 5. Fix retry button unhandled-promise warnings ────────────────
  function inject_retryFix() {
    var obs = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        m.addedNodes.forEach(function (node) {
          if (!node || node.nodeType !== 1 || node.id !== 'ux-feed-banner') return;
          node.querySelectorAll('button').forEach(function (btn) {
            if (btn.textContent.includes('Retry')) {
              btn.onclick = function () {
                window.loadIcsData().catch(function (e) {
                  _log('Retry error: ' + (e && e.message));
                });
              };
            }
          });
        });
      });
    });
    obs.observe(document.body, { childList: true });
  }

  // ── Helpers ───────────────────────────────────────────────────────
  function _updateStatusBar() {
    var bar = document.getElementById('icsStatusBar');
    if (!bar) return;
    var n    = window.calIcsEvents ? window.calIcsEvents.length : 0;
    var pill = '<span class="ics-status"><span class="ics-dot ok"></span>' + n + ' holidays (GOV.UK)</span>';
    var sep  = '<span style="color:var(--text--dark--20);margin:0 4px;">|</span>';
    if (bar.innerHTML.includes('Holiday feed error') || bar.innerHTML.includes('holidays loaded')) {
      bar.innerHTML = bar.innerHTML.replace(
        /<span class="ics-status">[^<]*(?:Holiday feed error|holidays loaded)[^<]*<\/span>/, pill
      );
    } else {
      bar.innerHTML = pill + (bar.innerHTML.trim() ? sep + bar.innerHTML : '');
    }
  }

  function _dismissFeedBanner() {
    var banner = document.getElementById('ux-feed-banner');
    if (!banner) return;
    banner.style.transition = 'opacity 0.4s';
    banner.style.opacity    = '0';
    setTimeout(function () { if (banner.parentNode) banner.parentNode.removeChild(banner); }, 420);
  }

  function _log(msg) { console.log('[HolidayFix] ' + msg); }

}());
