'use strict';
/**
 * Runs in MAIN world — same origin as the YouTube page.
 * This gives us:
 *  1. Direct access to ytInitialPlayerResponse / ytInitialData / yt.config_
 *  2. fetch() that is genuinely same-origin (www.youtube.com), so YouTube's
 *     SameSite cookies are included automatically — unlike content-script or
 *     service-worker fetches which use the extension origin.
 */

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const { type, requestId } = event.data || {};
  if (!type?.startsWith('YTS_')) return;

  // ── Return page globals ──────────────────────────────────────────────────
  if (type === 'YTS_REQUEST_PLAYER_RESPONSE') {
    const cfg = window.yt?.config_ || {};
    window.postMessage({
      type: 'YTS_PLAYER_RESPONSE',
      requestId,
      payload: {
        playerResponse: window.ytInitialPlayerResponse || null,
        initialData:    window.ytInitialData           || null,
        ytConfig: {
          apiKey:        cfg.INNERTUBE_API_KEY        || null,
          clientVersion: cfg.INNERTUBE_CLIENT_VERSION || null,
          context:       cfg.INNERTUBE_CONTEXT        || null,
        },
      }
    }, '*');
    return;
  }

  // ── Fetch transcript via timedtext URL (same-origin) ────────────────────
  if (type === 'YTS_FETCH_TRANSCRIPT') {
    const { url } = event.data;
    // Safety: only allow YouTube timedtext API
    if (!url?.startsWith('https://www.youtube.com/api/timedtext')) {
      window.postMessage({ type: 'YTS_TRANSCRIPT_RESULT', requestId, error: 'Invalid URL' }, '*');
      return;
    }
    fetch(url, { credentials: 'include' })
      .then(r => r.text())
      .then(text => window.postMessage({ type: 'YTS_TRANSCRIPT_RESULT', requestId, text }, '*'))
      .catch(err => window.postMessage({ type: 'YTS_TRANSCRIPT_RESULT', requestId, error: err.message }, '*'));
    return;
  }

  // ── Fetch a fresh player response for a specific video (same-origin) ────
  // window.ytInitialPlayerResponse is a one-time bootstrap global that
  // YouTube's own SPA router never reassigns after a client-side video
  // change — it stays pinned to whichever video the page originally
  // loaded. This fetches an up-to-date player response (captions, etc.)
  // for whatever videoId the caller actually needs, the same way
  // YouTube's own player fetches it internally.
  if (type === 'YTS_FETCH_PLAYER_DATA') {
    const { apiKey, context, videoId } = event.data;
    const clientVersion = context?.client?.clientVersion || '2.20240101.00.00';
    const clientName = context?.client?.clientName === 'ANDROID' ? '3' : '1';
    fetch(`/youtubei/v1/player?key=${apiKey}&prettyPrint=false`, {
      method:  'POST',
      headers: {
        'Content-Type':             'application/json',
        'X-YouTube-Client-Name':    clientName,
        'X-YouTube-Client-Version': clientVersion,
      },
      body: JSON.stringify({ context, videoId }),
    })
      .then(r => r.text())
      .then(text => window.postMessage({ type: 'YTS_PLAYER_DATA_RESULT', requestId, text }, '*'))
      .catch(err => window.postMessage({ type: 'YTS_PLAYER_DATA_RESULT', requestId, error: err.message }, '*'));
    return;
  }

  // ── Fetch transcript via Innertube get_transcript (same-origin) ──────────
  if (type === 'YTS_FETCH_INNERTUBE') {
    const { apiKey, context, params } = event.data;
    const clientVersion = context?.client?.clientVersion || '2.20240101.00.00';
    const clientName = context?.client?.clientName === 'ANDROID' ? '3' : '1';
    fetch(`/youtubei/v1/get_transcript?key=${apiKey}&prettyPrint=false`, {
      method:  'POST',
      headers: {
        'Content-Type':             'application/json',
        'X-YouTube-Client-Name':    clientName,
        'X-YouTube-Client-Version': clientVersion,
      },
      body:    JSON.stringify({ context, params }),
    })
      .then(r => r.text())
      .then(text => window.postMessage({ type: 'YTS_INNERTUBE_RESULT', requestId, text }, '*'))
      .catch(err => window.postMessage({ type: 'YTS_INNERTUBE_RESULT', requestId, error: err.message }, '*'));
    return;
  }
});
