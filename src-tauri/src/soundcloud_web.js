(() => {
  if (window.__tempoScPending) return;
  window.__tempoScPending = true;
  const trackId = __TEMPO_TRACK_ID__;
  const authToken = __TEMPO_AUTH_TOKEN__;
  const apiHost = host => host === 'api-v2.soundcloud.com' || host === 'api.soundcloud.com';
  const mediaHost = host => host === 'sndcdn.com' || host.endsWith('.sndcdn.com')
    || host === 'soundcloud.com' || host.endsWith('.soundcloud.com');
  const request = async (url, stage, asText = false) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const headers = authToken && apiHost(new URL(url).hostname)
        ? { Authorization: `OAuth ${authToken}` } : {};
      const response = await fetch(url, { credentials: 'include', cache: 'no-store', headers, signal: controller.signal });
      if (!response.ok) throw new Error(`${stage} HTTP ${response.status}`);
      return await (asText ? response.text() : response.json());
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${stage} HTTP `)) throw error;
      throw new Error(`${stage} request failed`);
    } finally { clearTimeout(timeout); }
  };
  const resolve = async () => {
    const hydration = Array.isArray(window.__sc_hydration) ? window.__sc_hydration : [];
    let clientId = hydration.find(item => item.hydratable === 'apiClient')?.data?.id;
    const hydratedTrack = hydration.find(item => item.hydratable === 'sound'
      && String(item.data?.id) === trackId)?.data;
    if (!clientId) {
      // A public client ID also lives in the web client's own JavaScript. Read
      // only its trusted assets; fetched source is never evaluated by Tempo.
      const assets = [...document.scripts].map(script => script.src).filter(src => {
        try { const url = new URL(src); return url.protocol === 'https:' && url.hostname === 'a-v2.sndcdn.com'; }
        catch { return false; }
      }).reverse().slice(0, 8);
      for (const asset of assets) {
        try {
          const source = await request(asset, 'client configuration', true);
          clientId = source.match(/\bclient_id\s*:\s*["']([a-zA-Z0-9]{32})["']/)?.[1]
            || source.match(/["']client_id["']\s*:\s*["']([a-zA-Z0-9]{32})["']/)?.[1];
          if (clientId) break;
        } catch { /* another current web bundle may contain the configuration */ }
      }
    }
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9]{20,64}$/.test(clientId)) {
      throw new Error('public client configuration unavailable');
    }
    const metadataUrl = new URL(`https://api-v2.soundcloud.com/tracks/${trackId}`);
    metadataUrl.searchParams.set('client_id', clientId);
    const track = (!authToken && hydratedTrack) || await request(metadataUrl.href, 'track metadata');
    if (String(track.id) !== trackId) throw new Error('track metadata mismatch');
    if (track.policy === 'BLOCK') throw new Error('track unavailable in this browser session');
    if (track.policy === 'SNIP') throw new Error('only a preview is available');
    const variants = (track.media?.transcodings || []).map(variant => {
      const protocol = String(variant.format?.protocol || '').toLowerCase();
      const preset = String(variant.preset || '').toLowerCase();
      const mime = String(variant.format?.mime_type || '').toLowerCase();
      let endpoint;
      try { endpoint = new URL(variant.url); } catch { return null; }
      if (endpoint.protocol !== 'https:' || !apiHost(endpoint.hostname) || variant.snipped
        || /encrypted|^ctr-|^cbc-/.test(protocol) || /encrypted/.test(preset + mime + endpoint.pathname)) return null;
      const format = protocol === 'progressive' ? 'progressive'
        : protocol.includes('hls') || endpoint.pathname.includes('/hls') ? 'hls' : null;
      return format ? { endpoint, format } : null;
    }).filter(Boolean).sort((a, b) => Number(a.format === 'hls') - Number(b.format === 'hls'));
    if (!variants.length) throw new Error('no full unencrypted audio variant is available');
    let lastError = 'audio variants unavailable';
    for (const { endpoint, format } of variants) {
      endpoint.searchParams.set('client_id', clientId);
      if (track.track_authorization) endpoint.searchParams.set('track_authorization', track.track_authorization);
      try {
        const media = await request(endpoint.href, 'audio variant');
        const url = new URL(media.url);
        if (url.protocol !== 'https:' || !mediaHost(url.hostname)) throw new Error('invalid audio URL');
        return { url: url.href, format };
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'audio variant request failed';
      }
    }
    throw new Error(lastError);
  };
  resolve().then(result => { window.__tempoScResult = JSON.stringify(result); })
    .catch(error => { window.__tempoScResult = JSON.stringify({ error: error instanceof Error ? error.message : 'resolution failed' }); });
})();
