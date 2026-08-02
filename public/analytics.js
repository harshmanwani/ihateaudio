/**
 * Analytics bootstrap.
 *
 * A same-origin file rather than an inline block, on purpose. Inline snippets
 * would force `'unsafe-inline'` into script-src, and on a site whose entire
 * pitch is "your file never leaves your device" a weakened Content Security
 * Policy is a bad trade for saving one request. Configuration arrives on this
 * tag's own data attributes.
 *
 * Everything here is optional and failure is silent: measurement must never be
 * able to break a tool.
 */
(function () {
  var tag = document.currentScript;
  if (!tag) return;

  var ga = tag.dataset.ga || '';
  var phKey = tag.dataset.phKey || '';
  var phHost = tag.dataset.phHost || '';

  // ---- Google Analytics 4 ----
  if (ga) {
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ga);
    document.head.appendChild(s);

    window.dataLayer = window.dataLayer || [];
    function gtag() {
      window.dataLayer.push(arguments);
    }
    window.gtag = gtag;
    gtag('js', new Date());
    // Advertising signals off: there is no ad spend to optimise and no audience
    // to remarket to, so collecting for it would be taking data for nothing.
    gtag('config', ga, {
      anonymize_ip: true,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
  }

  // ---- PostHog ----
  if (!phKey || !phHost) return;

  /**
   * Exception scrubbing.
   *
   * Replay and autocapture are off on this site because a filename is content.
   * An exception message is the one remaining path a filename could take to the
   * wire, and it only takes one `new Error('could not read ' + file.name)` added
   * later to open it. Nothing in the tree does that today; this is what keeps
   * that true without anyone having to remember it.
   *
   * Stack frames are left alone deliberately — those paths are our own bundle,
   * and they are the entire reason for turning capture on.
   *
   * The two markers below are load-bearing: tests/unit/analytics-scrub.test.ts
   * slices this block out of the file and exercises the real thing, because a
   * privacy guarantee nobody tests is a privacy hope.
   */
  /* scrub:start */
  // No /g: this one is only ever tested, and a global regex carries lastIndex
  // between calls, which would make every second test miss.
  var FILEISH =
    /\.(?:mp3|wav|m4a|m4p|m4b|aac|ogg|oga|opus|flac|weba|webm|mp4|m4v|mov|avi|mkv|wma|aif|aiff|amr|ape|ac3|dts|3gp|caf|aax|aa)\b/i;
  var URLISH = /\b(?:blob|data|file):[^\s)"']+/gi;

  function scrubText(text) {
    if (typeof text !== 'string') return text;

    var cleaned = text.replace(URLISH, '<url>');

    // Real filenames contain spaces — "Voice Memo 3.m4a", "WhatsApp Audio
    // 2026-07-31 at 22.05.10.opus" — so there is no boundary a regex can find
    // to redact just the name. Trying leaves the front half of it behind, which
    // is the leak this exists to stop. So drop the whole message instead: the
    // exception type and the full stack survive untouched on their own fields,
    // and those are what a bug is actually read from. Only free text mentioning
    // a media extension is lost, which is the trade worth making here.
    if (FILEISH.test(cleaned)) return '<redacted: possible filename>';

    return cleaned;
  }

  function scrubException(event) {
    try {
      if (!event || event.event !== '$exception') return event;

      var props = event.properties || {};
      var list = props.$exception_list;
      if (list && list.length) {
        for (var i = 0; i < list.length; i++) {
          if (list[i]) list[i].value = scrubText(list[i].value);
        }
      }
      if (props.$exception_message) {
        props.$exception_message = scrubText(props.$exception_message);
      }
      return event;
    } catch (err) {
      // Fail closed. An event that could not be scrubbed is not worth sending.
      return null;
    }
  }
  /* scrub:end */

  // The official stub, so calls made before array.js lands are queued.
  !(function (t, e) {
    var o, n, p, r;
    e.__SV ||
      ((window.posthog = e),
      (e._i = []),
      (e.init = function (i, s, a) {
        function g(t, e) {
          var o = e.split('.');
          2 == o.length && ((t = t[o[0]]), (e = o[1]));
          t[e] = function () {
            t.push([e].concat(Array.prototype.slice.call(arguments, 0)));
          };
        }
        ((p = t.createElement('script')).type = 'text/javascript'),
          (p.crossOrigin = 'anonymous'),
          (p.async = !0),
          (p.src = s.api_host + '/static/array.js'),
          (r = t.getElementsByTagName('script')[0]).parentNode.insertBefore(p, r);
        var u = e;
        for (
          void 0 !== a ? (u = e[a] = []) : (a = 'posthog'),
            u.people = u.people || [],
            u.toString = function (t) {
              var e = 'posthog';
              return 'posthog' !== a && (e += '.' + a), t || (e += ' (stub)'), e;
            },
            u.people.toString = function () {
              return u.toString(1) + '.people (stub)';
            },
            o =
              'init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug'.split(
                ' '
              ),
            n = 0;
          n < o.length;
          n++
        )
          g(u, o[n]);
        e._i.push([i, s, a]);
      }),
      (e.__SV = 1));
  })(document, window.posthog || []);

  window.posthog.init(phKey, {
    api_host: phHost,
    defaults: '2025-05-24',
    // No person profile until someone is identified, which on a site with no
    // accounts is never. Anonymous events cost a fraction of identified ones,
    // and there is nothing here worth attaching to a person.
    person_profiles: 'identified_only',
    // Session replay would record filenames off the tool pages, and a filename
    // is content. Off, permanently.
    disable_session_recording: true,
    // Named events only. Blanket autocapture also records the contents of any
    // input we add later, which is exactly the mistake to avoid on this site.
    autocapture: false,
    // Unhandled errors, which the named events cannot see. Without these, a bug
    // in our own code arrives as a tool_error carrying nothing but a code, and
    // is indistinguishable from a genuinely broken file. Scrubbed on the way
    // out by before_send.
    capture_exceptions: true,
    before_send: scrubException,
    capture_pageview: 'history_change',
    capture_pageleave: true,
    respect_dnt: true,
    // localStorage only, no cookie of our own. Google Analytics sets its own and
    // there is no way around that, but no reason to add a second.
    persistence: 'localStorage',
  });
})();
