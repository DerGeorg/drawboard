/**
 * The address of a page on localhost, for collab/provider.spec.ts: without `socketOrigin` the
 * provider derives its WebSocket origin from the page `location`. Node has none; the frontend's
 * tests get this one from jsdom. Only the `page` project of vitest.config.ts loads this file.
 */
vi.stubGlobal('location', new URL('http://localhost:3000/'));
