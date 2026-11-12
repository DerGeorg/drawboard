import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { Toasts } from '../../../../services/toasts';
import { buttonByText } from '../../../../test/dom';
import { signedInAsAlice } from '../../../../test/fake-auth';
import { SPRINT_BOARD_ID, aBoard, aProblem } from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { RecordedSpans, parentId, recordSpans } from '../../../../test/tracing';
import { BoardCreate, DEFAULT_TITLE } from './board-create';

describe('BoardCreate', () => {
  let fixture: ComponentFixture<BoardCreate>;
  let toasts: Toasts;
  let navigate: ReturnType<typeof vi.spyOn>;
  const variant = signal<'card' | 'button'>('card');
  const folderId = signal<string | undefined>(undefined);

  async function render(): Promise<void> {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), signedInAsAlice().providers],
    });
    toasts = TestBed.inject(Toasts);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(BoardCreate, {
      bindings: [inputBinding('variant', variant), inputBinding('folderId', folderId)],
    });
    await fixture.whenStable();
  }

  async function create(): Promise<void> {
    buttonByText(fixture, 'New board').click();
    await settle();
  }

  beforeEach(() => {
    variant.set('card');
    folderId.set(undefined);
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('in a folder', () => {
    it('when a folder id is given then the board is created in that folder', async () => {
      folderId.set('folder-1');
      await render();

      await create();
      const request = expectRequest('POST', '/api/boards', 'create board');
      expect(request.request.body, 'request body').toEqual({
        title: DEFAULT_TITLE,
        folderId: 'folder-1',
      });
      request.flush(aBoard(), { status: 201, statusText: 'Created' });
      await settle();
    });
  });

  describe('create', () => {
    it.each(['card', 'button'] as const)(
      'when the %s is clicked then a board with the default title is created and opened',
      async (kind) => {
        variant.set(kind);
        await render();

        await create();
        const request = expectRequest('POST', '/api/boards', 'create board');
        expect(request.request.body, 'request body').toEqual({ title: DEFAULT_TITLE });
        request.flush(aBoard(), { status: 201, statusText: 'Created' });
        await settle();

        expect(navigate, 'navigation to the editor').toHaveBeenCalledWith([
          '/boards',
          SPRINT_BOARD_ID,
        ]);
      },
    );

    it('when the request is running then the button is disabled so it cannot be clicked twice', async () => {
      await render();

      await create();

      expect(buttonByText(fixture, 'New board').disabled, 'disabled while busy').toBe(true);
      expectRequest('POST', '/api/boards').flush(aBoard(), { status: 201, statusText: 'Created' });
      await settle();
    });

    it('when the backend refuses then a toast with the request id is shown and the user stays', async () => {
      await render();

      await create();
      expectRequest('POST', '/api/boards').flush(
        aProblem({ code: 'INTERNAL_ERROR', status: 500, requestId: 'req-500' }),
        problemResponse(500, 'Server Error', 'req-500'),
      );
      await settle();

      expect(toasts.toasts(), 'toasts').toEqual([
        expect.objectContaining({ kind: 'error', requestId: 'req-500' }),
      ]);
      expect(navigate, 'no navigation').not.toHaveBeenCalled();
      expect(buttonByText(fixture, 'New board').disabled, 'usable again').toBe(false);
    });
  });

  describe('tracing', () => {
    let spans: RecordedSpans;

    beforeEach(() => {
      spans = recordSpans();
    });

    afterEach(() => spans.stop());

    it('when a board is created then BoardActions.create is a child of BoardCreate.create', async () => {
      await render();

      await create();
      expectRequest('POST', '/api/boards').flush(aBoard());
      await settle();

      expect(parentId(spans.byName('BoardActions.create')), 'parent of BoardActions.create').toBe(
        spans.byName('BoardCreate.create').spanContext().spanId,
      );
    });
  });
});
