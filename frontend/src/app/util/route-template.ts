import { ActivatedRouteSnapshot } from '@angular/router';

/**
 * The route template of the active route ("/boards/:boardId"), never the concrete URL - used as
 * the Faro view name, so views stay countable and ids do not leak into labels.
 */
export function routeTemplate(root: ActivatedRouteSnapshot): string {
  const parts: string[] = [];
  for (let node: ActivatedRouteSnapshot | null = root; node; node = node.firstChild) {
    const path = node.routeConfig?.path;
    if (path) {
      parts.push(path);
    }
  }
  return `/${parts.join('/')}`;
}
