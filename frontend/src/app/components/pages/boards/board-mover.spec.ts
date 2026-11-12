import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { Toasts } from '../../../services/toasts';
import { signedInAsAlice } from '../../../test/fake-auth';
import { aBoard, aProblem } from '../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../test/http-testing';
import { BoardMover } from './board-mover';

describe('BoardMover', () => {
  let mover: BoardMover;
  let toasts: Toasts;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpTesting(), signedInAsAlice().providers],
    });
    mover = TestBed.inject(BoardMover);
    toasts = TestBed.inject(Toasts);
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('move', () => {
    it('when the board is already there then no request is sent', async () => {
      const moved = await mover.move(aBoard({ folderId: 'f1' }), 'f1');

      expect(moved, 'result').toBe(false);
      expect(mover.moves(), 'moves').toBe(0);
    });

    it('when the move works then a toast names the folder and the move counter rises', async () => {
      const result = mover.move(aBoard(), 'f1', 'Work');
      await settle();
      expectRequest('PUT', `/api/boards/${aBoard().id}/folder`, 'move').flush(
        aBoard({ folderId: 'f1' }),
      );

      expect(await result, 'result').toBe(true);
      expect(mover.moves(), 'moves').toBe(1);
      expect(
        toasts.toasts().map((t) => t.message),
        'toasts',
      ).toEqual(['"Sprint planning" was moved to Work.']);
    });

    it('when the move fails then false is returned and the counter stays', async () => {
      const result = mover.move(aBoard(), 'f1');
      await settle();
      expectRequest('PUT', `/api/boards/${aBoard().id}/folder`).flush(
        aProblem({ code: 'CONFLICT', status: 409 }),
        problemResponse(409, 'Conflict'),
      );

      expect(await result, 'result').toBe(false);
      expect(mover.moves(), 'moves').toBe(0);
    });
  });

  describe('drop', () => {
    it('when nothing is dragged then nothing happens', async () => {
      await mover.drop('f1', 'Work');

      expect(mover.moves(), 'moves').toBe(0);
    });

    it('when a board is dragged then it moves and the drag state is cleared', async () => {
      mover.dragged.set(aBoard({ folderId: 'f1' }));

      const result = mover.drop(null);
      await settle();
      expectRequest('PUT', `/api/boards/${aBoard().id}/folder`, 'move').flush(aBoard());
      await result;

      expect(mover.dragged(), 'dragged').toBeUndefined();
    });
  });
});
