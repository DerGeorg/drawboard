import type { BuiltinTemplate } from './builtin-templates';

/**
 * The built-in templates, loaded on first use: they are a chunk of their own and stay out of
 * the library's first load (architecture 3.12).
 */
export function loadBuiltinTemplates(): Promise<readonly BuiltinTemplate[]> {
  return import('./builtin-templates').then((m) => m.BUILTIN_TEMPLATES);
}
