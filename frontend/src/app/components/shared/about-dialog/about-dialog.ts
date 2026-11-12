import { Component, inject, output } from '@angular/core';

import { RUNTIME_CONFIG } from '../../../services/runtime-config';
import { Modal } from '../modal/modal';

/** The licence text; the AGPL-3.0 offer of the source itself is `RuntimeConfig.sourceUrl`. */
export const LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';

/**
 * "About Drawboard": name, version, what it is, the product site ("Host your own", hidden when the
 * operator switched the promotion off) and the source code (AGPL-3.0 section 13). The parent
 * renders it with `@if (open)` and listens to `closed`.
 */
@Component({
  selector: 'drawboard-about-dialog',
  imports: [Modal],
  templateUrl: './about-dialog.html',
})
export class AboutDialog {
  protected readonly config = inject(RUNTIME_CONFIG);
  protected readonly licenseUrl = LICENSE_URL;

  readonly closed = output();
}
