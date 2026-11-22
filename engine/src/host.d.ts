/**
 * The host globals the core reads, declared here instead of the DOM lib (the core runs in Node
 * too, so tsconfig.json has no "dom").
 *
 * `location`: in a page the provider derives its default WebSocket origin from it
 * (collab/provider.ts). Node has no `location` - a Node host passes `socketOrigin`.
 */
// eslint-disable-next-line no-var -- an ambient global can only be declared with var
declare var location: { readonly protocol: string; readonly host: string };
