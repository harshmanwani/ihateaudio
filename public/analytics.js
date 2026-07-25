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
    capture_pageview: 'history_change',
    capture_pageleave: true,
    respect_dnt: true,
    // localStorage only, no cookie of our own. Google Analytics sets its own and
    // there is no way around that, but no reason to add a second.
    persistence: 'localStorage',
  });
})();
