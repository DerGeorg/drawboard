import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';

import { PeerPresence } from '../presence';
import { Emitter } from '../util/emitter';
import { parsePeerState } from './awareness-state';
import { backoffDelay } from './backoff';
import {
  CollabRole,
  DEFAULT_LIMITS,
  From,
  Limits,
  ProtocolError,
  SUBPROTOCOL,
  ServerMessage,
  decodeAwarenessEntry,
  decodeServerFrame,
  encodeAwareness,
  encodePing,
  encodeUpdate,
} from './frames';

export type ProviderStatus = 'connecting' | 'synced' | 'offline' | 'readonly' | 'full' | 'denied';

export interface ProviderState {
  status: ProviderStatus;
  role: CollabRole | undefined;
  /** Why the provider is offline or denied, for the UI ("connection failed", ...). */
  error: string | undefined;
  /** The last WebSocket close code, if the connection ended. */
  closeCode: number | undefined;
  /** An update was rejected as too large: the user has to reload the board. */
  reloadRequired: boolean;
}

export interface CollabTicket {
  ticket: string;
  url: string;
  protocol: string;
}

/** The slice of the browser WebSocket the provider uses (tests inject a fake). */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface ProviderOptions {
  /** `POST /api/boards/{id}/collab-ticket`; called before every (re)connect (tickets are single use). */
  getTicket: () => Promise<CollabTicket>;
  /** `PUT /api/boards/{id}/snapshot?upToSeq=...` (compaction). */
  uploadSnapshot: (upToSeq: number, bytes: Uint8Array) => Promise<void>;
  /** `wss://host` (`ws://` only for localhost). Default: derived from `location`. */
  socketOrigin?: string;
  /** Default: `new WebSocket(url, protocols)`. */
  createSocket?: (url: string, protocols: string[]) => SocketLike;
  /** [0, 1) for the backoff jitter. Default: Math.random. */
  random?: () => number;
  /** Called with failures the provider swallows (snapshot upload, ticket). */
  onError?: (error: unknown) => void;
}

const OPEN = 1;
const PING_INTERVAL_MS = 30_000;
const DEAD_AFTER_MS = 60_000;
const AWARENESS_INTERVAL_MS = 15_000;
const AWARENESS_MIN_GAP_MS = 100;
const STABLE_AFTER_MS = 10_000;
const RATE_LIMIT_DELAY_MS = 30_000;
const MAX_PENDING_BEFORE_MERGE = 50;

/**
 * Keeps one Y.Doc and its Awareness in sync with the backend over `drawboard.v1`
 * (api/docs/collab-protocol.md). No Angular: the host injects how to get a ticket and how to
 * upload a snapshot. Call `connect()` after creating it, `destroy()` when done.
 */
export class DrawboardProvider {
  readonly statusChanged = new Emitter<ProviderState>();
  readonly peersChanged = new Emitter<PeerPresence[]>();
  /**
   * An owner restored an earlier version (close code 4410, "document replaced"). The provider
   * has dropped its pending queue and stopped: the host must discard this Y.Doc, create a fresh
   * document with a new provider and join again - never merge the old state back.
   */
  readonly documentReplaced = new Emitter<void>();

  private _state: ProviderState = {
    status: 'offline',
    role: undefined,
    error: undefined,
    closeCode: undefined,
    reloadRequired: false,
  };
  private socket: SocketLike | undefined;
  private limits: Limits = DEFAULT_LIMITS;
  private pending: Uint8Array[] = [];
  private synced = false;
  private welcomed = false;
  private destroyed = false;
  private stopped = false;
  private connecting = false;
  private appliedSeq = 0;
  private compacting = false;
  private reportedBadEntry = false;

  private attempt = 0;
  private handshakeFailures = 0;
  private protocolErrors = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private awarenessTimer: ReturnType<typeof setInterval> | undefined;
  private awarenessThrottle: ReturnType<typeof setTimeout> | undefined;
  private lastAwarenessSent = 0;
  private lastReceived = 0;

  /** Remote participants by Yjs clientID, as told by the server. Names come only from here. */
  private readonly peers = new Map<number, From>();
  private readonly remoteAwarenessIds = new Set<number>();

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) {
      return;
    }
    this.pending.push(update);
    if (this.pending.length > MAX_PENDING_BEFORE_MERGE) {
      this.pending = [Y.mergeUpdates(this.pending)];
    }
    this.flushPending(false);
  };

  private readonly onAwarenessUpdate = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    const id = this.doc.clientID;
    if (origin !== this && [...change.added, ...change.updated, ...change.removed].includes(id)) {
      this.scheduleAwareness();
    }
  };

  private readonly onAwarenessChange = (): void => this.peersChanged.emit(this.currentPeers());

  constructor(
    readonly doc: Y.Doc,
    readonly awareness: Awareness,
    private readonly options: ProviderOptions,
  ) {
    if (awareness.clientID !== doc.clientID) {
      throw new Error('The awareness must belong to the same Y.Doc (same clientID).');
    }
    doc.on('update', this.onDocUpdate);
    awareness.on('update', this.onAwarenessUpdate);
    awareness.on('change', this.onAwarenessChange);
  }

  get state(): ProviderState {
    return this._state;
  }

  get status(): ProviderStatus {
    return this._state.status;
  }

  /** True once the server told us we may send updates. */
  get canEdit(): boolean {
    return this._state.role === 'OWNER' || this._state.role === 'EDITOR';
  }

  /** Updates not yet acknowledged by the server. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Remote participants as the engine draws them. */
  currentPeers(): PeerPresence[] {
    const out: PeerPresence[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      const from = this.peers.get(clientId);
      if (clientId === this.doc.clientID || !from) {
        continue;
      }
      // input from any participant: every field validated, unknown ones ignored
      const s = parsePeerState(state);
      out.push({
        clientId,
        userId: from.id,
        name: from.name,
        color: from.color,
        guest: from.guest,
        role: from.role ?? null,
        cursor: s.cursor,
        selection: s.selection,
        viewport: s.viewport,
        following: s.following,
        summon: s.summon,
      });
    }
    return out;
  }

  /** Our Yjs client id: the id others use to name us (summon targets, `following`). */
  get clientId(): number {
    return this.doc.clientID;
  }

  /**
   * Merges `fields` into our awareness state (cursor and selection, viewport, following,
   * summon are written by different parts of the app); `undefined` removes a field. Sending is
   * throttled to 10 per second however often this is called.
   */
  setLocalFields(fields: Record<string, unknown>): void {
    if (this.destroyed) {
      return;
    }
    const next: Record<string, unknown> = { ...(this.awareness.getLocalState() ?? {}) };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    this.awareness.setLocalState(next);
  }

  /** Starts (or restarts after `denied`/`full`) the connection. */
  connect(): void {
    if (this.destroyed) {
      return;
    }
    this.stopped = false;
    this.clearReconnect();
    void this.open();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.clearReconnect();
    this.clearTimers();
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    this.awareness.off('change', this.onAwarenessChange);
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.detachSocket(1000);
    this.statusChanged.clear();
    this.peersChanged.clear();
    this.documentReplaced.clear();
  }

  // ---- connecting ----------------------------------------------------------------------------

  private async open(): Promise<void> {
    if (this.connecting || this.destroyed) {
      return;
    }
    this.connecting = true;
    this.detachSocket(1000);
    this.setState({ status: 'connecting', error: undefined, closeCode: undefined });
    try {
      const ticket = await this.options.getTicket();
      if (this.destroyed || this.stopped) {
        return;
      }
      if (ticket.protocol !== SUBPROTOCOL) {
        throw new Error(`Unsupported collaboration protocol: ${ticket.protocol}`);
      }
      const socket = this.createSocket(ticket);
      this.socket = socket;
      this.welcomed = false;
      this.synced = false;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => this.onOpen(socket);
      socket.onmessage = (ev) => this.onMessage(socket, ev.data);
      socket.onclose = (ev) => this.onClose(socket, ev.code);
      socket.onerror = () => undefined; // a close event always follows
    } catch (e) {
      this.options.onError?.(e);
      if (!this.destroyed && !this.stopped) {
        this.connectionFailed();
      }
    } finally {
      this.connecting = false;
    }
  }

  private createSocket(ticket: CollabTicket): SocketLike {
    if (!ticket.url.startsWith('/')) {
      throw new Error('The ticket URL must be a path.');
    }
    const origin = this.options.socketOrigin ?? defaultSocketOrigin();
    if (!isSecureOrLocal(origin)) {
      throw new Error('Refusing an insecure WebSocket origin.');
    }
    const protocols = [SUBPROTOCOL, `ticket.${ticket.ticket}`];
    const url = origin + ticket.url;
    return this.options.createSocket
      ? this.options.createSocket(url, protocols)
      : (new WebSocket(url, protocols) as SocketLike);
  }

  private onOpen(socket: SocketLike): void {
    if (socket !== this.socket) {
      return;
    }
    this.lastReceived = Date.now();
    this.clearTimers();
    this.stableTimer = setTimeout(() => {
      this.attempt = 0;
    }, STABLE_AFTER_MS);
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
    this.awarenessTimer = setInterval(() => this.sendAwareness(), AWARENESS_INTERVAL_MS);
  }

  private ping(): void {
    if (Date.now() - this.lastReceived > DEAD_AFTER_MS) {
      this.detachSocket(4000);
      this.handleClosed(4000);
      return;
    }
    this.send(encodePing());
  }

  // ---- messages ------------------------------------------------------------------------------

  private onMessage(socket: SocketLike, data: unknown): void {
    if (socket !== this.socket) {
      return;
    }
    this.lastReceived = Date.now();
    try {
      if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
        throw new ProtocolError('text frames are not allowed');
      }
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.handle(decodeServerFrame(bytes));
    } catch (e) {
      this.options.onError?.(e);
      if (e instanceof ProtocolError) {
        this.detachSocket(4400);
        this.handleClosed(4400);
      } else {
        throw e;
      }
    }
  }

  /**
   * Applies an update from the server. The server stores updates without reading them, so a
   * broken one can sit in the log: it is skipped (its sequence number still counts as seen),
   * reported once, and the board stays joinable (S2.13). The next compaction drops it.
   */
  private applyRemote(bytes: Uint8Array, what: string): void {
    try {
      Y.applyUpdate(this.doc, bytes, this);
    } catch (e) {
      if (!this.reportedBadEntry) {
        this.reportedBadEntry = true;
        this.options.onError?.(
          new Error(`skipped a malformed ${what} from the server`, { cause: e }),
        );
      }
    }
  }

  private handle(m: ServerMessage): void {
    switch (m.type) {
      case 'welcome':
        this.welcomed = true;
        this.handshakeFailures = 0;
        this.limits = m.limits;
        this.setState({ role: m.role });
        this.forgetRemoteAwareness();
        return;
      case 'snapshot':
        this.appliedSeq = Math.max(this.appliedSeq, m.upToSeq);
        this.applyRemote(m.bytes, `snapshot up to ${m.upToSeq}`);
        return;
      case 'update':
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
        this.applyRemote(m.bytes, `update ${m.seq}`);
        return;
      case 'synced':
        this.appliedSeq = Math.max(this.appliedSeq, m.headSeq);
        this.synced = true;
        this.protocolErrors = 0;
        this.updateStatus();
        this.flushPending(true);
        this.sendAwareness();
        return;
      case 'ack':
        this.appliedSeq = Math.max(this.appliedSeq, m.seq);
        this.pending.shift();
        return;
      case 'awareness':
        this.onRemoteAwareness(m.from, m.bytes);
        return;
      case 'peerJoined':
        if (m.from.clientId !== undefined) {
          this.peers.set(m.from.clientId, m.from);
        }
        this.sendAwareness();
        return;
      case 'peerLeft':
        if (m.from.clientId !== undefined) {
          removeAwarenessStates(this.awareness, [m.from.clientId], this);
          this.peers.delete(m.from.clientId);
          this.remoteAwarenessIds.delete(m.from.clientId);
          this.peersChanged.emit(this.currentPeers());
        }
        return;
      case 'compact':
        void this.compact(m.upToSeq);
        return;
      case 'pong':
        return;
      case 'role':
        this.setState({ role: m.role });
        this.updateStatus();
        this.flushPending(true);
        return;
    }
  }

  private onRemoteAwareness(from: From, bytes: Uint8Array): void {
    if (bytes.byteLength > this.limits.awareness) {
      return; // the server enforces the limit (S2.5); a bigger frame is not parsed here either
    }
    const entry = decodeAwarenessEntry(bytes);
    if (
      from.clientId === undefined ||
      entry.clientId !== from.clientId ||
      entry.clientId === this.doc.clientID
    ) {
      return; // not from the session it claims, or an attempt to overwrite our own state
    }
    this.peers.set(from.clientId, from);
    this.remoteAwarenessIds.add(from.clientId);
    applyAwarenessUpdate(this.awareness, bytes, this);
    this.peersChanged.emit(this.currentPeers());
  }

  /** A new session starts with no remote states; the peers answer our PEER_JOINED. */
  private forgetRemoteAwareness(): void {
    if (this.remoteAwarenessIds.size > 0) {
      removeAwarenessStates(this.awareness, [...this.remoteAwarenessIds], this);
    }
    this.remoteAwarenessIds.clear();
    this.peers.clear();
    this.peersChanged.emit([]);
  }

  // ---- sending -------------------------------------------------------------------------------

  /**
   * Sends the pending updates. After SYNCED (`merge` = true) the whole queue is merged into one
   * update first, so edits made offline arrive exactly once more; duplicates are harmless.
   */
  private flushPending(merge: boolean): void {
    if (!this.synced || !this.canEdit || this.pending.length === 0) {
      return;
    }
    if (merge) {
      this.pending = [Y.mergeUpdates(this.pending)];
    }
    const toSend = merge ? this.pending : this.pending.slice(-1);
    for (const update of toSend) {
      if (update.byteLength > this.limits.update) {
        this.pending = [];
        this.setState({ error: 'The board change is too large to be sent.', reloadRequired: true });
        return;
      }
      this.send(encodeUpdate(update));
    }
  }

  private scheduleAwareness(): void {
    if (this.awarenessThrottle !== undefined) {
      return;
    }
    const wait = Math.max(0, this.lastAwarenessSent + AWARENESS_MIN_GAP_MS - Date.now());
    this.awarenessThrottle = setTimeout(() => {
      this.awarenessThrottle = undefined;
      this.sendAwareness();
    }, wait);
  }

  private sendAwareness(): void {
    if (!this.synced) {
      return;
    }
    const bytes = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
    if (bytes.byteLength <= this.limits.awareness && this.send(encodeAwareness(bytes))) {
      this.lastAwarenessSent = Date.now();
    }
  }

  private send(frame: Uint8Array): boolean {
    if (this.socket?.readyState === OPEN) {
      this.socket.send(frame);
      return true;
    }
    return false;
  }

  /** COMPACT: answered only with an empty queue and everything up to `upToSeq` applied. */
  private async compact(upToSeq: number): Promise<void> {
    if (
      this.compacting ||
      !this.synced ||
      !this.canEdit ||
      this.pending.length > 0 ||
      this.appliedSeq < upToSeq
    ) {
      return;
    }
    this.compacting = true;
    try {
      await this.options.uploadSnapshot(upToSeq, Y.encodeStateAsUpdate(this.doc));
    } catch (e) {
      this.options.onError?.(e);
    } finally {
      this.compacting = false;
    }
  }

  // ---- closing and reconnecting --------------------------------------------------------------

  private onClose(socket: SocketLike, code: number): void {
    if (socket !== this.socket) {
      return;
    }
    this.handleClosed(code);
  }

  private handleClosed(code: number): void {
    const wasWelcomed = this.welcomed;
    this.socket = undefined;
    this.clearTimers();
    this.synced = false;
    this.welcomed = false;
    this.compacting = false;
    this.forgetRemoteAwareness();
    if (this.destroyed) {
      return;
    }
    this.setState({ closeCode: code });
    switch (code) {
      case 1000:
        this.stop('offline');
        return;
      case 4403:
      case 4404:
        this.stop('denied');
        return;
      case 4410:
        // Yjs merges are additive: reconnecting with this document would bring the replaced
        // content straight back. Drop the queue (those edits are lost on purpose) and hand over.
        this.pending = [];
        this.stop('connecting');
        this.documentReplaced.emit();
        return;
      case 4413:
        this.stop('full');
        return;
      case 1009:
        this.pending = [];
        this.setState({
          error: 'An update was too large. Reload the board.',
          reloadRequired: true,
        });
        this.stop('offline');
        return;
      case 4401:
        // the token behind the ticket expired: a new ticket, at once (but not in a hot loop)
        if (wasWelcomed) {
          void this.open();
        } else {
          this.scheduleReconnect();
        }
        return;
      case 4400:
        if (++this.protocolErrors >= 2) {
          this.setState({ error: 'Protocol error' });
          this.stop('offline');
          return;
        }
        this.scheduleReconnect();
        return;
      case 4429:
        this.scheduleReconnect(RATE_LIMIT_DELAY_MS);
        return;
      default:
        if (!wasWelcomed && code === 1006) {
          // A failed handshake looks like 1006: ask for a new ticket once, then report it.
          if (++this.handshakeFailures === 1) {
            void this.open();
            return;
          }
          this.setState({ error: 'Connection failed' });
        }
        this.scheduleReconnect();
    }
  }

  private connectionFailed(): void {
    this.setState({ error: 'Connection failed' });
    this.scheduleReconnect();
  }

  private stop(status: ProviderStatus): void {
    this.stopped = true;
    this.setState({ status });
  }

  private scheduleReconnect(delay?: number): void {
    this.setState({ status: 'offline' });
    this.clearReconnect();
    const wait = delay ?? backoffDelay(this.attempt++, this.options.random);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.open();
    }, wait);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private clearTimers(): void {
    clearTimeout(this.stableTimer);
    clearInterval(this.pingTimer);
    clearInterval(this.awarenessTimer);
    clearTimeout(this.awarenessThrottle);
    this.awarenessThrottle = undefined;
  }

  private detachSocket(code: number): void {
    const s = this.socket;
    this.socket = undefined;
    if (s) {
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try {
        s.close(code);
      } catch {
        // already closed
      }
    }
  }

  private updateStatus(): void {
    if (this.synced) {
      this.setState({ status: this.canEdit ? 'synced' : 'readonly', error: undefined });
    }
  }

  private setState(patch: Partial<ProviderState>): void {
    this._state = { ...this._state, ...patch };
    this.statusChanged.emit(this._state);
  }
}

function defaultSocketOrigin(): string {
  const l = globalThis.location;
  return `${l.protocol === 'https:' ? 'wss:' : 'ws:'}//${l.host}`;
}

/** `wss://` always; `ws://` only for localhost. */
export function isSecureOrLocal(origin: string): boolean {
  if (origin.startsWith('wss://')) {
    return true;
  }
  const m = /^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.exec(origin);
  return m !== null;
}
