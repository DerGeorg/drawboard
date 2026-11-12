import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Shown when the user may not read something (403 on a read). */
@Component({
  selector: 'drawboard-forbidden',
  imports: [RouterLink],
  templateUrl: './forbidden.html',
})
export class Forbidden {}
