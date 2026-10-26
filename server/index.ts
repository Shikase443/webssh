import express from 'express';
import { createServer } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Store, destination } from './store.js';
import { Sessions, audit } from './sessions.js';

const port = Number(process.env.PORT ?? 8093);
const mode = process.env.AUTH_MODE ?? 'token';
const token = process.env.APP_TOKEN ?? '';
if (mode !== 'token' && mode !== 'proxy') throw new Error('AUTH_MODE must be token or proxy');
if (mode === 'token' && token.length < 20) throw new Error('APP_TOKEN must contain at least 20 characters');
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
const store = new Store(process.env.DATA_DIR ?? './data');
await store.init();
const sessions = new Sessions(store, Number(process.env.MAX_SESSIONS ?? 20));
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"); next(); });
app.use(express.json({ limit: '32kb' }));
const equal = (a: string, b: string) => { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); };
function originOK(req: { headers: Record<string, any> }) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return false;
  if (allowedOrigins.length) return allowedOrigins.includes(origin);
  return origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
}
function authenticated(req: { headers: Record<string, any> }) {
  if (mode === 'proxy') return true;
  const cookie = String(req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith('webssh_access='))?.slice(14);
  if (!cookie) return false;
  const [expiry, signature] = cookie.split('.');
  return Number(expiry) > Date.now() && equal(signature ?? '', createHmac('sha256', token).update(expiry).digest('hex'));
}
const loginAttempts = new Map<string, number[]>();
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/auth', (req, res) => res.json({ authenticated: authenticated(req), mode }));
app.post('/api/login', (req, res) => {
  if (mode !== 'token') { res.status(403).json({ error: '前段の認証を確認してください' }); return; }
  if (!originOK(req)) { res.status(403).json({ error: 'Originが許可されていません' }); return; }
  const ip = req.socket.remoteAddress ?? '';
  const attempts = (loginAttempts.get(ip) ?? []).filter(time => Date.now() - time < 60000);
  if (attempts.length >= 10) { res.status(429).json({ error: '1分後に再試行してください' }); return; }
  attempts.push(Date.now()); loginAttempts.set(ip, attempts);
  if (typeof req.body.token !== 'string' || !equal(req.body.token, token)) { audit('app_auth_failed'); res.status(401).json({ error: 'アクセスキーが違います' }); return; }
  const expiry = String(Date.now() + 30 * 86400000);
  const signature = createHmac('sha256', token).update(expiry).digest('hex');
  res.setHeader('Set-Cookie', `webssh_access=${expiry}.${signature}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
  audit('app_authenticated'); res.json({ ok: true });
});
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!authenticated(req)) { res.status(401).json({ error: '認証が必要です' }); return; }
  if (!['GET', 'HEAD'].includes(req.method) && !originOK(req)) { res.status(403).json({ error: 'Originが許可されていません' }); return; }
  next();
});
app.get('/api/destinations', (_req, res) => res.json(store.publicDestinations()));
app.post('/api/destinations', async (req, res) => {
  const value = destination(req.body);
  const id = randomUUID();
  const password = req.body.savePassword && typeof req.body.password === 'string' ? req.body.password : undefined;
  await store.change(data => data.destinations.push({ id, ...value, ...(password !== undefined ? { password } : {}) }));
  res.status(201).json({ id });
});
app.put('/api/destinations/:id', async (req, res) => {
  const value = destination(req.body);
  await store.change(data => {
    const index = data.destinations.findIndex(item => item.id === req.params.id);
    if (index < 0) throw new Error('接続先が見つかりません');
    const previous = data.destinations[index];
    const password = req.body.savePassword ? (typeof req.body.password === 'string' && req.body.password.length ? req.body.password : previous.password) : undefined;
    data.destinations[index] = { id: previous.id, ...value, ...(password !== undefined ? { password } : {}) };
  });
  res.json({ ok: true });
});
app.delete('/api/destinations/:id', async (req, res) => {
  await store.change(data => { data.destinations = data.destinations.filter(item => item.id !== req.params.id); });
  res.json({ ok: true });
});
app.get('/api/settings', (_req, res) => res.json({ scrollback: store.data.scrollback, maxSessions: sessions.max }));
app.put('/api/settings', async (req, res) => {
  const scrollback = Number(req.body.scrollback);
  if (!Number.isInteger(scrollback) || scrollback < 0 || scrollback > 100000) throw new Error('履歴は0〜100000行で指定してください');
  await store.change(data => { data.scrollback = scrollback; });
  for (const session of sessions.items.values()) session.terminal.options.scrollback = scrollback;
  sessions.updated(); res.json({ ok: true });
});
app.get('/api/sessions', (_req, res) => res.json(sessions.list()));
app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.items.get(String(req.params.id));
  if (session && ['connecting', 'connected'].includes(session.status)) { res.status(409).json({ error: '先に強制切断してください' }); return; }
  session?.dispose(); sessions.items.delete(String(req.params.id)); sessions.updated(); res.json({ ok: true });
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'APIが見つかりません' }));
app.use(express.static(path.resolve('dist/client')));
app.get('/', (_req, res) => res.sendFile(path.resolve('dist/client/index.html')));
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error.code ? '設定の読み書きに失敗しました' : error.type ? '入力データが不正です' : error.message;
  res.status(400).json({ error: message ?? '処理に失敗しました' });
});
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 32768 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !authenticated(req) || !originOK(req)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', ws => {
  const viewer = { id: randomUUID(), ws, pendingBytes: 0 };
  let alive = true;
  let messages = 0;
  const heartbeat = setInterval(() => { if (!alive) { ws.terminate(); return; } alive = false; messages = 0; ws.ping(); }, 15000);
  ws.on('pong', () => { alive = true; });
  sessions.listeners.add(ws);
  sessions.updated();
  ws.on('message', async raw => {
    try {
      if (++messages > 5000) throw new Error('入力頻度が高すぎます');
      const message = JSON.parse(raw.toString());
      if (message.type === 'connect') {
        const saved = store.data.destinations.find(item => item.id === message.destinationId);
        const target = saved ?? { id: randomUUID(), ...destination(message.destination) };
        const password = typeof message.password === 'string' ? message.password : saved?.password;
        if (password === undefined) throw new Error('SSHパスワードを入力してください');
        const cols = Number.isInteger(message.cols) && message.cols >= 2 && message.cols <= 500 ? message.cols : 80;
        const rows = Number.isInteger(message.rows) && message.rows >= 2 && message.rows <= 300 ? message.rows : 24;
        const session = sessions.create(target, password, cols, rows);
        ws.send(JSON.stringify({ type: 'created', id: session.id }));
      } else {
        const session = sessions.items.get(message.id);
        // Deletion can race with an unmount detach or a final output acknowledgement.
        if (!session && ['detach', 'ack'].includes(message.type)) return;
        if (!session) throw new Error('セッションが見つかりません');
        if (message.type === 'reconnect') {
          const saved = store.data.destinations.find(item => item.id === session.target.id && item.host === session.target.host && item.port === session.target.port && item.username === session.target.username);
          const password = typeof message.password === 'string' ? message.password : saved?.password;
          if (password === undefined) throw new Error('SSHパスワードを入力してください');
          sessions.reconnect(session, password);
        } else if (message.type === 'attach') await session.attach(viewer, message.cols, message.rows);
        else if (message.type === 'ack') session.acknowledge(viewer.id, message.bytes);
        else if (message.type === 'detach') session.detach(viewer.id);
        else if (message.type === 'input') {
          if (typeof message.data !== 'string' || message.data.length > 16384) throw new Error('入力サイズが大きすぎます');
          session.input(viewer.id, message.data);
        } else if (message.type === 'resize' && session.controller === viewer.id) await session.enqueue(() => session.resize(message.cols, message.rows));
        else if (message.type === 'disconnect') session.end();
        else if (message.type === 'takeControl') await session.attach(viewer, message.cols, message.rows);
      }
    } catch (error: any) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message: error.code ? '処理に失敗しました' : error.message })); }
  });
  ws.on('error', () => {});
  ws.on('close', () => { clearInterval(heartbeat); sessions.listeners.delete(ws); for (const session of sessions.items.values()) session.detach(viewer.id); });
});
server.listen(port, '0.0.0.0', () => audit('app_started', { port, mode }));
function shutdown() {
  audit('app_stopping');
  for (const session of sessions.items.values()) session.end();
  for (const ws of wss.clients) ws.close(1001, 'Server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
