import { HttpTestingController } from '@angular/common/http/testing';
import { inputBinding, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { BoardRole, GrantRole, ShareResourceKind } from '@apps/drawboard-api';

import { all, buttonByLabel, buttonByText, textOf } from '../../../../test/dom';
import { provideFakeAuth, signedInAsAlice } from '../../../../test/fake-auth';
import { SPRINT_BOARD_ID, aBoard, aProblem } from '../../../../test/fixtures';
import {
  expectRequest,
  problemResponse,
  provideHttpTesting,
  settle,
} from '../../../../test/http-testing';
import { CLIPBOARD_MIME } from '../../../../../board-engine/io/clipboard';
import { Toasts } from '../../../../services/toasts';
import { BoardCollab } from '../board-collab';
import { BoardPlugins } from '../board-plugins';
import { flushFolders } from '../testing/library';
import { FakeBoardCollab, fakeBoardCollab } from '../testing/fake-board-collab';
import { BoardPage } from './board-page';

describe('BoardPage', () => {
  let fixture: ComponentFixture<BoardPage>;
  let navigate: ReturnType<typeof vi.spyOn>;
  let collab: FakeBoardCollab;
  const boardId = signal(SPRINT_BOARD_ID);

  async function render(auth = signedInAsAlice()): Promise<void> {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpTesting(), auth.providers],
    });
    TestBed.overrideComponent(BoardPage, fakeBoardCollab);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(BoardPage, { bindings: [inputBinding('boardId', boardId)] });
    collab = fixture.debugElement.injector.get(BoardCollab) as unknown as FakeBoardCollab;
    await settle();
  }

  beforeEach(() => boardId.set(SPRINT_BOARD_ID));

  afterEach(() => {
    const http = TestBed.inject(HttpTestingController);
    // every page with a canvas reads the enabled plugins
    http.match('/api/plugins').forEach((r) => r.flush({ items: [] }));
    // and the open planning poker rounds
    http.match((r) => r.url.endsWith('/poker-rounds')).forEach((r) => r.flush({ items: [] }));
    http.verify();
  });

  describe('loading', () => {
    it('when the request is pending then a loading text is shown', async () => {
      await render();

      // NOT whenStable(): a loading resource is a pending task, whenStable() would wait for it.
      expect(textOf(fixture), 'text while loading').toContain('Loading board');
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(aBoard());
    });

    it('when the board is loaded then title, role, canvas and toolbar are shown', async () => {
      await render();

      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(
        aBoard({ role: BoardRole.EDITOR }),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'page text').toContain('Sprint planning');
      expect(textOf(fixture), 'role').toContain('Editor');
      expect(all(fixture, '[data-testid=canvas]').length, 'canvases').toBe(1);
      expect(all(fixture, '[role=toolbar]').length, 'toolbars').toBe(1);
      expect(all(fixture, 'button[aria-label="Undo"]').length, 'undo button for an owner').toBe(1);
      expect(all(fixture, '[data-testid=back]')[0]?.getAttribute('href'), 'back link').toBe(
        '/boards',
      );
      expect(all(fixture, 'drawboard-board-zoom').length, 'zoom control').toBe(1);
    });

    it('when Share is clicked then the share dialog of the board opens and Close closes it again', async () => {
      await render();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(aBoard());
      await settle();
      await fixture.whenStable();

      buttonByLabel(fixture, 'Share').click();
      await settle();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/members`, 'members').flush({
        owner: { kind: 'USER', userId: 'id-alice', displayName: 'Alice Admin', username: 'alice' },
        items: [],
      });
      await flushFolders();
      await fixture.whenStable();
      expect(textOf(fixture), 'dialog text').toContain('Share board “Sprint planning”');

      buttonByLabel(fixture, 'Close').click();
      await fixture.whenStable();
      expect(textOf(fixture), 'dialog closed').not.toContain('Share board');
    });

    it('when other people are on the board then their avatars are shown next to your own', async () => {
      await render();
      collab.peers.set([
        {
          clientId: 2,
          name: 'Bob Builder',
          color: '#2563eb',
          guest: false,
          role: 'EDITOR',
          cursor: null,
          selection: [],
          userId: 'user-1',
          viewport: null,
          following: null,
          summon: null,
        },
      ]);
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(aBoard());
      await settle();
      await fixture.whenStable();

      const names = all(fixture, 'drawboard-avatar [role=img]').map((a) =>
        a.getAttribute('aria-label'),
      );
      expect(names, 'avatars: you first, then the peer').toEqual([
        'Alice Admin (you)',
        'Bob Builder',
      ]);
    });

    it('when a participant is followed from their avatar then the follow bar shows it and Stop ends it', async () => {
      await render();
      collab.peers.set([
        {
          clientId: 2,
          name: 'Bob Builder',
          color: '#2563eb',
          guest: false,
          role: 'EDITOR',
          cursor: null,
          selection: [],
          userId: 'id-bob',
          viewport: { x: 500, y: 300, zoom: 0.5 },
          following: null,
          summon: null,
        },
      ]);
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(
        aBoard({ role: BoardRole.EDITOR }),
      );
      await settle();
      await fixture.whenStable();

      buttonByLabel(fixture, 'Options for Bob Builder').click();
      await fixture.whenStable();
      expect(textOf(fixture), 'editors may summon').toContain('Ask to follow me');
      buttonByText(fixture, 'Follow').click();
      await fixture.whenStable();

      expect(textOf(fixture), 'follow bar').toContain('Following Bob Builder');
      expect(collab.setLocalFields, 'published').toHaveBeenCalledWith({ following: 2 });
      buttonByText(fixture, 'Stop').click();
      await fixture.whenStable();
      expect(textOf(fixture), 'stopped').not.toContain('Following Bob Builder');
    });

    it('when the board is loaded then the live connection opens once and its state is shown', async () => {
      await render();

      expect(collab.connect, 'not before the board is known').not.toHaveBeenCalled();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(aBoard());
      await settle();
      await fixture.whenStable();

      expect(collab.connect.mock.calls, 'connected once to this board').toEqual([
        [SPRINT_BOARD_ID],
      ]);
      expect(collab.bind, 'presence bound to the engine').toHaveBeenCalled();
      expect(textOf(fixture), 'connection badge').toContain('Live');
    });

    it('when the user is only a viewer then the toolbar offers no drawing tools', async () => {
      await render();

      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(
        aBoard({ role: BoardRole.VIEWER }),
      );
      await settle();
      await fixture.whenStable();

      expect(all(fixture, 'button[aria-label="Sticky note"]').length, 'sticky button').toBe(0);
      expect(all(fixture, 'button[aria-label="Undo"]').length, 'undo button').toBe(0);
      expect(all(fixture, 'button[aria-label="Hand"]').length, 'hand button').toBe(1);
    });

    it('when the server ends the session for good then a banner says so and nothing can be drawn', async () => {
      await render();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(
        aBoard({ role: BoardRole.EDITOR }),
      );
      await settle();
      await fixture.whenStable();
      expect(all(fixture, '[data-testid=access-ended]').length, 'no banner while live').toBe(0);

      collab.state.set({
        status: 'denied',
        role: 'EDITOR',
        error: undefined,
        closeCode: 4403,
        reloadRequired: false,
      });
      await fixture.whenStable();

      const banner = all(fixture, '[data-testid=access-ended]')[0];
      expect(banner?.textContent, 'banner text').toContain(
        'You no longer have access to this board.',
      );
      expect(banner?.querySelector('a')?.getAttribute('href'), 'way back').toBe('/boards');
      expect(all(fixture, 'button[aria-label="Sticky note"]').length, 'sticky button').toBe(0);
    });

    it('when a guest link stops working then the guest is told to ask for a new link', async () => {
      const guest = provideFakeAuth();
      guest.auth.signInAsGuest({
        name: 'Gustav',
        role: GrantRole.EDITOR,
        kind: ShareResourceKind.BOARD,
        id: SPRINT_BOARD_ID,
      });
      await render(guest);
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(
        aBoard({ role: BoardRole.EDITOR }),
      );
      await settle();
      collab.state.set({
        status: 'denied',
        role: 'EDITOR',
        error: undefined,
        closeCode: 4403,
        reloadRequired: false,
      });
      await fixture.whenStable();

      const banner = all(fixture, '[data-testid=access-ended]')[0];
      expect(banner?.textContent, 'banner text').toContain('This link no longer works.');
      expect(banner?.querySelector('a'), 'no library link for a guest').toBeNull();
    });

    it('when the board does not exist then the not-found page is shown and the failure has a request id', async () => {
      await render();

      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`).flush(
        aProblem({ code: 'LIBRARY_BOARD_NOT_FOUND', status: 404, requestId: 'req-404' }),
        problemResponse(404, 'Not Found', 'req-404'),
      );
      await settle();
      await fixture.whenStable();

      expect(navigate, 'navigation to the not-found page').toHaveBeenCalledWith(['/not-found'], {
        skipLocationChange: true,
      });
      expect(textOf(fixture), 'alert text').toContain('req-404');
      expect(collab.connect, 'no connection to a board that is not there').not.toHaveBeenCalled();
    });

    it('when the backend fails then an alert with the request id is shown', async () => {
      await render();

      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`).flush(
        aProblem({ status: 500, requestId: 'req-500' }),
        problemResponse(500, 'Server Error', 'req-500'),
      );
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'alert text').toContain('req-500');
      expect(navigate, 'navigation').not.toHaveBeenCalled();
    });
  });

  describe('files', () => {
    const uploadButtons = (): number => all(fixture, 'button[aria-label="Upload files"]').length;

    it('when an editor opens the board then files can be uploaded and the upload shows its progress', async () => {
      await render();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(
        aBoard({ role: BoardRole.EDITOR }),
      );
      await settle();
      await fixture.whenStable();

      expect(uploadButtons(), 'upload button').toBe(1);
      const picker = all<HTMLInputElement>(
        fixture,
        '[data-testid=file-picker]',
      )[0] as HTMLInputElement;
      Object.defineProperty(picker, 'files', {
        value: [new File(['x'], 'photo.png', { type: 'image/png' })],
      });
      picker.dispatchEvent(new Event('change'));
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'upload panel').toContain('Uploading');
      expectRequest('POST', `/api/boards/${SPRINT_BOARD_ID}/files`, 'upload').flush(
        aProblem({ code: 'FILES_QUOTA_EXCEEDED', status: 413, requestId: 'req-413' }),
        problemResponse(413, 'Payload Too Large', 'req-413'),
      );
      await fixture.whenStable();
      expect(textOf(fixture), 'reason in the panel').toContain('quota');
    });

    it('when a guest opens the board as an editor then there is no upload', async () => {
      const guest = provideFakeAuth();
      guest.auth.signInAsGuest({
        name: 'Gustav',
        role: GrantRole.EDITOR,
        kind: ShareResourceKind.BOARD,
        id: SPRINT_BOARD_ID,
      });
      await render(guest);
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(
        aBoard({ role: BoardRole.EDITOR }),
      );
      await settle();
      await fixture.whenStable();

      expect(uploadButtons(), 'no upload for guests (S1.9)').toBe(0);
      expect(all(fixture, 'button[aria-label="Sticky note"]').length, 'but drawing').toBe(1);
    });

    it('when a viewer opens the board then there is no upload', async () => {
      await render();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(
        aBoard({ role: BoardRole.VIEWER }),
      );
      await settle();
      await fixture.whenStable();

      expect(uploadButtons(), 'no upload').toBe(0);
    });
  });

  describe('kanban', () => {
    it('when the kanban button is clicked then a kanban is added and a card click opens its panel', async () => {
      await render();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(
        aBoard({ role: BoardRole.EDITOR }),
      );
      await settle();
      await fixture.whenStable();

      buttonByLabel(fixture, 'Kanban').click();
      await fixture.whenStable();
      expect(all(fixture, '[data-block-type="core.kanban"]').length, 'kanban block').toBe(1);

      buttonByLabel(fixture, 'Add a card to To do').click();
      const field = (fixture.nativeElement as HTMLElement).querySelector(
        '.be-kanban input',
      ) as HTMLInputElement;
      field.value = 'Plan';
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const card = all(fixture, '[data-card-id]')[0] as HTMLElement;
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      // NOT whenStable() before the members answered: a loading resource is a pending task
      await settle();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/members`, 'members').flush({
        owner: { kind: 'USER', userId: 'id-alice', displayName: 'Alice Admin' },
        items: [],
      });
      await fixture.whenStable();

      expect(all(fixture, '[data-testid=kanban-card]').length, 'card panel').toBe(1);
      buttonByLabel(fixture, 'Close the card').click();
      await fixture.whenStable();
      expect(all(fixture, '[data-testid=kanban-card]').length, 'closed').toBe(0);
    });
  });

  describe('story cards', () => {
    it('when the story button is clicked then a story card is added and its panel opens', async () => {
      await render();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(
        aBoard({ role: BoardRole.EDITOR }),
      );
      await settle();
      await fixture.whenStable();

      buttonByLabel(fixture, 'Story card').click();
      await fixture.whenStable();

      expect(all(fixture, '[data-block-type="core.story"]').length, 'story block').toBe(1);
      expect(all(fixture, '[data-testid=story-editor]').length, 'panel').toBe(1);
      buttonByLabel(fixture, 'Diagram').click();
      await fixture.whenStable();
      expect(all(fixture, '[data-testid=story-editor]').length, 'one panel at a time').toBe(0);
      expect(all(fixture, '[data-testid=diagram-editor]').length, 'the diagram one').toBe(1);
    });
  });

  describe('planning poker', () => {
    it('when a story card has an open round then the indicator and the dialog are there', async () => {
      await render();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(
        aBoard({ role: BoardRole.EDITOR }),
      );
      await settle();
      await fixture.whenStable();
      buttonByLabel(fixture, 'Story card').click();
      await fixture.whenStable();
      const storyId = (all(fixture, '[data-block-type="core.story"]')[0] as HTMLElement).dataset[
        'blockId'
      ] as string;
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/poker-rounds`, 'list').flush({
        items: [
          {
            id: '0192aaaa-0000-7000-8000-000000000001',
            storyBlockId: storyId,
            title: 'New story',
            deck: { kind: 'TSHIRT', values: ['XS', 'S', 'M', 'L', 'XL', '?'] },
            state: 'OPEN',
            facilitatorName: 'Alice Admin',
            createdAt: '2026-11-10T08:00:00Z',
            version: 1,
            participants: [],
          },
        ],
      });
      await settle();
      await fixture.whenStable();

      expect(textOf(fixture), 'indicator').toContain('1 open estimation');
      buttonByText(fixture, 'Planning poker').click();
      await settle();
      expect(all(fixture, '[data-testid=poker-dialog]').length, 'dialog').toBe(1);
      TestBed.inject(HttpTestingController)
        .match((r) => r.url.includes('/poker-rounds/'))
        .forEach((r) => r.flush(null, { status: 404, statusText: 'Not Found' }));
    });

    it('when an editor starts a quick round from the pill then the quick dialog opens without a card', async () => {
      await render();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(
        aBoard({ role: BoardRole.EDITOR }),
      );
      await settle();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}/poker-rounds`, 'list').flush({
        items: [],
      });
      await settle();
      await fixture.whenStable();

      buttonByText(fixture, 'Estimations').click();
      await fixture.whenStable();
      buttonByText(fixture, 'Start a quick round').click();
      await settle();

      expect(all(fixture, '[data-testid=poker-dialog]').length, 'dialog').toBe(1);
      expect(all(fixture, '[data-testid=quick-marker]').length, 'quick mode').toBe(1);
      expect(all(fixture, '[data-testid=poker-start]').length, 'start form').toBe(1);
    });

    it('when the guest has a view link then planning poker is not offered at all', async () => {
      const fake = provideFakeAuth();
      fake.auth.signInAsGuest({
        name: 'Gina',
        role: GrantRole.VIEWER,
        kind: ShareResourceKind.BOARD,
        id: SPRINT_BOARD_ID,
      });
      await render(fake);
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(
        aBoard({ role: BoardRole.VIEWER }),
      );
      await settle();

      expect(
        TestBed.inject(HttpTestingController).match((r) => r.url.includes('/poker-rounds')),
        'no poker call',
      ).toEqual([]);
    });
  });

  describe('diagrams', () => {
    async function loaded(): Promise<void> {
      await render();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(
        aBoard({ role: BoardRole.EDITOR }),
      );
      await settle();
      await fixture.whenStable();
    }

    it('when the diagram button is clicked then a diagram is added and its source opens', async () => {
      await loaded();

      buttonByLabel(fixture, 'Diagram').click();
      await fixture.whenStable();

      expect(all(fixture, '[data-block-type="core.mermaid"]').length, 'diagram block').toBe(1);
      expect(all(fixture, '[data-testid=diagram-editor]').length, 'source panel').toBe(1);
      buttonByLabel(fixture, 'Close the diagram source').click();
      await fixture.whenStable();
      expect(all(fixture, '[data-testid=diagram-editor]').length, 'closed').toBe(0);
    });

    it('when a .mmd file is dropped then it becomes a diagram and is not uploaded', async () => {
      await loaded();
      const canvas = all(fixture, 'drawboard-board-canvas')[0] as HTMLElement;
      const drop = new Event('drop', { bubbles: true, cancelable: true });
      const file = new File(['graph TD; A-->B'], 'flow.mmd');
      Object.assign(drop, {
        dataTransfer: { files: [file], types: ['Files'] },
        clientX: 0,
        clientY: 0,
      });

      canvas.dispatchEvent(drop);
      await settle();
      await fixture.whenStable();

      expect(all(fixture, '[data-block-type="core.mermaid"]').length, 'diagram').toBe(1);
    });

    it('when board content the board cannot paste arrives then a toast says why', async () => {
      await loaded();
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      const json = '{"drawboard":"clipboard","version":9}';
      Object.assign(paste, {
        clipboardData: {
          types: [CLIPBOARD_MIME],
          files: [],
          getData: (type: string) => (type === CLIPBOARD_MIME ? json : ''),
        },
      });

      document.dispatchEvent(paste);

      expect(
        TestBed.inject(Toasts)
          .toasts()
          .map((t) => t.message),
        'toast',
      ).toEqual(['Nothing was pasted: the content comes from a newer version of Drawboard.']);
      expect(all(fixture, '[data-block-type="core.mermaid"]').length, 'not a diagram').toBe(0);
    });

    it('when a dropped .mmd file is larger than 50 KB then it is refused with a message', async () => {
      await loaded();
      const canvas = all(fixture, 'drawboard-board-canvas')[0] as HTMLElement;
      const drop = new Event('drop', { bubbles: true, cancelable: true });
      const file = new File(['x'.repeat(50_001)], 'big.mmd');
      Object.assign(drop, { dataTransfer: { files: [file], types: ['Files'] } });

      canvas.dispatchEvent(drop);
      await settle();

      expect(all(fixture, '[data-block-type="core.mermaid"]').length, 'no diagram').toBe(0);
    });
  });

  describe('plugins', () => {
    it('when a plugin block type is offered and picked then a block of it is added', async () => {
      await render();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(
        aBoard({ role: BoardRole.EDITOR }),
      );
      await settle();
      await fixture.whenStable();
      expectRequest('GET', '/api/plugins', 'enabled plugins').flush({
        items: [
          {
            id: 'org.example.counter',
            version: '1.0.0',
            assetBase: `/plugin-assets/org.example.counter/1.0.0/${'c'.repeat(64)}/`,
            entry: 'index.js',
            integrity: 'sha384-x',
            blockTypes: [
              {
                type: 'org.example.counter.counter',
                label: 'Counter',
                defaultWidth: 200,
                defaultHeight: 100,
              },
            ],
            grantedCapabilities: [],
            userPseudonym: 'p'.repeat(43),
          },
        ],
      });
      await settle();
      await fixture.whenStable();

      buttonByLabel(fixture, 'Plugin blocks').click();
      await fixture.whenStable();
      all<HTMLButtonElement>(fixture, '[data-testid=plugin-menu] button')[0]?.click();
      await fixture.whenStable();

      const block = all(fixture, '[data-block-type="org.example.counter.counter"]')[0];
      expect(block?.querySelector('iframe')?.getAttribute('sandbox'), 'sandboxed frame').toBe(
        'allow-scripts',
      );
      expect(block?.textContent, 'badge').toContain('Plugin: org.example.counter');
    });

    it('when a plugin wants to open a link then the page names the host and the user decides', async () => {
      await render();
      expectRequest('GET', `/api/boards/${SPRINT_BOARD_ID}`, 'load board').flush(aBoard());
      await settle();
      const plugins = fixture.debugElement.injector.get(BoardPlugins);
      const answers: boolean[] = [];
      const ask = (url: string) =>
        plugins.linkPrompt.set({
          pluginId: 'org.example.counter',
          host: new URL(url).host,
          url,
          answer: (open) => {
            answers.push(open);
            plugins.linkPrompt.set(undefined);
          },
        });

      ask('https://docs.example.org/help');
      await fixture.whenStable();
      expect(all(fixture, '[data-testid=link-host]')[0]?.textContent, 'host').toBe(
        'docs.example.org',
      );
      buttonByText(fixture, 'Open').click();
      ask('https://other.example.org/');
      await fixture.whenStable();
      buttonByText(fixture, 'Cancel').click();

      expect(answers, 'open, then cancel').toEqual([true, false]);
    });
  });
});
