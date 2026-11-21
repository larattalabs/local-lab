// Connectivity fallback only: never cache chats, sessions, API responses or media.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local Lab</title><style>body{background:#101317;color:#dfe5ec;font:18px system-ui;padding:32px;line-height:1.6}a{color:#d8a657}</style><h1>Your Mac is offline</h1><p>Accepted generations keep running while this phone is disconnected. Keep Local Lab running and the Mac awake on the same Wi-Fi.</p><a href="/">Reconnect</a>`, {headers:{'Content-Type':'text/html'}})));
});
