import { randomUUID, createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import ssh2 from 'ssh2';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { WebSocket } from 'ws';
import { Store, type Destination } from './store.js';

const { Client } = ssh2;
const { Terminal } = headless;
const { SerializeAddon } = serialize;
export const audit = (event: string, detail: Record<string, unknown> = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...detail }));
type Viewer = { ws: WebSocket; id: string; pendingBytes: number };
type Status = 'connecting' | 'connected' | 'disconnected' | 'error';

export class Session {
  readonly id = randomUUID();
  readonly created = new Date().toISOString();
  status: Status = 'connecting';
  error = '';
  readonly terminal;
  readonly serializer = new SerializeAddon();
  readonly ssh = new Client();
  channel?: ssh2.ClientChannel;
  viewers = new Map<string, Viewer>();
  controller: string | null = null;
  private decoder = new StringDecoder('utf8');
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private inputBlocked = false;
  private finished = false;
  constructor(readonly target: Omit<Destination, 'password'>, readonly store: Store, readonly updated: () => void, cols = 80, rows = 24) {
    this.terminal = new Terminal({ cols, rows, scrollback: store.data.scrollback, allowProposedApi: true });
    this.terminal.loadAddon(this.serializer);
    // Terminal protocol replies must come from exactly one emulator, including when browsers are absent.
    this.terminal.onData(data => { if (this.channel && this.status === 'connected') this.channel.write(data); });
  }
  info() { return { id: this.id, destinationId: this.target.id, name: this.target.name, host: this.target.host, username: this.target.username, status: this.status, error: this.error, created: this.created, viewers: this.viewers.size }; }
  enqueue(task: () => Promise<void> | void) {
    this.chain = this.chain.then(task).catch(() => { this.end('ターミナル処理に失敗しました'); });
    return this.chain;
  }
  send(ws: WebSocket, message: unknown) {
    if (ws.readyState !== WebSocket.OPEN) return;
    // A slow viewer can reopen and restore the canonical screen instead of growing memory indefinitely.
    if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(1013, 'Viewer too slow'); return; }
    ws.send(JSON.stringify(message));
  }
  broadcast(message: unknown) { for (const { ws } of this.viewers.values()) this.send(ws, message); }
  output(data: string) {
    this.pending += Buffer.byteLength(data);
    if (this.pending > 256 * 1024) this.channel?.pause();
    void this.enqueue(() => new Promise<void>(resolve => {
      this.terminal.write(data, () => {
        this.pending -= Buffer.byteLength(data);
        const bytes = Buffer.byteLength(data);
        for (const viewer of this.viewers.values()) {
          if (viewer.pendingBytes > 1024 * 1024) { viewer.ws.close(1013, 'Display too slow'); continue; }
          viewer.pendingBytes += bytes;
          this.send(viewer.ws, { type: 'output', id: this.id, data, bytes });
        }
        if (this.pending < 128 * 1024) this.channel?.resume();
        resolve();
      });
    }));
  }
  connect(password: string) {
    this.ssh.on('ready', () => {
      audit('ssh_authenticated', { id: this.id, host: this.target.host });
      if (this.finished) { this.ssh.end(); return; }
      this.ssh.shell({ term: 'xterm-256color', cols: this.terminal.cols, rows: this.terminal.rows }, (error, channel) => {
        if (error) { this.end('対話型シェルを開始できませんでした'); return; }
        if (this.finished) { channel.close(); return; }
        this.channel = channel;
        this.status = 'connected';
        channel.on('data', (data: Buffer) => this.output(this.decoder.write(data)));
        channel.stderr.on('data', (data: Buffer) => this.output(this.decoder.write(data)));
        channel.on('drain', () => { this.inputBlocked = false; this.broadcast({ type: 'inputReady', id: this.id }); });
        channel.on('error', () => this.end('SSHチャネルでエラーが発生しました'));
        channel.on('close', () => { const tail = this.decoder.end(); if (tail) this.output(tail); this.end(); });
        this.broadcast({ type: 'status', ...this.info() });
        this.updated();
      });
    });
    this.ssh.on('error', (error: Error) => {
      const message = /authentication/i.test(error.message) ? 'SSH認証に失敗しました' : /ENOTFOUND/.test(error.message) ? 'ホスト名を解決できません' : /ECONNREFUSED/.test(error.message) ? 'SSH接続が拒否されました' : /timed out|ETIMEDOUT/i.test(error.message) ? 'SSH接続がタイムアウトしました' : 'SSH接続でエラーが発生しました';
      this.end(message);
    });
    this.ssh.on('close', () => this.end());
    audit('ssh_connect', { id: this.id, host: this.target.host, port: this.target.port });
    this.ssh.connect({ host: this.target.host, port: this.target.port, username: this.target.username, password,
      readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3,
      hostVerifier: (hostKey: Buffer, callback: (valid: boolean) => void) => {
        const hash = createHash('sha256').update(hostKey).digest('hex');
        const key = `${this.target.host}:${this.target.port}`;
        const previous = this.store.data.hosts[key];
        this.store.change(data => { data.hosts[key] = hash; }).then(() => {
          if (previous !== hash) audit(previous ? 'host_key_updated' : 'host_key_registered', { host: key });
          callback(true);
        }).catch(() => { callback(false); this.end('ホスト鍵を保存できませんでした'); });
      }
    });
  }
  attach(viewer: Viewer, cols: number, rows: number) {
    // Snapshot and subsequent output share the same queue; no bytes can be missed or duplicated.
    return this.enqueue(() => {
      if (viewer.ws.readyState !== WebSocket.OPEN) return;
      const old = this.controller;
      if (old && old !== viewer.id) this.send(this.viewers.get(old)!.ws, { type: 'control', id: this.id, active: false });
      this.controller = viewer.id;
      this.resize(cols, rows);
      this.viewers.set(viewer.id, viewer);
      this.send(viewer.ws, { type: 'snapshot', ...this.info(), cols: this.terminal.cols, rows: this.terminal.rows, data: this.serializer.serialize(), controller: true });
      this.updated();
    });
  }
  detach(viewerId: string) {
    this.viewers.delete(viewerId);
    if (this.controller === viewerId) this.controller = null;
    this.updated();
  }
  acknowledge(viewerId: string, bytes: number) {
    const viewer = this.viewers.get(viewerId);
    if (viewer && Number.isInteger(bytes) && bytes > 0) viewer.pendingBytes = Math.max(0, viewer.pendingBytes - bytes);
  }
  resize(cols: number, rows: number) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 300) return;
    if (cols === this.terminal.cols && rows === this.terminal.rows) return;
    this.terminal.resize(cols, rows);
    this.channel?.setWindow(rows, cols, 0, 0);
    this.broadcast({ type: 'size', id: this.id, cols, rows });
  }
  input(viewerId: string, data: string) {
    if (this.controller !== viewerId || this.status !== 'connected' || !this.channel) return;
    if (this.inputBlocked) { this.send(this.viewers.get(viewerId)!.ws, { type: 'error', message: '入力が混雑しています。少し待ってください' }); return; }
    this.inputBlocked = !this.channel.write(data);
    if (!this.inputBlocked) this.send(this.viewers.get(viewerId)!.ws, { type: 'inputReady', id: this.id });
  }
  end(error = '') {
    if (this.finished) return;
    this.finished = true;
    this.status = error ? 'error' : 'disconnected';
    this.error = error;
    this.ssh.end();
    void this.enqueue(() => { this.broadcast({ type: 'status', ...this.info() }); this.updated(); });
    audit(error ? 'ssh_error' : 'ssh_disconnected', { id: this.id, ...(error ? { reason: error } : {}) });
  }
  dispose() { this.end(); this.terminal.dispose(); }
}

export class Sessions {
  items = new Map<string, Session>();
  listeners = new Set<WebSocket>();
  attempts: number[] = [];
  constructor(readonly store: Store, readonly max = 20) {}
  list() { return [...this.items.values()].map(session => session.info()); }
  updated = () => { for (const ws of this.listeners) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4 * 1024 * 1024) ws.send(JSON.stringify({ type: 'sessions', sessions: this.list() })); };
  create(target: Destination, password: string, cols: number, rows: number) {
    const now = Date.now();
    this.attempts = this.attempts.filter(time => now - time < 60000);
    if (this.attempts.length >= 10) throw new Error('接続試行が多すぎます。1分後に再試行してください');
    if (this.items.size >= this.max) throw new Error('セッション数の上限です。不要な切断済みセッションを削除してください');
    this.attempts.push(now);
    const { password: _secret, ...metadata } = target;
    const session = new Session(metadata, this.store, this.updated, cols, rows);
    this.items.set(session.id, session);
    session.connect(password);
    this.updated();
    return session;
  }
}
