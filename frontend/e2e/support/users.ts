/**
 * Test users and URLs of the backend dev stack (backend repository: dev/keycloak/drawboard-realm.json,
 * dev/README.md - TODO: confirm names once the backend repository exists). Throwaway local values; in CI they come from the same realm file.
 */
export interface TestUser {
  readonly name: 'alice' | 'bob';
  readonly password: string;
  /** Provider SSO cookies after the UI login (auth.setup.ts), gitignored. */
  readonly storageState: string;
}

export const users = {
  alice: {
    name: 'alice',
    password: process.env['E2E_ALICE_PASSWORD'] ?? 'alice-dev',
    storageState: 'e2e/.auth/alice.json',
  },
  bob: {
    name: 'bob',
    password: process.env['E2E_BOB_PASSWORD'] ?? 'bob-dev',
    storageState: 'e2e/.auth/bob.json',
  },
} as const satisfies Record<string, TestUser>;

export const idp = {
  url: process.env['E2E_OIDC_URL'] ?? 'http://localhost:18180',
  realm: 'drawboard',
  // Confidential dev client with the password grant - only for seeding through the API.
  // The SPA client (drawboard-web) rejects the password grant on purpose.
  clientId: 'drawboard-dev',
  clientSecret: process.env['E2E_OIDC_CLIENT_SECRET'] ?? 'drawboard-dev-secret',
};

/** The backend directly (seeding, clean-up) - the browser goes through the image's /api proxy. */
export const backendUrl = process.env['E2E_BACKEND_URL'] ?? 'http://localhost:18081';
