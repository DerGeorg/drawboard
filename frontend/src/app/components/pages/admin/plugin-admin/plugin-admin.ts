import { HttpContext } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { FieldViolation, Plugin, PluginsService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import { ERRORS_HANDLED_LOCALLY } from '../../../../services/error-interceptor';
import { ErrorMessages } from '../../../../services/error-messages';
import { Toasts } from '../../../../services/toasts';
import { ApiError } from '../../../../util/api-error';
import { formatBytes } from '../../../../util/format-bytes';
import { WithSpan } from '../../../../util/tracing';
import { Icon } from '../../../shared/icon/icon';
import { LoadError } from '../../../shared/load-error/load-error';
import { PluginCard } from '../plugin-card/plugin-card';

/** Largest plugin ZIP the server accepts (S3.9). */
export const MAX_PLUGIN_ZIP_BYTES = 20 * 1_000_000;

interface InstallFailure {
  readonly message: string;
  readonly violations: readonly FieldViolation[];
  readonly requestId?: string;
}

/**
 * /admin/plugins - instance admins install plugins by ZIP upload (S3.9, the only way in M3),
 * review what each one requests, grant capabilities and enable or disable it, and compare the
 * SHA-384 of the bundle with the publisher's. A new plugin is installed disabled with nothing
 * granted; an upload with a higher version of an installed id is an upgrade.
 */
@Component({
  selector: 'drawboard-plugin-admin',
  imports: [RouterLink, Icon, LoadError, PluginCard],
  templateUrl: './plugin-admin.html',
  host: { class: 'block' },
})
export class PluginAdmin {
  private readonly api = inject(PluginsService);
  private readonly messages = inject(ErrorMessages);
  private readonly toasts = inject(Toasts);

  protected readonly plugins = rxResource({ stream: () => this.api.listPlugins() });
  protected readonly installing = signal(false);
  protected readonly failure = signal<InstallFailure | undefined>(undefined);
  protected readonly limit = formatBytes(MAX_PLUGIN_ZIP_BYTES);

  @WithSpan('PluginAdmin.install')
  protected async install(picker: HTMLInputElement): Promise<void> {
    const file = picker.files?.[0];
    picker.value = '';
    this.failure.set(undefined);
    if (!file) {
      return;
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      this.failure.set({ message: 'A plugin is uploaded as a .zip file.', violations: [] });
      return;
    }
    if (file.size > MAX_PLUGIN_ZIP_BYTES) {
      this.failure.set({ message: `The ZIP is larger than ${this.limit}.`, violations: [] });
      return;
    }
    this.installing.set(true);
    try {
      const context = new HttpContext().set(ERRORS_HANDLED_LOCALLY, true);
      const plugin = await firstValueFrom(
        this.api.installPlugin({ file }, 'body', false, { context }),
      );
      this.toasts.success(
        plugin.enabled
          ? `${plugin.name} was upgraded to ${plugin.version}.`
          : `${plugin.name} ${plugin.version} is installed. Review its capabilities and enable it.`,
      );
      this.plugins.reload();
    } catch (error) {
      const api = error instanceof ApiError ? error : undefined;
      this.failure.set({
        message: api ? this.messages.text(api.problem) : 'The plugin could not be installed.',
        violations: api?.violations ?? [],
        requestId: api?.requestId,
      });
    } finally {
      this.installing.set(false);
    }
  }

  @WithSpan('PluginAdmin.changed')
  protected changed(plugin: Plugin | undefined): void {
    if (!plugin) {
      this.toasts.error('This plugin was changed meanwhile. It has been read again.');
      this.plugins.reload();
      return;
    }
    this.plugins.update(
      (list) => list && { items: list.items.map((p) => (p.id === plugin.id ? plugin : p)) },
    );
    this.toasts.success(`${plugin.name} was saved.`);
  }

  @WithSpan('PluginAdmin.removed')
  protected removed(id: string): void {
    this.plugins.update((list) => list && { items: list.items.filter((p) => p.id !== id) });
  }
}
