import { Component, ElementRef, inject, output } from '@angular/core';

import { Theme } from '../../../services/theme';
import { WithSpan } from '../../../util/tracing';
import { ThemeMode } from '../../../util/theme-mode';
import { Icon } from '../icon/icon';
import { IconName } from '../icon/icons';

interface ThemeOption {
  mode: ThemeMode;
  label: string;
  icon: IconName;
}

/**
 * The three choices System, Light and Dark as the radio items of a menu (put it inside an
 * element with `role="menu"`). The current choice is checked; arrow keys move between the
 * choices. Choosing applies the theme at once (`Theme.set`).
 */
@Component({
  selector: 'drawboard-theme-switch',
  imports: [Icon],
  templateUrl: './theme-switch.html',
})
export class ThemeSwitch {
  private readonly theme = inject(Theme);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly options: readonly ThemeOption[] = [
    { mode: 'SYSTEM', label: 'System', icon: 'system' },
    { mode: 'LIGHT', label: 'Light', icon: 'sun' },
    { mode: 'DARK', label: 'Dark', icon: 'moon' },
  ];
  protected readonly mode = this.theme.mode;

  /** A choice was made (by click or key): a menu around it may close. */
  readonly chosen = output<ThemeMode>();

  @WithSpan('ThemeSwitch.choose')
  protected async choose(mode: ThemeMode): Promise<void> {
    this.chosen.emit(mode);
    await this.theme.set(mode);
  }

  /** Arrow keys select the neighbour and move the focus to it (wrapping around). */
  @WithSpan('ThemeSwitch.move')
  protected async move(event: KeyboardEvent, index: number): Promise<void> {
    const step =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const next = (index + step + this.options.length) % this.options.length;
    const buttons = this.element.nativeElement.querySelectorAll<HTMLButtonElement>('button');
    buttons[next]?.focus();
    await this.theme.set((this.options[next] as ThemeOption).mode);
  }
}
