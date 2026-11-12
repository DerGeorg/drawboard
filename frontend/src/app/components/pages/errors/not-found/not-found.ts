import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Any URL the router does not know. */
@Component({
  selector: 'drawboard-not-found',
  imports: [RouterLink],
  templateUrl: './not-found.html',
})
export class NotFound {}
