import { PluginContext, PluginError } from '../../index';

/**
 * The sample plugin "Counter": a number on the board that editors count up and down. It shows
 * the three things most plugins need - its own props (the count, `block.props`), the
 * per-board storage (how often anyone clicked on this board, `storage`) and a notification
 * (`ui.toast`) - and degrades when a capability is not granted or the user may not edit.
 * Everything is built with createElement/textContent, like the board itself.
 */
export function mountCounter(root: HTMLElement, ctx: PluginContext): void {
  const d = root.ownerDocument;
  const box = d.createElement('div');
  box.style.cssText =
    'height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;' +
    `font:14px system-ui,sans-serif;color:${ctx.init.theme.colorScheme === 'dark' ? '#f8fafc' : '#0f172a'}`;
  const value = d.createElement('output');
  value.style.cssText = 'font-size:32px;font-weight:600;font-variant-numeric:tabular-nums';
  const buttons = d.createElement('div');
  buttons.style.cssText = 'display:flex;gap:6px';
  const total = d.createElement('small');
  total.style.color = '#64748b';
  const problem = d.createElement('small');
  problem.style.color = '#b91c1c';
  box.append(value, buttons, total, problem);
  root.replaceChildren(box);

  const count = (): number => {
    const n = ctx.props()['count'];
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  };
  const show = (): void => {
    value.textContent = String(count());
    buttons.style.display = ctx.canEdit() && ctx.can('block.props') ? 'flex' : 'none';
  };

  const showError = (error: unknown): void => {
    problem.textContent =
      error instanceof PluginError ? `${error.code}: ${error.message}` : 'Something went wrong.';
  };

  const clicked = async (): Promise<void> => {
    if (!ctx.can('storage') || !ctx.canEdit() || ctx.init.user.guest) {
      return;
    }
    const clicks = ((await ctx.storage.get<number>('clicks')) ?? 0) + 1;
    await ctx.storage.set('clicks', clicks);
    total.textContent = `Clicks on this board: ${clicks}`;
  };

  const change = (next: number, toast?: string): void => {
    problem.textContent = '';
    ctx
      .setProps({ count: next })
      .then(() => {
        show();
        return Promise.all([
          clicked(),
          toast && ctx.can('ui.toast') ? ctx.toast('info', toast) : undefined,
        ]);
      })
      .catch(showError);
  };

  const button = (label: string, title: string, action: () => void): void => {
    const b = d.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.style.cssText = 'min-width:32px;padding:2px 8px;font:inherit;cursor:pointer';
    b.addEventListener('click', action);
    buttons.append(b);
  };
  button('−', 'Count down', () => change(count() - 1));
  button('+', 'Count up', () => change(count() + 1));
  button('Reset', 'Back to 0', () => change(0, 'The counter was reset.'));

  ctx.on('block.changed', show);
  ctx.on('mode.changed', show);
  show();
  if (ctx.can('storage')) {
    ctx.storage
      .get<number>('clicks')
      .then((clicks) => (total.textContent = `Clicks on this board: ${clicks ?? 0}`))
      .catch(showError);
  }
}
