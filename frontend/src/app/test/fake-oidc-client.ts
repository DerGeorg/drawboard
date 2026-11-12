import { MetadataService, User } from 'oidc-client-ts';

import { OidcClient } from '../services/oidc-client';

/** An OIDC user as oidc-client-ts returns it - only the fields OidcAuth reads. */
export function anOidcUser(
  overrides: { expires_in?: number; access_token?: string; state?: unknown } = {},
): User {
  return {
    access_token: 'access-1',
    expires_in: 3600,
    ...overrides,
  } as User;
}

/** OidcClient for tests: every call is recorded, results and failures are set by the test. */
export class FakeOidcClient implements OidcClient {
  readonly calls: string[] = [];
  silentResults: (User | null | Error)[] = [null];
  callbackResult: User | Error = anOidcUser();
  signoutError: Error | undefined;
  loginArgs: unknown;
  /** The provider's end_session_endpoint (undefined = none, like Authelia; an Error = discovery failed). */
  endSessionEndpoint: string | undefined | Error = 'http://idp.test/end-session';

  readonly metadataService = {
    getEndSessionEndpoint: (): Promise<string | undefined> =>
      this.endSessionEndpoint instanceof Error
        ? Promise.reject(this.endSessionEndpoint)
        : Promise.resolve(this.endSessionEndpoint),
  } as unknown as MetadataService;

  getUser(): Promise<User | null> {
    this.calls.push('getUser');
    return Promise.resolve(null);
  }

  signinSilent(): Promise<User | null> {
    this.calls.push('signinSilent');
    const result =
      this.silentResults.length > 1 ? this.silentResults.shift() : this.silentResults[0];
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result ?? null);
  }

  signinRedirect(args?: unknown): Promise<void> {
    this.calls.push('signinRedirect');
    this.loginArgs = args;
    return Promise.resolve();
  }

  signinRedirectCallback(): Promise<User> {
    this.calls.push('signinRedirectCallback');
    return this.callbackResult instanceof Error
      ? Promise.reject(this.callbackResult)
      : Promise.resolve(this.callbackResult);
  }

  signoutRedirect(): Promise<void> {
    this.calls.push('signoutRedirect');
    return this.signoutError ? Promise.reject(this.signoutError) : Promise.resolve();
  }

  removeUser(): Promise<void> {
    this.calls.push('removeUser');
    return Promise.resolve();
  }
}
