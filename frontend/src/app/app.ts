import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';

import { Footer } from './components/layout/footer/footer';
import { Header } from './components/layout/header/header';
import { ToastOutlet } from './components/shared/toast-outlet/toast-outlet';

/** The library, the editor and the share-link pages (/s) and /open fill the window and bring their own chrome (shell, floating panels). */
const FULL_WINDOW_URL = /^\/(?:boards|s|open)(?:[/?#]|$)/;

/** Root: the layout around the routed page, plus the global toasts. */
@Component({
  selector: 'drawboard-root',
  imports: [RouterOutlet, Footer, Header, ToastOutlet],
  templateUrl: './app.html',
  // the page shell: header, main (grows), footer at the bottom of a short page
  host: { class: 'flex min-h-dvh flex-col bg-(--color-st-white) text-(--color-st-black)' },
})
export class App {
  protected readonly fullWindow = toSignal(
    inject(Router).events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => FULL_WINDOW_URL.test(e.urlAfterRedirects)),
    ),
    { initialValue: false },
  );
}
