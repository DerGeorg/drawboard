import { HttpErrorResponse } from '@angular/common/http';
import { ApplicationInitStatus, ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { TransportItem } from '@grafana/faro-web-sdk';

import { TEST_RUNTIME_CONFIG } from '../test/runtime-config';
import { FaroErrorHandler, FaroSession, provideFaro, scrubTransportItem } from './faro';

describe('faro', () => {
  describe('provideFaro', () => {
    it('when the runtime config has no Faro block then only the error handler is installed', async () => {
      TestBed.configureTestingModule({
        providers: [provideRouter([]), provideFaro(TEST_RUNTIME_CONFIG)],
      });
      await TestBed.inject(ApplicationInitStatus).donePromise;

      expect(TestBed.inject(ErrorHandler), 'error handler').toBeInstanceOf(FaroErrorHandler);
      expect(TestBed.inject(FaroSession).active, 'Faro session').toBe(false);
    });

    it('when the page load is not sampled then the SDK is not even loaded', async () => {
      const config = {
        ...TEST_RUNTIME_CONFIG,
        faro: { collectorUrl: '/faro/collect', appName: 'app', namespace: 'ns', samplingRate: 0 },
      };
      TestBed.configureTestingModule({ providers: [provideRouter([]), provideFaro(config)] });
      await TestBed.inject(ApplicationInitStatus).donePromise;

      expect(TestBed.inject(FaroSession).active, 'Faro session of an unsampled page load').toBe(
        false,
      );
    });
  });

  describe('FaroErrorHandler', () => {
    let pushed: Error[];
    let handler: FaroErrorHandler;

    beforeEach(() => {
      pushed = [];
      TestBed.configureTestingModule({
        providers: [
          FaroErrorHandler,
          { provide: FaroSession, useValue: { pushError: (error: Error) => pushed.push(error) } },
        ],
      });
      handler = TestBed.inject(FaroErrorHandler);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => vi.restoreAllMocks());

    it('when an Error reaches Angular then it is pushed to Faro and logged', () => {
      const error = new Error('boom');

      handler.handleError(error);

      expect(pushed, 'errors pushed to Faro').toEqual([error]);
      expect(console.error, 'console output').toHaveBeenCalledWith(error);
    });

    it('when something else is thrown then it is wrapped into an Error', () => {
      handler.handleError('just a string');

      expect(
        pushed.map((e) => e.message),
        'messages pushed to Faro',
      ).toEqual(['Non-error thrown: just a string']);
    });

    it('when a failed HTTP call reaches Angular then Faro is left alone', () => {
      handler.handleError(new HttpErrorResponse({ status: 500 }));

      expect(pushed, 'errors pushed to Faro').toEqual([]);
    });
  });

  describe('scrubTransportItem', () => {
    it('when the browser meta holds frozen arrays then the item is scrubbed and kept, not dropped', () => {
      // Chrome freezes navigator.userAgentData.brands, which Faro copies into every item's meta
      const brands = Object.freeze([
        Object.freeze({ brand: 'Google Chrome', version: '142' }),
        Object.freeze({ brand: 'Chromium', version: '142' }),
      ]);
      const signed = '/files/0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f?v=original&exp=1&sig=SECRETSIG';
      const item = {
        type: 'event',
        meta: Object.freeze({
          browser: Object.freeze({ name: 'Chrome', brands }),
          page: { url: `https://app.example${signed}` },
        }),
        payload: {
          name: 'x',
          attributes: Object.freeze({ 'url.full': `https://app.example${signed}` }),
        },
      } as unknown as TransportItem;

      const scrubbed = scrubTransportItem(item) as unknown as {
        meta: { browser: { brands: { brand: string }[] }; page: { url: string } };
        payload: { attributes: Record<string, string> };
      };

      expect(
        scrubbed.meta.browser.brands.map((b) => b.brand),
        'brands kept',
      ).toEqual(['Google Chrome', 'Chromium']);
      expect(scrubbed.meta.page.url, 'page URL without the query').toBe(
        'https://app.example/files/0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f',
      );
      expect(JSON.stringify(scrubbed), 'no signature (S7.2)').not.toContain('SECRETSIG');
      expect(brands[0]?.brand, 'the frozen input is untouched').toBe('Google Chrome');
    });

    it('when a signed file URL shows up in a span, a message or a resource name then its signature is removed', () => {
      const signed = '/files/0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f?v=original&exp=1&sig=SECRETSIG';
      const item = {
        type: 'exception',
        meta: {},
        payload: {
          value: `Unexpected server response (403) while retrieving PDF "https://app.example${signed}".`,
          stacktrace: { frames: [] },
          context: { 'http.url': `https://app.example${signed}`, note: `GET ${signed} failed` },
        },
      } as unknown as TransportItem;

      const text = JSON.stringify(scrubTransportItem(item));

      expect(text, 'no signature anywhere (S7.2)').not.toContain('SECRETSIG');
      expect(text, 'the path stays').toContain('/files/0192f5e0-7c1a-7b3e-8f00-2a1b3c4d5e6f');
    });

    it('when page, event and span carry query strings then all of them are removed', () => {
      const item = {
        type: 'event',
        meta: { page: { url: 'https://app.example/boards?page=2#top' } },
        payload: {
          attributes: { 'url.full': 'https://app.example/api/boards?page=1&size=10' },
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: [
                    {
                      attributes: [
                        { key: 'http.url', value: { stringValue: '/api/boards?secret=x' } },
                        { key: 'http.method', value: { stringValue: 'GET' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      } as unknown as TransportItem;

      const scrubbed = scrubTransportItem(item) as unknown as {
        meta: { page: { url: string } };
        payload: {
          attributes: Record<string, string>;
          resourceSpans: {
            scopeSpans: { spans: { attributes: { value: { stringValue: string } }[] }[] }[];
          }[];
        };
      };

      expect(scrubbed.meta.page.url, 'page URL').toBe('https://app.example/boards');
      expect(scrubbed.payload.attributes['url.full'], 'event URL').toBe(
        'https://app.example/api/boards',
      );
      const spanAttributes = scrubbed.payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;
      expect(
        spanAttributes.map((a) => a.value.stringValue),
        'span attributes',
      ).toEqual(['/api/boards', 'GET']);
    });

    it('when URLs with query strings or fragments are hidden anywhere in the item then none survives', () => {
      const secret = 'share-token-123';
      const item = {
        type: 'exception',
        meta: {
          page: { url: `https://app.example/boards/1#share=${secret}` },
          browser: { referrer: `https://other.example/x?t=${secret}` },
        },
        payload: {
          value: `Failed to load https://app.example/open#v1.${secret} and /api/x?q=${secret}`,
          stacktrace: {
            frames: [{ filename: `https://app.example/main.js?v=${secret}`, lineno: 1 }],
          },
          context: { location: `/boards/1?invite=${secret}`, nested: { href: `/a#${secret}` } },
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: [
                    {
                      attributes: [
                        { key: 'url.full', value: { stringValue: `/open#v1.${secret}` } },
                        { key: 'url.query', value: { stringValue: `t=${secret}` } },
                        { key: 'url.fragment', value: { stringValue: secret } },
                        { key: 'http.target', value: { stringValue: `/api/b?t=${secret}` } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      } as unknown as TransportItem;

      const text = JSON.stringify(scrubTransportItem(item));

      expect(text, 'item after scrubbing').not.toContain(secret);
      expect(text, 'item after scrubbing').not.toMatch(/https?:\/\/[^"\s]*[?#]/);
      expect(text, 'page URL kept as origin + path').toContain('https://app.example/boards/1');
    });

    it('when an URL has neither query nor fragment then it is left alone', () => {
      const item = {
        type: 'event',
        meta: { page: { url: 'https://app.example/boards/1' } },
        payload: { name: 'plain text', attributes: { 'url.full': '/api/boards' } },
      } as unknown as TransportItem;

      expect(JSON.stringify(scrubTransportItem(item)), 'item').toBe(
        '{"type":"event","meta":{"page":{"url":"https://app.example/boards/1"}},"payload":{"name":"plain text","attributes":{"url.full":"/api/boards"}}}',
      );
    });
  });
});
