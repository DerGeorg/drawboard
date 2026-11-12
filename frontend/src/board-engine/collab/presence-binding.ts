import { BoardEngine } from '../engine';
import { ViewportState, encodeViewport, sameViewport } from './awareness-state';
import { DrawboardProvider } from './provider';

/**
 * Connects an engine and a provider: the engine's cursor, selection and viewport (centre and
 * zoom, rounded) go into the awareness - names and colors come from the server - and the
 * provider's peers and its role (read-only for viewers) go into the engine. The provider
 * throttles sending to 10 per second, so a pan publishes at most that often. Returns the
 * function that undoes it.
 */
export function bindPresence(engine: BoardEngine, provider: DrawboardProvider): () => void {
  // the server's role may lock the engine, never unlock one the host locked
  let lockedByProvider = false;
  let viewport: ViewportState | null = null;
  const publishViewport = (): void => {
    const next = encodeViewport(engine.visibleCenter(), engine.camera.zoom);
    if (!sameViewport(next, viewport)) {
      viewport = next;
      provider.setLocalFields({ viewport: next });
    }
  };
  const off = [
    engine.localPresence.on((p) =>
      provider.setLocalFields({ cursor: p.cursor, selection: p.selection.slice(0, 100) }),
    ),
    engine.cameraChanged.on(publishViewport),
    engine.viewportResized.on(publishViewport),
    provider.peersChanged.on((peers) => engine.setPeers(peers)),
    provider.statusChanged.on((s) => {
      if (s.status === 'readonly' && !engine.readOnly) {
        lockedByProvider = true;
        engine.setReadOnly(true);
      } else if (s.status === 'synced' && lockedByProvider) {
        lockedByProvider = false;
        engine.setReadOnly(false);
      }
    }),
  ];
  engine.setPeers(provider.currentPeers());
  publishViewport();
  return () => off.forEach((o) => o());
}
