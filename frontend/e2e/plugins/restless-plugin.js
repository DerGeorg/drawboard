// A plugin that misbehaves in two ways the host must survive (M3 frontend review, Playwright
// additions): it sends a 10 MB message over its port, and then navigates its own frame - after
// which it must get no second port and the plugin must stop on this board.
const report = (name, value) => {
  const img = new Image();
  img.src = new URL(
    `report.png?${name}=${encodeURIComponent(JSON.stringify(value))}`,
    import.meta.url,
  ).href;
};

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
      port.postMessage({ type: 'ready', v: 1, payload: {} });
      port.postMessage({
        type: 'ui.toast',
        v: 1,
        requestId: 'big',
        payload: { message: 'x'.repeat(10 * 1024 * 1024) },
      });
      report('flooded', { ok: true });
      setTimeout(() => {
        window.location.href = new URL('elsewhere.html', import.meta.url).href;
      }, 500);
    } else if (m.requestId) {
      report(`reply-${m.requestId}`, { type: m.type, code: m.payload.code });
    }
  };
});
