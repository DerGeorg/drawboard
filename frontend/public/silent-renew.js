// oidc-client-ts loads the authorization request with prompt=none in a hidden iframe; the
// provider redirects the iframe here. This hands the result (code + state in the URL) to the
// app window, which finishes the request. Same message format as oidc-client-ts's own
// signinSilentCallback(), without bundling the library into this page. An external file, not
// inline: the CSP of this page is script-src 'self'.
window.parent.postMessage(
  { source: 'oidc-client', url: window.location.href, keepOpen: false },
  window.location.origin,
);
