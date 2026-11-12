/** What a share dialog is about: a board or a folder. */
export type ShareKind = 'board' | 'folder';

/** The roles that can be granted, strongest first (never OWNER). */
export const GRANT_ROLES = [
  { value: 'EDITOR', label: 'Editor' },
  { value: 'COMMENTER', label: 'Commenter' },
  { value: 'VIEWER', label: 'Viewer' },
] as const;
