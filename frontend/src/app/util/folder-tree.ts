import { Folder } from '@apps/drawboard-api';

/** A folder with its subfolders, sorted by name. */
export interface FolderNode {
  readonly folder: Folder;
  readonly children: readonly FolderNode[];
}

/**
 * Builds the tree from the flat list of listFolders (`parentId` links). A folder whose parent is
 * not in the list (it should not happen: the trash takes a folder with everything below it)
 * is shown at the top rather than lost.
 */
export function buildFolderTree(folders: readonly Folder[]): FolderNode[] {
  const ids = new Set(folders.map((f) => f.id));
  const childrenOf = new Map<string | null, Folder[]>();
  for (const folder of folders) {
    const key = folder.parentId !== null && ids.has(folder.parentId) ? folder.parentId : null;
    childrenOf.set(key, [...(childrenOf.get(key) ?? []), folder]);
  }
  const build = (parent: string | null): FolderNode[] =>
    [...(childrenOf.get(parent) ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((folder) => ({ folder, children: build(folder.id) }));
  return build(null);
}

/** The id of a folder and of everything below it - a folder cannot move into these. */
export function subtreeIds(nodes: readonly FolderNode[], id: string): Set<string> {
  const found = new Set<string>();
  const collect = (node: FolderNode): void => {
    found.add(node.folder.id);
    node.children.forEach(collect);
  };
  const visit = (list: readonly FolderNode[]): void => {
    for (const node of list) {
      if (node.folder.id === id) {
        collect(node);
      } else {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return found;
}

/** Flat, depth-first list with the nesting depth - for the folder picker. */
export function flattenFolderTree(
  nodes: readonly FolderNode[],
  depth = 0,
): { folder: Folder; depth: number }[] {
  return nodes.flatMap((n) => [
    { folder: n.folder, depth },
    ...flattenFolderTree(n.children, depth + 1),
  ]);
}
