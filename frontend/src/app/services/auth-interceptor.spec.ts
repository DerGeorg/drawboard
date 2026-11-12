import { HttpClient } from '@angular/common/http';
import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';

import { signedInAsAlice } from '../test/fake-auth';
import { expectRequest, provideHttpTesting, settle } from '../test/http-testing';

describe('authInterceptor', () => {
  let http: HttpClient;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpTesting(), signedInAsAlice().providers],
    });
    http = TestBed.inject(HttpClient);
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  describe('own API', () => {
    it('when a relative /api URL is called then the bearer token is attached', async () => {
      const response = firstValueFrom(http.get('/api/boards'));
      await settle();

      const request = expectRequest('GET', '/api/boards', 'list boards');
      expect(request.request.headers.get('Authorization'), 'Authorization header').toBe(
        'Bearer test-token',
      );
      request.flush({});
      await response;
    });

    it('when the caller set an Authorization header then it is kept', async () => {
      const response = firstValueFrom(
        http.get('/api/boards', { headers: { Authorization: 'Basic x' } }),
      );
      await settle();

      const request = expectRequest('GET', '/api/boards');
      expect(request.request.headers.get('Authorization'), 'caller header').toBe('Basic x');
      request.flush({});
      await response;
    });
  });

  describe('other URLs', () => {
    it.each([
      ['an absolute URL', 'https://evil.example/api/boards'],
      ['a protocol-relative URL', '//evil.example/api/boards'],
      ['a relative URL outside /api', '/config.json'],
      ['a path that only starts like /api', '/apiary'],
    ])('when %s is called then no token is attached', async (_what, url) => {
      const response = firstValueFrom(http.get(url));
      await settle();

      const request = TestBed.inject(HttpTestingController).expectOne(url, url);
      expect(request.request.headers.has('Authorization'), `Authorization header for ${url}`).toBe(
        false,
      );
      request.flush({});
      await response;
    });
  });
});
