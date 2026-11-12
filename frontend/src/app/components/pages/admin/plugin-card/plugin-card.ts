import { Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import { FormField, FormRoot, form } from '@angular/forms/signals';
import { Plugin, PluginCapability, PluginsService } from '@apps/drawboard-api';
import { firstValueFrom } from 'rxjs';

import { ApiError } from '../../../../util/api-error';
import { WithSpan } from '../../../../util/tracing';
import { Modal } from '../../../shared/modal/modal';

interface PluginDraft {
  enabled: boolean;
  /** One per requested capability, in the order of `requestedCapabilities`. */
  grants: boolean[];
}

/** What each capability lets the plugin do - shown before the admin grants it (S3.8). */
export const CAPABILITY_TEXT: Readonly<Record<string, string>> = {
  'block.props':
    'Read and change the data of its own blocks. The plugin can send this data anywhere.',
  'block.resize': 'Resize its own blocks.',
  'board.read':
    'Read the structure and text of the board it is on (no email addresses). The plugin can send this data anywhere.',
  'export.register': 'Offer an export format for boards.',
  'import.register': 'Import files of this media type:',
  'ui.toast': 'Show short notifications.',
  'ui.openLink': 'Ask the user to open links (the user sees the target host first).',
  storage: 'Store up to 1 MB of data per board.',
  network: 'Connect from the user’s browser to these hosts (without the user’s credentials):',
};

const sameCapability = (a: PluginCapability, b: PluginCapability): boolean =>
  a.name === b.name && (a.value ?? '') === (b.value ?? '');

/**
 * One installed plugin for an instance admin: what it is (id, version, SHA-384 of the bundle to
 * compare with the publisher's), which capabilities it requests - network hosts and media types
 * spelled out - and the switches to grant them and to enable it. Saving sends the complete state
 * with the revision it is based on; removing asks first.
 */
@Component({
  selector: 'drawboard-plugin-card',
  imports: [FormField, FormRoot, Modal],
  templateUrl: './plugin-card.html',
})
export class PluginCard {
  private readonly api = inject(PluginsService);

  readonly plugin = input.required<Plugin>();
  /** The saved state, or undefined when it changed elsewhere (409) and must be read again. */
  readonly changed = output<Plugin | undefined>();
  readonly removed = output<string>();

  protected readonly text = CAPABILITY_TEXT;
  protected readonly confirmRemove = signal(false);
  protected readonly removing = signal(false);

  private readonly draft = linkedSignal<PluginDraft>(() => {
    const p = this.plugin();
    return {
      enabled: p.enabled,
      grants: p.requestedCapabilities.map((c) =>
        p.grantedCapabilities.some((g) => sameCapability(g, c)),
      ),
    };
  });

  protected readonly pluginForm = form(this.draft, () => undefined, {
    submission: { action: () => this.save() },
  });

  /** Network capabilities split into their hosts, so each one is visible on its own line. */
  protected readonly hosts = computed(() =>
    this.plugin().requestedCapabilities.map((c) =>
      c.name === 'network' ? (c.value ?? '').split(/\s+/).filter((h) => h !== '') : [],
    ),
  );

  protected readonly dirty = computed(() => {
    const p = this.plugin();
    const d = this.draft();
    return (
      d.enabled !== p.enabled ||
      d.grants.some(
        (g, i) =>
          g !==
          p.grantedCapabilities.some((c) =>
            sameCapability(c, p.requestedCapabilities[i] as PluginCapability),
          ),
      )
    );
  });

  @WithSpan('PluginCard.save')
  private async save(): Promise<undefined> {
    const p = this.plugin();
    const d = this.draft();
    try {
      const saved = await firstValueFrom(
        this.api.updatePlugin({
          pluginId: p.id,
          pluginUpdate: {
            enabled: d.enabled,
            grantedCapabilities: p.requestedCapabilities.filter((_, i) => d.grants[i]),
            revision: p.revision,
          },
        }),
      );
      this.changed.emit(saved);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        this.changed.emit(undefined); // changed by another admin or upgraded: read it again
      }
    }
    return undefined;
  }

  @WithSpan('PluginCard.askRemove')
  protected askRemove(): void {
    this.confirmRemove.set(true);
  }

  @WithSpan('PluginCard.cancelRemove')
  protected cancelRemove(): void {
    this.confirmRemove.set(false);
  }

  @WithSpan('PluginCard.remove')
  protected async remove(): Promise<void> {
    const id = this.plugin().id;
    this.removing.set(true);
    try {
      await firstValueFrom(this.api.removePlugin({ pluginId: id }));
      this.confirmRemove.set(false);
      this.removed.emit(id);
    } catch {
      // the error toast says why
    } finally {
      this.removing.set(false);
    }
  }
}
