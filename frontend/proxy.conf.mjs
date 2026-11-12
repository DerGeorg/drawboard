// ng serve: same-origin /api, /files, /plugin-assets and /faro like the nginx image (deploy/nginx/default.conf.template).
// BACKEND_URL / FARO_RECEIVER_URL override the local defaults of the backend dev stack.
export default {
  '/api': {
    target: process.env.BACKEND_URL ?? 'http://localhost:18081',
    secure: false,
    // the collaboration WebSocket /api/boards/{id}/collab (the backend checks Origin, which
    // stays http://localhost:4200 - its dev profile expects exactly that)
    ws: true,
  },
  // signed file URLs and plugin assets are served by the backend outside /api, like in nginx
  '/files': { target: process.env.BACKEND_URL ?? 'http://localhost:18081', secure: false },
  '/plugin-assets': { target: process.env.BACKEND_URL ?? 'http://localhost:18081', secure: false },
  '/faro': {
    target: process.env.FARO_RECEIVER_URL ?? 'http://localhost:12347',
    secure: false,
    pathRewrite: { '^/faro': '' },
  },
};
