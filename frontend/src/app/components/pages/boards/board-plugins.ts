import { HttpContext } from '@angular/common/http';
import { DestroyRef, InjectionToken, Service, inject, signal } from '@angular/core';
import { Board, PluginsService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import type { BoardEngine } from '../../../../board-engine/engine';
import {
  BoardRoleName,
  PluginBlockOption,
  PluginHost,
  PluginServices,
} from '../../../../board-engine/plugins/plugin-host';
import type { FrameConnector } from '../../../../board-engine/plugins/plugin-instance';
import { ErrorCode, PluginError } from '../../../../board-engine/plugins/protocol';
import { Auth } from '../../../services/auth';
import { ERRORS_HANDLED_LOCALLY } from '../../../services/error-interceptor';
import { RUNTIME_CONFIG } from '../../../services/runtime-config';
import { Toasts } from '../../../services/toasts';
import { ApiError } from '../../../util/api-error';

/** The enabled plugins are read again this often (a disabled plugin's frames go then, S3.10). */
export const PLUGIN_REFRESH_MS = 60_000;

/** Replaces how the port reaches a frame (tests: jsdom runs no frame documents). */
export const PLUGIN_FRAME_CONNECTOR = new InjectionToken<FrameConnector>('PLUGIN_FRAME_CONNECTOR');

/** A plugin asks to open a link: the page shows the target host and the user decides. */
export interface LinkPrompt {
  readonly pluginId: string;
  readonly host: string;
  readonly url: string;
  answer(open: boolean): void;
}

/**
 * The plugins of ONE open board (provided by BoardPage): reads the enabled plugins, runs them
 * through the engine's PluginHost in sandboxed frames and gives the host what only the app has -
 * the plugin storage API with the user's token (the frame never calls /api), toasts and the
 * link confirmation. The list is read again every minute and when the tab becomes visible, so
 * a plugin an admin disabled loses its frames on every open board (S3.10).
 */
@Service({ autoProvided: false })
export class BoardPlugins {
  private readonly api = inject(PluginsService);
  private readonly auth = inject(Auth);
  private readonly toasts = inject(Toasts);
  private readonly pluginOrigin = inject(RUNTIME_CONFIG).pluginOrigin;
  private readonly connect = inject(PLUGIN_FRAME_CONNECTOR, { optional: true }) ?? undefined;
  private readonly context = new HttpContext().set(ERRORS_HANDLED_LOCALLY, true);

  /** Block types of the enabled plugins for the toolbar. */
  readonly blockOptions = signal<PluginBlockOption[]>([]);
  /** The open link question, if a plugin asked. */
  readonly linkPrompt = signal<LinkPrompt | undefined>(undefined);

  private host: PluginHost | undefined;
  private board: Board | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly onVisible = (): void => {
    if (document.visibilityState === 'visible') {
      void this.refresh();
    }
  };

  constructor() {
    document.addEventListener('visibilitychange', this.onVisible);
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /** Runs the plugins on `engine` (a new engine after a version restore replaces the old host). */
  attach(engine: BoardEngine | undefined, board: Board | undefined): void {
    this.board = board;
    this.host?.destroy();
    this.host = undefined;
    this.blockOptions.set([]);
    if (!engine || !board) {
      return;
    }
    const host = new PluginHost(
      engine,
      {
        boardId: board.id,
        boardTitle: () => this.board?.title ?? '',
        role: () => (this.board?.role ?? 'VIEWER') as BoardRoleName,
        userName: () => this.auth.guest()?.name ?? this.auth.user()?.displayName ?? '',
        guest: () => this.auth.guest() !== null,
        locale: navigator.language,
        colorScheme: () =>
          document.documentElement.dataset['theme'] === 'dark' ||
          (document.documentElement.dataset['theme'] !== 'light' &&
            window.matchMedia?.('(prefers-color-scheme: dark)').matches)
            ? 'dark'
            : 'light',
      },
      this.services(board.id),
      { pluginOrigin: this.pluginOrigin, connect: this.connect },
    );
    host.blockOptionsChanged.on((options) => this.blockOptions.set(options));
    this.host = host;
    void this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.refresh(), PLUGIN_REFRESH_MS);
  }

  /** The metadata of the board changed (role, title). */
  update(board: Board | undefined): void {
    this.board = board ?? this.board;
  }

  /** Reads the enabled plugins now; a failure keeps the running ones. */
  async refresh(): Promise<void> {
    const host = this.host;
    if (!host) {
      return;
    }
    try {
      const list = await firstValueFrom(
        this.api.listEnabledPlugins('body', false, { context: this.context }),
      );
      if (host === this.host) {
        host.setPlugins(list.items);
      }
    } catch {
      // keep what runs; the next refresh tries again
    }
  }

  private services(boardId: string): PluginServices {
    return {
      getStorage: async (pluginId) => {
        try {
          return await firstValueFrom(
            this.api.getPluginStorage({ boardId, pluginId }, 'body', false, {
              context: this.context,
            }),
          );
        } catch (error) {
          throw toPluginError(error);
        }
      },
      putStorage: async (pluginId, data, version) => {
        try {
          await firstValueFrom(
            this.api.putPluginStorage(
              { boardId, pluginId, pluginStorageUpdate: { data, version } },
              'body',
              false,
              { context: this.context },
            ),
          );
        } catch (error) {
          throw toPluginError(error);
        }
      },
      toast: (pluginId, level, message) => {
        // plain text through the toast outlet's interpolation, never HTML
        const text = `Plugin ${pluginId}: ${message}`;
        if (level === 'error' || level === 'warning') {
          this.toasts.error(text);
        } else {
          this.toasts.success(text);
        }
      },
      confirmLink: (pluginId, url) =>
        new Promise<boolean>((resolve) => {
          this.linkPrompt()?.answer(false); // one question at a time
          this.linkPrompt.set({
            pluginId,
            host: url.host,
            url: url.href,
            answer: (open) => {
              this.linkPrompt.set(undefined);
              resolve(open);
            },
          });
        }),
      openLink: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    };
  }

  private stop(): void {
    clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.linkPrompt()?.answer(false);
    this.host?.destroy();
    this.host = undefined;
  }
}

/** API failures of the storage as the protocol's error codes. */
export function toPluginError(error: unknown): PluginError {
  const status = error instanceof ApiError ? error.status : 0;
  const code: ErrorCode =
    status === 409
      ? 'CONFLICT'
      : status === 413
        ? 'TOO_LARGE'
        : status === 403
          ? 'NOT_ALLOWED'
          : status === 404
            ? 'NOT_FOUND'
            : status === 429
              ? 'TOO_MANY_REQUESTS'
              : 'UNAVAILABLE';
  return new PluginError(code, `the storage answered ${status || 'nothing'}`);
}
