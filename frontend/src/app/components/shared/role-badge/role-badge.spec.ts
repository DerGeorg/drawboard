import { TestBed } from '@angular/core/testing';
import { BoardRole } from '@apps/drawboard-api';
import { inputBinding, signal } from '@angular/core';

import { all, textOf } from '../../../test/dom';
import { RoleBadge } from './role-badge';

describe('RoleBadge', () => {
  describe('rendering', () => {
    it.each([
      [BoardRole.OWNER, 'Owner'],
      [BoardRole.EDITOR, 'Editor'],
      [BoardRole.COMMENTER, 'Commenter'],
      [BoardRole.VIEWER, 'Viewer'],
    ])('when the role is %s then the badge reads %s', async (role, label) => {
      const fixture = TestBed.createComponent(RoleBadge, {
        bindings: [inputBinding('role', () => role)],
      });
      await fixture.whenStable();

      expect(textOf(fixture), `badge text for ${role}`).toBe(label);
    });

    it('when the role changes then the badge follows', async () => {
      const role = signal<BoardRole>(BoardRole.VIEWER);
      const fixture = TestBed.createComponent(RoleBadge, {
        bindings: [inputBinding('role', role)],
      });
      await fixture.whenStable();

      role.set(BoardRole.OWNER);
      await fixture.whenStable();

      expect(all(fixture, '[data-testid=role]')[0]?.textContent, 'badge after the change').toBe(
        'Owner',
      );
    });
  });
});
