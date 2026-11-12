import { aFolder } from '../test/fixtures';
import { buildFolderTree, flattenFolderTree, subtreeIds } from './folder-tree';

describe('folder tree', () => {
  const work = aFolder({ id: 'w', name: 'Work' });
  const team = aFolder({ id: 't', name: 'Team', parentId: 'w' });
  const alpha = aFolder({ id: 'a', name: 'Alpha', parentId: 'w' });
  const home = aFolder({ id: 'h', name: 'Home' });

  describe('buildFolderTree', () => {
    it('when folders have parents then they nest and every level is sorted by name', () => {
      const tree = buildFolderTree([work, team, home, alpha]);

      expect(
        tree.map((n) => n.folder.name),
        'roots',
      ).toEqual(['Home', 'Work']);
      expect(
        tree[1].children.map((n) => n.folder.name),
        'children of Work',
      ).toEqual(['Alpha', 'Team']);
    });

    it('when the parent is not in the list then the folder is shown at the top', () => {
      const tree = buildFolderTree([aFolder({ id: 'x', name: 'Lost', parentId: 'gone' })]);

      expect(
        tree.map((n) => n.folder.name),
        'roots',
      ).toEqual(['Lost']);
    });
  });

  describe('subtreeIds', () => {
    it('when a folder has subfolders then its id and theirs are returned', () => {
      const ids = subtreeIds(buildFolderTree([work, team, home]), 'w');

      expect([...ids].sort(), 'folder and below').toEqual(['t', 'w']);
    });

    it('when the id is unknown then nothing is returned', () => {
      expect(subtreeIds(buildFolderTree([work]), 'nope').size, 'ids').toBe(0);
    });
  });

  describe('flattenFolderTree', () => {
    it('when nested then depth-first with the depth', () => {
      const flat = flattenFolderTree(buildFolderTree([work, team, home]));

      expect(
        flat.map((e) => `${e.depth}:${e.folder.name}`),
        'rows',
      ).toEqual(['0:Home', '0:Work', '1:Team']);
    });
  });
});
