import {
  BlockData,
  Capability,
  CapabilityName,
  EVENTS,
  Envelope,
  PLUGIN_LIMITS as LIMITS,
  PAYLOADS,
  PLUGIN_API_VERSION,
  PluginError,
  REQUESTS,
  TokenBucket,
  isPlainJson,
  jsonBytes,
  parseEnvelope,
  withinBound,
} from '@apps/drawboard-engine';
import type { PluginRuntime, ValidPlugin } from './plugin-host';

/** Why an instance ended; decides the placeholder text. */
export type EndReason = 'destroyed' | 'disabled' | 'not-started' | 'terminated' | 'navigated';

/** Hands the transferable port to the frame (tests replace it: jsdom runs no frame scripts). */
export type FrameConnector = (iframe: HTMLIFrameElement, port: MessagePort) => void;

export const defaultConnector: FrameConnector = (iframe, port) => {
  // '*' because the sandboxed frame has an opaque origin; the message carries nothing but the
  // port (protocol "Loading", step 4). From now on only the port is used.
  iframe.contentWindow?.postMessage({ type: 'connect', v: 1 }, '*', [port]);
};

/**
 * One sandboxed frame of a plugin (S3.2) with its own MessageChannel (S3.7). Everything the
 * frame sends is checked here before anything happens: rate (token bucket), size, plain JSON,
 * envelope, known type, payload schema, pending requests, then the granted capability and the
 * user's role (S3.8). The frame never gets a token, a user id or a URL of the app; its window
 * messages are never listened to.
 */
export class PluginInstance {
  readonly iframe: HTMLIFrameElement;
  private port: MessagePort | undefined;
  private readonly bucket = new TokenBucket(LIMITS.messagesPerSecond, LIMITS.burst);
  private readonly drops: number[] = [];
  private pending = 0;
  private loads = 0;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;
  private lastSent: { props: string; width: number; height: number } | undefined;
  /** Messages dropped since the start (tests, diagnostics). */
  dropped = 0;
  ready = false;

  constructor(
    private readonly plugin: ValidPlugin,
    private readonly runtime: PluginRuntime,
    private readonly blockId: string,
    container: HTMLElement,
    private readonly onEnd: (reason: EndReason) => void,
  ) {
    const iframe = container.ownerDocument.createElement('iframe');
    // S3.2: exactly these attributes - no allow-same-origin, no popups, no top navigation,
    // no forms; no permissions; no referrer; lazily loaded
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('allow', '');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('title', `Plugin ${plugin.id}`);
    iframe.className = 'be-plugin-frame';
    iframe.style.cssText = 'border:0;width:100%;height:100%;display:block;visibility:hidden';
    iframe.addEventListener('load', () => this.loaded());
    iframe.src = `${plugin.assetBase}__drawboard/frame.html`;
    this.iframe = iframe;
    container.replaceChildren(iframe);
  }

  /** The block changed (others, undo, resize): tell the plugin what changed. */
  blockChanged(block: BlockData): void {
    if (!this.port || !this.lastSent) {
      return;
    }
    const props = JSON.stringify(block.props);
    const change: Record<string, unknown> = {};
    if (props !== this.lastSent.props) {
      change['props'] = block.props;
    }
    if (block.w !== this.lastSent.width) {
      change['width'] = block.w;
    }
    if (block.h !== this.lastSent.height) {
      change['height'] = block.h;
    }
    this.lastSent = { props, width: block.w, height: block.h };
    if (Object.keys(change).length > 0) {
      this.send('block.changed', change);
    }
  }

  modeChanged(): void {
    this.send('mode.changed', { mode: this.runtime.mode() });
  }

  /** The board's colour scheme changed: the plugin may restyle itself. */
  themeChanged(): void {
    this.send('theme.changed', { theme: { colorScheme: this.runtime.session.colorScheme() } });
  }

  /** Ends the instance: the frame is removed at once (S3.10), the port closed. */
  end(reason: EndReason): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    clearTimeout(this.readyTimer);
    this.send('destroy', {});
    this.port?.close();
    this.port = undefined;
    this.iframe.remove();
    this.onEnd(reason);
  }

  private loaded(): void {
    this.loads++;
    if (this.ended) {
      return;
    }
    if (this.loads > 1) {
      // the frame navigated itself: whatever runs there now gets no second port, and the host
      // stops the whole plugin on this board for the session (S3.8)
      this.end('navigated');
      return;
    }
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (event: MessageEvent) => this.receive(event);
    this.runtime.connect(this.iframe, channel.port2);
    const block = this.runtime.board.getBlock(this.blockId);
    this.lastSent = block && {
      props: JSON.stringify(block.props),
      width: block.w,
      height: block.h,
    };
    this.send('init', this.initPayload(block));
    this.readyTimer = setTimeout(() => {
      if (!this.ready) {
        this.end('not-started');
      }
    }, LIMITS.readyMs);
  }

  private initPayload(block: BlockData | undefined): Record<string, unknown> {
    const session = this.runtime.session;
    return {
      apiVersion: PLUGIN_API_VERSION,
      instance: 'block',
      plugin: { id: this.plugin.id, version: this.plugin.version },
      block: block && {
        id: block.id,
        type: block.type,
        width: block.w,
        height: block.h,
        props: block.props,
      },
      board: { id: session.boardId },
      mode: this.runtime.mode(),
      role: session.role(),
      // S3.8: the pseudonym for this plugin, never the user id
      user: { id: this.plugin.userPseudonym, name: session.userName(), guest: session.guest() },
      locale: session.locale,
      theme: { colorScheme: session.colorScheme() },
      capabilities: this.plugin.grantedCapabilities.map((c) =>
        c.value === undefined ? { name: c.name } : { name: c.name, value: c.value },
      ),
      limits: {
        messageBytes: LIMITS.messageBytes,
        messagesPerSecond: LIMITS.messagesPerSecond,
        propsBytes: LIMITS.propsBytes,
        storageBytes: LIMITS.storageBytes,
      },
    };
  }

  private receive(event: MessageEvent): void {
    if (this.ended) {
      return;
    }
    // order matters: the cheap checks first, then a size-bounded walk that stops at 256 KiB,
    // the full JSON walk and the exact size only for messages that got through
    if (!this.bucket.take() || event.ports.length > 0) {
      this.drop();
      return;
    }
    const data: unknown = event.data;
    if (
      !withinBound(data, LIMITS.messageBytes) ||
      !isPlainJson(data) ||
      jsonBytes(data) > LIMITS.messageBytes
    ) {
      this.drop();
      return;
    }
    const message = parseEnvelope(data);
    if (!message) {
      this.drop();
      return;
    }
    if (EVENTS.has(message.type)) {
      if (message.requestId !== undefined) {
        this.drop();
      } else if (message.type === 'ready') {
        this.ready = true;
        clearTimeout(this.readyTimer);
        this.iframe.style.visibility = 'visible';
      }
      return;
    }
    const capability = Object.hasOwn(REQUESTS, message.type) ? REQUESTS[message.type] : undefined;
    if (!capability || message.requestId === undefined) {
      this.drop(); // unknown type, or a request without id: no answer possible
      return;
    }
    void this.answer(message as Envelope & { requestId: string }, capability);
  }

  private async answer(
    message: Envelope & { requestId: string },
    capability: CapabilityName,
  ): Promise<void> {
    if (this.pending >= LIMITS.pendingRequests) {
      this.error(message, new PluginError('TOO_MANY_REQUESTS', 'too many pending requests'));
      return;
    }
    this.pending++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = this.run(message, capability);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PluginError('TIMEOUT', 'the host did not answer in time')),
          LIMITS.answerMs,
        );
      });
      const result = await Promise.race([work, timeout]);
      this.send(`${message.type}.result`, result, message.requestId);
    } catch (error) {
      this.error(
        message,
        error instanceof PluginError ? error : new PluginError('UNAVAILABLE', 'the host failed'),
      );
    } finally {
      clearTimeout(timer);
      this.pending--;
    }
  }

  private async run(
    message: Envelope,
    capability: CapabilityName,
  ): Promise<Record<string, unknown>> {
    const validate = PAYLOADS[message.type as keyof typeof PAYLOADS];
    const payload = validate(message.payload) as Record<string, unknown>;
    if (!this.granted(capability, message.type === 'import.register' ? payload : undefined)) {
      throw new PluginError('CAPABILITY_NOT_GRANTED', `${capability} is not granted`);
    }
    return this.runtime.execute(this.plugin, this.blockId, message.type, payload);
  }

  /** A capability counts only as the admin granted it - for import.register per media type. */
  private granted(name: CapabilityName, payload?: Record<string, unknown>): boolean {
    return this.plugin.grantedCapabilities.some(
      (c: Capability) =>
        c.name === name && (payload === undefined || c.value === payload['mediaType']),
    );
  }

  private error(message: Envelope & { requestId: string }, error: PluginError): void {
    if (error.code === 'INVALID_PAYLOAD') {
      this.count();
    }
    this.send('error', { code: error.code, message: error.message }, message.requestId);
  }

  private send(type: string, payload: Record<string, unknown>, requestId?: string): void {
    try {
      this.port?.postMessage(
        requestId === undefined ? { type, v: 1, payload } : { type, v: 1, requestId, payload },
      );
    } catch {
      // a closed port: the instance is ending anyway
    }
  }

  private drop(): void {
    this.dropped++;
    this.count();
  }

  /** More than 500 dropped or invalid messages within a minute end the instance. */
  private count(): void {
    const now = Date.now();
    this.drops.push(now);
    while (this.drops.length > 0 && now - (this.drops[0] as number) > 60_000) {
      this.drops.shift();
    }
    if (this.drops.length > LIMITS.droppedPerMinute) {
      this.end('terminated');
    }
  }
}
