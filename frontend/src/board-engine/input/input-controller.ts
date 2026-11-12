import { CLIPBOARD_MIME, ClipboardContent, WEB_CLIPBOARD_MIME } from '../io/clipboard';
import { Point } from '../model/types';
import { KeyInfo, PointerInfo, WheelInfo } from './events';

/** The engine side of the input: only normalized events cross this boundary. */
export interface InputTarget {
  pointerDown(e: PointerInfo): void;
  pointerMove(e: PointerInfo): void;
  pointerUp(e: PointerInfo): void;
  pointerCancel(): void;
  doubleClick(e: PointerInfo): void;
  wheel(e: WheelInfo): void;
  /** A two-finger gesture step: scale factor and pan since the last step, around `center`. */
  pinch(center: Point, scale: number, dx: number, dy: number): void;
  /** Returns true if handled (the controller then calls preventDefault). */
  keyDown(e: KeyInfo): boolean;
  keyUp(e: KeyInfo): void;
  pointerLeave(): void;
  /** Copy (or cut) the selection: the content for the clipboard, or undefined for nothing. */
  copy(cut: boolean): ClipboardContent | undefined;
  /** Paste what the clipboard holds; true if taken (the controller then prevents the default). */
  paste(data: { json?: string; text?: string }): boolean;
}

/** True for events that belong to a text field (the engine must not react to them). */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) {
    return false;
  }
  return (
    t.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
    ) !== null
  );
}

/** True for events inside a block's own controls (`data-be-interactive`: kanban cards, buttons). */
export function isInteractiveTarget(t: EventTarget | null): boolean {
  return t instanceof Element && t.closest('[data-be-interactive]') !== null;
}

/**
 * The element inside a block that scrolls by itself (`data-be-scroll`, e.g. a kanban column)
 * and can still move in the wheel's direction; the wheel then scrolls it instead of the board.
 */
function scrollableTarget(t: EventTarget | null, dx: number, dy: number): boolean {
  const el = t instanceof Element ? t.closest<HTMLElement>('[data-be-scroll]') : null;
  if (!el) {
    return false;
  }
  if (dy !== 0 && el.scrollHeight > el.clientHeight) {
    return dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight;
  }
  if (dx !== 0 && el.scrollWidth > el.clientWidth) {
    return dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth;
  }
  return false;
}

/** Translates DOM pointer, wheel and keyboard events into the engine's normalized events. */
export class InputController {
  private readonly touches = new Map<number, Point>();
  private pinching = false;
  private lastPinch: { center: Point; dist: number } | undefined;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly target: InputTarget,
    private readonly toWorld: (screen: Point) => Point,
  ) {
    const on = <E extends Event>(
      el: EventTarget,
      type: string,
      fn: (e: E) => void,
      options?: AddEventListenerOptions,
    ): void => {
      el.addEventListener(type, fn as EventListener, options);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, options));
    };
    const win = container.ownerDocument.defaultView ?? window;
    on<PointerEvent>(container, 'pointerdown', (e) => this.onDown(e));
    on<PointerEvent>(container, 'pointermove', (e) => this.onMove(e));
    on<PointerEvent>(container, 'pointerup', (e) => this.onUp(e));
    on<PointerEvent>(container, 'pointercancel', (e) => this.onCancel(e));
    on<PointerEvent>(container, 'pointerleave', () => this.target.pointerLeave());
    on<MouseEvent>(container, 'dblclick', (e) => {
      if (!isEditableTarget(e.target)) {
        this.target.doubleClick({ ...this.info(e), detail: 2 });
      }
    });
    on<WheelEvent>(container, 'wheel', (e) => this.onWheel(e), { passive: false });
    on<MouseEvent>(container, 'contextmenu', (e) => e.preventDefault());
    on<KeyboardEvent>(win, 'keydown', (e) => this.onKeyDown(e));
    on<KeyboardEvent>(win, 'keyup', (e) => this.target.keyUp(keyInfo(e)));
    // copy, cut and paste as ClipboardEvents: synchronous setData/getData, no permission prompt
    const doc = container.ownerDocument;
    on<ClipboardEvent>(doc, 'copy', (e) => this.onCopy(e, false));
    on<ClipboardEvent>(doc, 'cut', (e) => this.onCopy(e, true));
    on<ClipboardEvent>(doc, 'paste', (e) => this.onPaste(e));
  }

  destroy(): void {
    for (const c of this.cleanup) {
      c();
    }
    this.cleanup.length = 0;
  }

  private screenOf(e: MouseEvent): Point {
    const r = this.container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private info(e: MouseEvent | PointerEvent): PointerInfo {
    const screen = this.screenOf(e);
    const p = e as PointerEvent;
    return {
      screen,
      world: this.toWorld(screen),
      buttons: e.buttons,
      shift: e.shiftKey,
      alt: e.altKey,
      mod: e.ctrlKey || e.metaKey,
      pointerId: p.pointerId ?? 1,
      pressure: p.pressure && p.pressure > 0 ? p.pressure : 0.5,
      detail: e.detail || 1,
      touch: p.pointerType === 'touch' || p.pointerType === 'pen',
    };
  }

  private onDown(e: PointerEvent): void {
    if (isEditableTarget(e.target)) {
      return;
    }
    // links inside blocks are ordinary links: let the browser follow them
    if (
      e.target instanceof Element &&
      e.target.closest('a[href]') &&
      e.button === 0 &&
      !e.shiftKey
    ) {
      return;
    }
    // controls inside blocks (download buttons, video controls) take their own clicks
    if (e.target instanceof Element && e.target.closest('[data-be-interactive]')) {
      return;
    }
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, this.screenOf(e));
      if (this.touches.size === 2) {
        this.target.pointerCancel();
        this.pinching = true;
        this.lastPinch = this.pinchState();
        return;
      }
    }
    if (this.pinching) {
      return;
    }
    try {
      this.container.setPointerCapture?.(e.pointerId);
    } catch {
      // synthetic pointers (tests) cannot be captured
    }
    this.container.focus?.({ preventScroll: true });
    e.preventDefault();
    this.target.pointerDown(this.info(e));
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, this.screenOf(e));
      if (this.pinching) {
        this.pinchStep();
        return;
      }
    }
    if (this.pinching || isEditableTarget(e.target)) {
      return;
    }
    this.target.pointerMove(this.info(e));
  }

  private onUp(e: PointerEvent): void {
    const wasPinching = this.pinching;
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) {
        this.pinching = this.touches.size > 0 && this.pinching;
        this.lastPinch = undefined;
      }
      if (this.touches.size === 0) {
        this.pinching = false;
      }
    }
    if (wasPinching || isEditableTarget(e.target)) {
      return;
    }
    this.target.pointerUp(this.info(e));
  }

  private onCancel(e: PointerEvent): void {
    this.touches.delete(e.pointerId);
    if (this.touches.size === 0) {
      this.pinching = false;
    }
    this.target.pointerCancel();
  }

  private pinchState(): { center: Point; dist: number } | undefined {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) {
      return undefined;
    }
    return {
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      dist: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }

  private pinchStep(): void {
    const now = this.pinchState();
    const last = this.lastPinch;
    if (now && last && last.dist > 0) {
      this.target.pinch(
        now.center,
        now.dist / last.dist,
        now.center.x - last.center.x,
        now.center.y - last.center.y,
      );
    }
    this.lastPinch = now;
  }

  private onWheel(e: WheelEvent): void {
    const zoom = e.ctrlKey || e.metaKey;
    if (!zoom && scrollableTarget(e.target, e.deltaX, e.deltaY)) {
      return; // the column scrolls natively
    }
    e.preventDefault();
    // line/page delta modes (mouse wheels) are scaled to pixels
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    this.target.wheel({
      screen: this.screenOf(e),
      deltaX: e.deltaX * unit,
      deltaY: e.deltaY * unit,
      zoom: e.ctrlKey || e.metaKey,
    });
  }

  /**
   * True if a clipboard event belongs to the board: the board has the focus, or nothing has it
   * and no text is selected on the page. Never in a text field (the text editor, a dialog) or a
   * control inside a block: there the browser's own copy and paste apply.
   */
  private ownsClipboardEvent(e: ClipboardEvent): boolean {
    const t = e.target;
    if (e.defaultPrevented || !e.clipboardData || isEditableTarget(t) || isInteractiveTarget(t)) {
      return false;
    }
    if (t instanceof Node && this.container.contains(t)) {
      return true;
    }
    const doc = this.container.ownerDocument;
    if (t === doc || t === doc.body || t === doc.documentElement) {
      const selection = doc.getSelection();
      return !selection || selection.isCollapsed;
    }
    return false;
  }

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    if (!this.ownsClipboardEvent(e)) {
      return;
    }
    const content = this.target.copy(cut);
    if (content && e.clipboardData) {
      e.clipboardData.setData(CLIPBOARD_MIME, content.json);
      e.clipboardData.setData('text/plain', content.text);
      e.preventDefault();
    }
  }

  private onPaste(e: ClipboardEvent): void {
    const data = e.clipboardData;
    if (!data || !this.ownsClipboardEvent(e)) {
      return;
    }
    const json = data.getData(CLIPBOARD_MIME) || data.getData(WEB_CLIPBOARD_MIME);
    // files belong to the upload path of the host page; HTML is never read, only plain text
    if (!json && (data.files?.length ?? 0) > 0) {
      return;
    }
    if (this.target.paste({ json, text: data.getData('text/plain') })) {
      e.preventDefault();
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    // a focused card or button inside a block handles its own keys (Delete deletes the card,
    // not the whole kanban)
    if (isEditableTarget(e.target) || isInteractiveTarget(e.target)) {
      return;
    }
    if (this.target.keyDown(keyInfo(e))) {
      e.preventDefault();
    }
  }
}

export function keyInfo(e: KeyboardEvent): KeyInfo {
  return {
    key: e.key,
    shift: e.shiftKey,
    alt: e.altKey,
    mod: e.ctrlKey || e.metaKey,
    repeat: e.repeat,
    code: e.code,
  };
}
