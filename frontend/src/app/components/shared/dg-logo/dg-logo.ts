import { Component, input } from '@angular/core';

/**
 * The DerGeorg mark: a grey D overlapped by an amber G (brand dergeorg, from the web-frontend
 * skill). `size` is the HEIGHT in pixels; the width follows (824 : 669).
 */
@Component({
  selector: 'drawboard-dg-logo',
  templateUrl: './dg-logo.html',
})
export class DgLogo {
  readonly size = input(28);
}
