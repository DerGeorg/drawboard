import { ancestry, captureFaro } from '../support/faro';
import { expect, test, uniqueTitle } from '../support/fixtures';
import { users } from '../support/users';

// Deep tracing: the Angular spans (@WithSpan, router navigations) are the parents of Faro's
// fetch span, whose trace id the backend returns as X-Request-Id. Faro's uploads are captured
// in the browser, so this needs no receiver (in the pipeline there is none).
test.describe('tracing', () => {
  test.use({ storageState: users.alice.storageState });

  test('when alice creates a board then submit and command spans are the parents of the POST in the trace of its request id', async ({
    page,
    asAlice,
  }) => {
    const sent = await captureFaro(page);
    await page.goto('/boards');

    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/api/boards') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'New board' }).first().click(),
    ]);
    const requestId = response.headers()['x-request-id'] ?? '';
    asAlice.track(((await response.json()) as { id: string }).id);

    await expect
      .poll(
        () =>
          ancestry(
            sent(),
            sent().find((s) => s.name === 'POST' && s.traceId === requestId),
          ),
        { message: 'span chain of the POST, innermost first', timeout: 10_000 },
      )
      .toEqual(['POST', 'BoardActions.create', 'BoardCreate.create']);
  });

  test('when alice opens a board then the navigation span is the parent of the GET in the trace of its request id', async ({
    page,
    asAlice,
  }) => {
    const board = await asAlice.create(uniqueTitle('tracing navigation'));
    const sent = await captureFaro(page);

    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/api/boards/${board.id}`)),
      page.goto(`/boards/${board.id}`),
    ]);
    const requestId = response.headers()['x-request-id'] ?? '';

    await expect
      .poll(
        () =>
          ancestry(
            sent(),
            sent().find((s) => s.name === 'GET' && s.traceId === requestId),
          ),
        { message: 'span chain of the GET, innermost first', timeout: 10_000 },
      )
      .toEqual(['GET', 'navigation /boards/:boardId']);
  });
});
