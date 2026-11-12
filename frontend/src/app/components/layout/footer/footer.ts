import { Component, inject } from '@angular/core';

import { RUNTIME_CONFIG } from '../../../services/runtime-config';
import { LICENSE_URL } from '../../shared/about-dialog/about-dialog';

/** Version and environment (what support asks for first), the licence, the source and the product site. */
@Component({
  selector: 'drawboard-footer',
  templateUrl: './footer.html',
})
export class Footer {
  protected readonly config = inject(RUNTIME_CONFIG);
  protected readonly licenseUrl = LICENSE_URL;
  protected readonly year = new Date().getFullYear();
}
