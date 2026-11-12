import { Service, inject } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';

/** Browser tab title "<route title> · Drawboard" - routes only carry their own part. */
@Service({ autoProvided: false })
export class PageTitle extends TitleStrategy {
  static readonly appName = 'Drawboard';
  private readonly title = inject(Title);

  override updateTitle(snapshot: RouterStateSnapshot): void {
    const page = this.buildTitle(snapshot);
    this.title.setTitle(page ? `${page} · ${PageTitle.appName}` : PageTitle.appName);
  }
}
