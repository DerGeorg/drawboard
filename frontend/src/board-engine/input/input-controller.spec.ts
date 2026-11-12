import { CLIPBOARD_MIME, WEB_CLIPBOARD_MIME } from '../io/clipboard';
import { InputController, InputTarget, isEditableTarget, keyInfo } from './input-controller';

function fakeTarget(): InputTarget & Record<string, ReturnType<typeof vi.fn>> {
  return {
    pointerDown: vi.fn(),
    pointerMove: vi.fn(),
    pointerUp: vi.fn(),
    pointerCancel: vi.fn(),
    doubleClick: vi.fn(),
    wheel: vi.fn(),
    pinch: vi.fn(),
    keyDown: vi.fn(() => true),
    keyUp: vi.fn(),
    pointerLeave: vi.fn(),
    copy: vi.fn(() => ({ json: '{"drawboard":"clipboard"}', text: 'plain' })),
    paste: vi.fn(() => true),
  };
}

/** A ClipboardEvent stand-in (jsdom has no DataTransfer): what the controller reads and writes. */
function clipboard(
  type: 'copy' | 'cut' | 'paste',
  data: Record<string, string> = {},
  files: File[] = [],
): { event: Event; written: Record<string, string> } {
  const written: Record<string, string> = {};
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    clipboardData: {
      types: Object.keys(data),
      files,
      getData: (k: string) => data[k] ?? '',
      setData: (k: string, v: string) => (written[k] = v),
    },
  });
  return { event, written };
}

function pointer(
  type: string,
  init: Partial<PointerEventInit> & { clientX?: number; clientY?: number } = {},
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'mouse',
    ...init,
  });
}

describe('InputController', () => {
  let container: HTMLElement;
  let target: ReturnType<typeof fakeTarget>;
  let input: InputController;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    target = fakeTarget();
    input = new InputController(container, target, (p) => ({ x: p.x * 2, y: p.y * 2 }));
  });

  afterEach(() => {
    input.destroy();
    container.remove();
  });

  describe('pointer events', () => {
    it('when a mouse button goes down then a normalized event with screen and world position is sent', () => {
      container.dispatchEvent(
        pointer('pointerdown', {
          clientX: 30,
          clientY: 40,
          buttons: 1,
          shiftKey: true,
          ctrlKey: true,
          pressure: 0.7,
        }),
      );

      expect(target.pointerDown, 'down').toHaveBeenCalledWith(
        expect.objectContaining({
          screen: { x: 30, y: 40 },
          world: { x: 60, y: 80 },
          shift: true,
          mod: true,
          pressure: expect.closeTo(0.7),
          touch: false,
          buttons: 1,
        }),
      );
    });

    it('when moving and releasing then move and up are forwarded', () => {
      container.dispatchEvent(pointer('pointermove', { clientX: 1, clientY: 2 }));
      container.dispatchEvent(pointer('pointerup', { clientX: 1, clientY: 2 }));
      container.dispatchEvent(pointer('pointercancel'));
      container.dispatchEvent(pointer('pointerleave'));

      expect(target.pointerMove, 'move').toHaveBeenCalledOnce();
      expect(target.pointerUp, 'up').toHaveBeenCalledOnce();
      expect(target.pointerCancel, 'cancel').toHaveBeenCalledOnce();
      expect(target.pointerLeave, 'leave').toHaveBeenCalledOnce();
    });

    it('when a pen is used with zero pressure then a default pressure is reported', () => {
      container.dispatchEvent(pointer('pointerdown', { pointerType: 'pen', pressure: 0 }));

      expect(target.pointerDown, 'down').toHaveBeenCalledWith(
        expect.objectContaining({ pressure: 0.5, touch: true }),
      );
    });

    it('when the pointer goes down on a link then the browser handles it', () => {
      const a = document.createElement('a');
      a.href = 'https://example.com';
      container.appendChild(a);

      a.dispatchEvent(pointer('pointerdown', { button: 0, bubbles: true }));

      expect(target.pointerDown, 'down').not.toHaveBeenCalled();
    });

    it('when the pointer goes down on a control inside a block then the control gets it', () => {
      const video = document.createElement('video');
      video.setAttribute('data-be-interactive', '');
      container.appendChild(video);

      video.dispatchEvent(pointer('pointerdown', { button: 0, bubbles: true }));

      expect(target.pointerDown, 'down').not.toHaveBeenCalled();
    });

    it('when the pointer goes down in a text field then the engine ignores it', () => {
      const ta = document.createElement('textarea');
      container.appendChild(ta);

      ta.dispatchEvent(pointer('pointerdown'));
      ta.dispatchEvent(pointer('pointermove'));
      ta.dispatchEvent(pointer('pointerup'));
      ta.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

      expect(target.pointerDown, 'down').not.toHaveBeenCalled();
      expect(target.pointerMove, 'move').not.toHaveBeenCalled();
      expect(target.pointerUp, 'up').not.toHaveBeenCalled();
      expect(target.doubleClick, 'double click').not.toHaveBeenCalled();
    });

    it('when double-clicking then a double click event is sent', () => {
      container.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, clientX: 5, clientY: 6 }),
      );

      expect(target.doubleClick, 'double click').toHaveBeenCalledWith(
        expect.objectContaining({ detail: 2, screen: { x: 5, y: 6 } }),
      );
    });

    it('when the context menu is requested then it is suppressed', () => {
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      container.dispatchEvent(e);

      expect(e.defaultPrevented, 'prevented').toBe(true);
    });
  });

  describe('touch gestures', () => {
    it('when a second finger goes down then the tool gesture is cancelled and pinch steps are sent', () => {
      container.dispatchEvent(
        pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 0 }),
      );
      container.dispatchEvent(
        pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 100, clientY: 0 }),
      );
      container.dispatchEvent(
        pointer('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 0 }),
      );

      expect(target.pointerCancel, 'cancel').toHaveBeenCalledOnce();
      expect(target.pinch, 'pinch').toHaveBeenCalledWith({ x: 100, y: 0 }, 2, 50, 0);
      expect(target.pointerMove, 'no tool move while pinching').not.toHaveBeenCalled();
    });

    it('when the fingers lift then no pointer up reaches the tool, and a new touch works again', () => {
      container.dispatchEvent(pointer('pointerdown', { pointerId: 1, pointerType: 'touch' }));
      container.dispatchEvent(pointer('pointerdown', { pointerId: 2, pointerType: 'touch' }));
      container.dispatchEvent(pointer('pointerup', { pointerId: 2, pointerType: 'touch' }));
      container.dispatchEvent(pointer('pointerup', { pointerId: 1, pointerType: 'touch' }));
      container.dispatchEvent(pointer('pointerdown', { pointerId: 3, pointerType: 'touch' }));

      expect(target.pointerUp, 'up during pinch').not.toHaveBeenCalled();
      expect(target.pointerDown, 'first finger and the later one').toHaveBeenCalledTimes(2);
    });

    it('when a touch is cancelled then the pinch state resets', () => {
      container.dispatchEvent(pointer('pointerdown', { pointerId: 1, pointerType: 'touch' }));
      container.dispatchEvent(pointer('pointercancel', { pointerId: 1, pointerType: 'touch' }));
      container.dispatchEvent(pointer('pointerdown', { pointerId: 2, pointerType: 'touch' }));

      expect(target.pointerCancel, 'cancel').toHaveBeenCalledOnce();
      expect(target.pointerDown, 'both down events reach the tool').toHaveBeenCalledTimes(2);
    });
  });

  describe('controls inside blocks', () => {
    it('when a key is pressed inside an interactive block element then the engine does not get it', () => {
      const card = document.createElement('div');
      card.setAttribute('data-be-interactive', '');
      card.tabIndex = 0;
      container.appendChild(card);

      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));

      expect(target.keyDown, 'not forwarded').not.toHaveBeenCalled();
    });

    it('when the wheel turns over a scrollable column then the column scrolls, not the board', () => {
      const list = document.createElement('div');
      list.setAttribute('data-be-scroll', '');
      Object.defineProperties(list, {
        scrollHeight: { value: 500 },
        clientHeight: { value: 100 },
      });
      container.appendChild(list);
      const down = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 30 });

      list.dispatchEvent(down);
      expect(target.wheel, 'not panned').not.toHaveBeenCalled();
      expect(down.defaultPrevented, 'native scroll').toBe(false);

      list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -30 }));
      expect(target.wheel, 'at the top: the board pans').toHaveBeenCalledTimes(1);

      list.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 30, ctrlKey: true }),
      );
      expect(target.wheel, 'zoom always goes to the board').toHaveBeenCalledTimes(2);
    });

    it('when the wheel turns sideways over a row that can scroll then the row scrolls', () => {
      const row = document.createElement('div');
      row.setAttribute('data-be-scroll', '');
      Object.defineProperties(row, { scrollWidth: { value: 900 }, clientWidth: { value: 300 } });
      container.appendChild(row);

      row.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 30 }));
      row.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: -30 }));

      expect(target.wheel, 'only the left turn at the start pans').toHaveBeenCalledTimes(1);
    });
  });

  describe('wheel', () => {
    it('when the wheel turns then deltas are in pixels and ctrl or meta means zoom', () => {
      const e = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 3,
        deltaMode: 1,
        ctrlKey: true,
        clientX: 7,
        clientY: 8,
      });
      container.dispatchEvent(e);

      expect(e.defaultPrevented, 'page scroll prevented').toBe(true);
      expect(target.wheel, 'wheel').toHaveBeenCalledWith({
        screen: { x: 7, y: 8 },
        deltaX: 0,
        deltaY: 48,
        zoom: true,
      });
    });

    it('when the wheel uses page mode then the delta is larger', () => {
      container.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1, deltaMode: 2 }));

      expect(target.wheel, 'wheel').toHaveBeenCalledWith(
        expect.objectContaining({ deltaY: 400, zoom: false }),
      );
    });
  });

  describe('keyboard', () => {
    it('when a key goes down then it is forwarded, and a handled key is prevented', () => {
      const e = new KeyboardEvent('keydown', {
        key: 'Delete',
        code: 'Delete',
        cancelable: true,
        bubbles: true,
      });
      window.dispatchEvent(e);
      window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));

      expect(target.keyDown, 'keydown').toHaveBeenCalledWith({
        key: 'Delete',
        shift: false,
        alt: false,
        mod: false,
        repeat: false,
        code: 'Delete',
      });
      expect(e.defaultPrevented, 'prevented').toBe(true);
      expect(target.keyUp, 'keyup').toHaveBeenCalledOnce();
    });

    it('when a key goes down in a text field then the engine ignores it', () => {
      const input2 = document.createElement('input');
      document.body.appendChild(input2);

      input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true }));

      expect(target.keyDown, 'keydown').not.toHaveBeenCalled();
      input2.remove();
    });

    it('when meta or ctrl is held then mod is true', () => {
      expect(keyInfo(new KeyboardEvent('keydown', { key: 'a', metaKey: true })).mod, 'meta').toBe(
        true,
      );
      expect(keyInfo(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true })).mod, 'ctrl').toBe(
        true,
      );
    });

    it('when the controller is destroyed then no events are forwarded', () => {
      input.destroy();

      container.dispatchEvent(pointer('pointerdown'));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));

      expect(target.pointerDown, 'down').not.toHaveBeenCalled();
      expect(target.keyDown, 'key').not.toHaveBeenCalled();
    });
  });

  describe('clipboard events', () => {
    it('when copy happens on the board then the content is written as our type and plain text', () => {
      const { event, written } = clipboard('copy');

      container.dispatchEvent(event);

      expect(target.copy, 'copy, not cut').toHaveBeenCalledWith(false);
      expect(written[CLIPBOARD_MIME], 'board content').toBe('{"drawboard":"clipboard"}');
      expect(written['text/plain'], 'text').toBe('plain');
      expect(event.defaultPrevented, 'the browser does not copy on top').toBe(true);
    });

    it('when cut happens with nothing to copy then the browser default stays', () => {
      vi.mocked(target.copy).mockReturnValue(undefined);
      const { event, written } = clipboard('cut');

      container.dispatchEvent(event);

      expect(target.copy, 'cut').toHaveBeenCalledWith(true);
      expect(written, 'nothing written').toEqual({});
      expect(event.defaultPrevented, 'default').toBe(false);
    });

    it('when the event comes from a text field, a control in a block or elsewhere then the board ignores it', () => {
      const field = document.createElement('textarea');
      const control = document.createElement('button');
      control.setAttribute('data-be-interactive', '');
      container.append(field, control);
      const outside = document.createElement('button');
      document.body.appendChild(outside);

      for (const el of [field, control, outside]) {
        el.dispatchEvent(clipboard('copy').event);
        el.dispatchEvent(clipboard('paste', { 'text/plain': 'x' }).event);
      }

      expect(target.copy, 'no copy').not.toHaveBeenCalled();
      expect(target.paste, 'no paste').not.toHaveBeenCalled();
      outside.remove();
    });

    it('when nothing has the focus then the board takes it, unless text is selected on the page', () => {
      const text = document.createElement('p');
      text.textContent = 'some page text';
      document.body.appendChild(text);
      document.getSelection()?.removeAllRanges();

      document.body.dispatchEvent(clipboard('copy').event);
      const range = document.createRange();
      range.selectNodeContents(text);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      document.body.dispatchEvent(clipboard('copy').event);

      expect(target.copy, 'once: before the text was selected').toHaveBeenCalledTimes(1);
      document.getSelection()?.removeAllRanges();
      text.remove();
    });

    it('when another listener already took the paste then the board leaves it alone', () => {
      const { event } = clipboard('paste', { 'text/plain': 'x' });
      event.preventDefault();

      container.dispatchEvent(event);

      expect(target.paste, 'not called').not.toHaveBeenCalled();
    });

    it('when board content or text is pasted then both are handed over, and only files are not', () => {
      container.dispatchEvent(
        clipboard('paste', { [CLIPBOARD_MIME]: '{}', 'text/plain': 't' }).event,
      );
      container.dispatchEvent(clipboard('paste', { [WEB_CLIPBOARD_MIME]: '{"w":1}' }).event);
      container.dispatchEvent(
        clipboard('paste', { 'text/html': '<b>x</b>' }, [new File(['x'], 'a.png')]).event,
      );

      expect(target.paste, 'twice').toHaveBeenCalledTimes(2);
      expect(target.paste, 'our type').toHaveBeenNthCalledWith(1, { json: '{}', text: 't' });
      expect(target.paste, 'web type').toHaveBeenNthCalledWith(2, { json: '{"w":1}', text: '' });
    });

    it('when the target does not take a paste then the browser default stays', () => {
      vi.mocked(target.paste).mockReturnValue(false);
      const { event } = clipboard('paste', { 'text/plain': '' });

      container.dispatchEvent(event);

      expect(event.defaultPrevented, 'default').toBe(false);
    });
  });

  describe('isEditableTarget', () => {
    it('when the target is a field or inside a contenteditable then it is editable', () => {
      const div = document.createElement('div');
      div.setAttribute('contenteditable', 'true');
      const span = document.createElement('span');
      div.appendChild(span);

      expect(isEditableTarget(span), 'inside contenteditable').toBe(true);
      const plain = document.createElement('div');
      plain.setAttribute('contenteditable', 'plaintext-only');
      expect(isEditableTarget(plain), 'plaintext-only').toBe(true);
      expect(isEditableTarget(document.createElement('select')), 'select').toBe(true);
      expect(isEditableTarget(document.createElement('div')), 'plain div').toBe(false);
      expect(isEditableTarget(null), 'null').toBe(false);
    });
  });
});
