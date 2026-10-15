import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './style.css';

type Destination = { id: string; name: string; host: string; port: number; username: string; hasPassword: boolean };
type Session = { id: string; destinationId: string; name: string; host: string; username: string; status: string; error: string; viewers: number };
type Message = Record<string, any>;
const labels: Record<string, string> = { connecting: '接続中', connected: '接続済み', disconnected: '切断済み', error: '接続失敗' };
async function api(url: string, method = 'GET', body?: unknown) {
  const response = await fetch('/api/' + url, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '通信に失敗しました');
  return result;
}

function TerminalView({ session, active, online, send, subscribe, scrollback, notify }: {
  session: Session; active: boolean; online: boolean; send: (data: Message) => void; subscribe: (fn: (message: Message) => void) => () => void;
  scrollback: number; notify: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const control = useRef(false);
  const activeRef = useRef(active);
  const onlineRef = useRef(online);
  const connectedRef = useRef(session.status === 'connected');
  const [controlling, setControlling] = useState(false);
  const [keys, setKeys] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  const [query, setQuery] = useState('');
  const queue = useRef<string[]>([]);
  const waiting = useRef(false);
  activeRef.current = active; onlineRef.current = online; connectedRef.current = session.status === 'connected';
  const flush = () => {
    if (waiting.current || !control.current || !onlineRef.current || !queue.current.length) return;
    waiting.current = true;
    send({ type: 'input', id: session.id, data: queue.current.shift() });
  };
  const input = (data: string) => {
    if (!control.current || !onlineRef.current || !connectedRef.current) return;
    // Headless xterm owns terminal protocol replies. Browser xterm is only a display and keyboard.
    if (/^\x1b\[(?:\?|>)[\d;]*c$|^\x1b\[\d+;\d+R$|^\x1b\[0n$/.test(data)) return;
    if (ctrlRef.current && data.length === 1) { data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31); ctrlRef.current = false; setCtrl(false); }
    if (data.length + queue.current.reduce((n, x) => n + x.length, 0) > 262144) { notify('貼り付けは一度に256KBまでです'); return; }
    for (let offset = 0; offset < data.length;) {
      let end = Math.min(offset + 8000, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      queue.current.push(data.slice(offset, end)); offset = end;
    }
    flush();
  };
  const resize = () => {
    if (!activeRef.current || !control.current || !host.current?.offsetWidth || !terminal.current || !fit.current) return;
    fit.current.fit();
    send({ type: 'resize', id: session.id, cols: terminal.current.cols, rows: terminal.current.rows });
  };
  useEffect(() => {
    const term = new Terminal({ fontSize: 14, fontFamily: '"Noto Sans Mono", "DejaVu Sans Mono", monospace', scrollback, cursorBlink: true, allowProposedApi: true, theme: { background: '#0c111b', foreground: '#dae3f0', cursor: '#64d8bd', selectionBackground: '#3c546a' } });
    const fitter = new FitAddon(); const finder = new SearchAddon();
    term.loadAddon(fitter); term.loadAddon(finder); term.loadAddon(new WebLinksAddon());
    term.open(host.current!); terminal.current = term; fit.current = fitter; search.current = finder;
    const data = term.onData(input);
    const element = host.current!;
    let selecting = false;
    let disposed = false;
    const copySelection = () => {
      const text = term.getSelection();
      if (!text) return;
      if (!navigator.clipboard?.writeText) { notify('自動コピーにはHTTPS接続が必要です。ブラウザのコピー操作を使用してください'); return; }
      void navigator.clipboard.writeText(text).catch(() => { if (!disposed) notify('コピーできませんでした。クリップボードの権限を確認するか、ブラウザのコピー操作を使用してください'); });
    };
    // Copy the completed drag, rather than repeatedly writing partial selections.
    const selection = term.onSelectionChange(() => { if (!selecting && activeRef.current) copySelection(); });
    const canPaste = () => !disposed && activeRef.current && control.current && onlineRef.current && connectedRef.current;
    const pasteClipboard = async () => {
      if (!canPaste()) return;
      if (!navigator.clipboard?.readText) { notify('中ボタンでの貼り付けにはHTTPS接続が必要です。Ctrl+Vなどの貼り付け操作を使用してください'); return; }
      try {
        const text = await navigator.clipboard.readText();
        if (!canPaste()) return;
        // Use xterm's paste handling for newlines and bracketed paste in editors.
        term.paste(text); term.focus();
      } catch { if (!disposed) notify('貼り付けできませんでした。クリップボードの読み取りを許可するか、Ctrl+Vなどの貼り付け操作を使用してください'); }
    };
    const mouseDown = (event: MouseEvent) => {
      if (event.button === 0) selecting = true;
      if (event.button !== 1) return;
      event.preventDefault(); event.stopImmediatePropagation();
      void pasteClipboard();
    };
    const mouseUp = (event: MouseEvent) => {
      if (event.button !== 0 || !selecting) return;
      selecting = false;
      if (activeRef.current) copySelection();
    };
    const suppressMiddle = (event: MouseEvent) => {
      if (event.button !== 1) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    element.addEventListener('mousedown', mouseDown, true);
    element.addEventListener('mouseup', suppressMiddle, true);
    element.addEventListener('auxclick', suppressMiddle, true);
    document.addEventListener('mouseup', mouseUp);
    term.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
        copySelection();
        return false;
      }
      return true;
    });
    const unsubscribe = subscribe(message => {
      if (message.id !== session.id) return;
      if (message.type === 'snapshot') {
        control.current = message.controller; setControlling(message.controller); queue.current = []; waiting.current = false;
        term.reset(); term.resize(message.cols, message.rows);
        term.write(message.data, () => { resize(); if (activeRef.current) term.focus(); });
      } else if (message.type === 'output') term.write(message.data, () => send({ type: 'ack', id: session.id, bytes: message.bytes }));
      else if (message.type === 'size') term.resize(message.cols, message.rows);
      else if (message.type === 'control') { control.current = message.active; setControlling(message.active); queue.current = []; waiting.current = false; }
      else if (message.type === 'inputReady') { waiting.current = false; flush(); }
    });
    const observer = new ResizeObserver(() => requestAnimationFrame(resize)); observer.observe(host.current!);
    return () => {
      disposed = true;
      element.removeEventListener('mousedown', mouseDown, true);
      element.removeEventListener('mouseup', suppressMiddle, true);
      element.removeEventListener('auxclick', suppressMiddle, true);
      document.removeEventListener('mouseup', mouseUp);
      selection.dispose(); unsubscribe(); observer.disconnect(); data.dispose(); term.dispose(); terminal.current = null;
    };
  }, []);
  useEffect(() => {
    if (!online) { control.current = false; setControlling(false); queue.current = []; waiting.current = false; return; }
    const size = fit.current?.proposeDimensions();
    send({ type: 'attach', id: session.id, cols: size?.cols ?? 80, rows: size?.rows ?? 24 });
    return () => { send({ type: 'detach', id: session.id }); };
  }, [online]);
  useEffect(() => { if (active) requestAnimationFrame(() => { resize(); terminal.current?.focus(); }); }, [active, keys]);
  useEffect(() => { if (terminal.current) terminal.current.options.scrollback = scrollback; }, [scrollback]);
  const takeControl = () => { const size = fit.current?.proposeDimensions(); send({ type: 'takeControl', id: session.id, cols: size?.cols ?? 80, rows: size?.rows ?? 24 }); };
  return <section className={'terminal-panel ' + (active ? 'visible' : '')}>
    <div className="terminal-tools"><span className={'state ' + session.status}>{labels[session.status]}</span><span className="endpoint">{session.username}@{session.host}</span>
      {session.status === 'connected' && !controlling && <button onClick={takeControl}>操作権を取得</button>}
      <span className="spacer" />
      <input className="search" aria-label="履歴検索" placeholder="履歴検索" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search.current?.findNext(query); }} />
      <button onClick={() => search.current?.findNext(query)}>検索</button><button onClick={() => void document.documentElement.requestFullscreen?.().catch(() => notify('全画面表示を開始できません'))}>⛶</button>
      <button onClick={() => setKeys(value => !value)}>補助キー</button>
    </div>
    {!online && <div className="notice">ブラウザの通信を再接続中です。SSH接続はサーバー側で維持しています。</div>}
    {online && session.status === 'connected' && !controlling && <div className="notice">閲覧のみです。別の画面に操作権があります。</div>}
    {session.error && <div className="notice error">{session.error}</div>}
    <div className="terminal"><div ref={host} className="terminal-host" /></div>
    {keys && <div className="keybar">
      <button onPointerDown={e => e.preventDefault()} onClick={() => { input('\x1b'); terminal.current?.focus(); }}>Esc</button>
      <button className={ctrl ? 'selected' : ''} onPointerDown={e => e.preventDefault()} onClick={() => { ctrlRef.current = !ctrlRef.current; setCtrl(ctrlRef.current); terminal.current?.focus(); }}>Ctrl</button>
      {[['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'], ['Ctrl+C', '\x03'], ['Ctrl+D', '\x04']].map(([label, code]) => <button key={label} onPointerDown={e => e.preventDefault()} onClick={() => { input(code); terminal.current?.focus(); }}>{label}</button>)}
    </div>}
  </section>;
}

function App() {
  const [auth, setAuth] = useState<{ authenticated: boolean; mode: string } | null>(null);
  const [accessKey, setAccessKey] = useState('');
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState('');
  const [online, setOnline] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [scrollback, setScrollback] = useState(10000);
  const [settings, setSettings] = useState(false);
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<{ edit?: Destination; connect?: Destination } | null>(null);
  const [form, setForm] = useState({ name: '', host: '', port: 22, username: '', password: '', savePassword: false, saveDestination: true });
  const socket = useRef<WebSocket | null>(null);
  const handlers = useRef(new Set<(message: Message) => void>());
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = (message: string) => { setNotice(message); clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(''), 7000); };
  const send = (data: Message) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(data)); };
  const subscribe = (fn: (message: Message) => void) => { handlers.current.add(fn); return () => { handlers.current.delete(fn); }; };
  const load = async () => { const [targets, config] = await Promise.all([api('destinations'), api('settings')]); setDestinations(targets); setScrollback(config.scrollback); };
  const show = (id: string) => { setTabs(old => old.includes(id) ? old : [...old, id]); setActive(id); if (window.innerWidth < 760) setSidebar(false); };
  const removeTab = (id: string) => { setTabs(old => { const next = old.filter(value => value !== id); setActive(current => current === id ? (next[next.length - 1] ?? '') : current); return next; }); };
  useEffect(() => { void api('auth').then(setAuth).catch(error => notify(error.message)); }, []);
  useEffect(() => {
    if (!auth?.authenticated) return;
    void load().catch(error => notify(error.message));
    let stopped = false; let timer: ReturnType<typeof setTimeout>; let delay = 1000;
    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      socket.current = ws;
      ws.onopen = () => { delay = 1000; setOnline(true); };
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'sessions') {
          setSessions(message.sessions);
          const ids = new Set(message.sessions.map((session: Session) => session.id));
          setTabs(old => {
            const next = old.filter(id => ids.has(id));
            setActive(current => next.includes(current) ? current : (next[next.length - 1] ?? ''));
            return next;
          });
        }
        if (message.type === 'created') show(message.id);
        if (message.type === 'error') notify(message.message);
        for (const handler of handlers.current) handler(message);
      };
      ws.onclose = () => { setOnline(false); if (!stopped) { timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 10000); } };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); socket.current?.close(); };
  }, [auth?.authenticated]);
  useEffect(() => {
    const adjust = () => document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height ?? window.innerHeight}px`);
    adjust(); window.visualViewport?.addEventListener('resize', adjust); window.addEventListener('resize', adjust);
    return () => { window.visualViewport?.removeEventListener('resize', adjust); window.removeEventListener('resize', adjust); };
  }, []);
  function openDialog(value: { edit?: Destination; connect?: Destination } = {}) {
    const target = value.edit ?? value.connect;
    setForm({ name: target?.name ?? '', host: target?.host ?? '', port: target?.port ?? 22, username: target?.username ?? '', password: '', savePassword: target?.hasPassword ?? false, saveDestination: true }); setDialog(value);
  }
  function connectDestination(target: Destination) {
    if (target.hasPassword) { send({ type: 'connect', destinationId: target.id }); return; }
    openDialog({ connect: target });
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      if (dialog?.edit) { await api('destinations/' + dialog.edit.id, 'PUT', form); await load(); setDialog(null); return; }
      if (dialog?.connect) {
        if (form.savePassword) { await api('destinations/' + dialog.connect.id, 'PUT', { ...form, savePassword: true }); await load(); }
        send({ type: 'connect', destinationId: dialog.connect.id, password: form.password });
      } else {
        if (form.saveDestination) { const result = await api('destinations', 'POST', form); await load(); send({ type: 'connect', destinationId: result.id, password: form.password }); }
        else send({ type: 'connect', destination: form, password: form.password });
      }
      setDialog(null); setForm(old => ({ ...old, password: '' }));
    } catch (error: any) { notify(error.message); }
  }
  if (!auth) return <div className="auth-card">読み込み中…{notice}</div>;
  if (!auth.authenticated) return <div className="auth-page"><form className="auth-card" onSubmit={event => { event.preventDefault(); void api('login', 'POST', { token: accessKey }).then(() => { setAccessKey(''); return api('auth'); }).then(setAuth).catch(error => notify(error.message)); }}>
    <div className="brand">⌘ Web SSH</div><h1>ターミナルへ接続</h1>
    {auth.mode === 'proxy' ? <p>前段の認証・認可を確認してください。</p> : <><p>単独運用用のアクセスキーを入力してください。</p><input type="password" aria-label="アクセスキー" autoComplete="current-password" value={accessKey} onChange={e => setAccessKey(e.target.value)} required /><button className="primary">開く</button></>}
    {notice && <p className="error">{notice}</p>}
  </form></div>;
  const live = sessions.filter(s => ['connected', 'connecting'].includes(s.status));
  const reconnect = (session: Session) => {
    const target = destinations.find(destination => destination.id === session.destinationId);
    if (target) connectDestination(target); else openDialog();
  };
  const otherSessions = sessions.filter(session => !destinations.some(target => target.id === session.destinationId));
  const sessionName = (session: Session) => {
    const grouped = sessions.filter(item => item.destinationId === session.destinationId);
    return grouped.length > 1 ? `ターミナル ${grouped.findIndex(item => item.id === session.id) + 1}` : 'ターミナル';
  };
  const sessionRow = (session: Session, name: string) => <div key={session.id} className={'session-row ' + (active === session.id ? 'current' : '')}>
    <button onClick={() => show(session.id)} aria-label={`${session.name}・${name}を開く`}>
      <span className={'session-dot ' + session.status} /><span className="session-label">{name}</span><small className={session.status}>{labels[session.status]}</small>
    </button>
    {['connecting', 'connected'].includes(session.status) && <button className="session-disconnect" disabled={!online} title="SSH接続を強制切断" aria-label={`${session.name}・${name}を強制切断`} onClick={() => send({ type: 'disconnect', id: session.id })}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 3v9"/><path d="M6.3 5.8a9 9 0 1 0 11.4 0"/></svg></button>}
    {['error', 'disconnected'].includes(session.status) && <button className="session-delete" title="セッションを削除" aria-label={`${session.name}・${name}を削除`} onClick={() => void api('sessions/' + session.id, 'DELETE').then(() => removeTab(session.id)).catch(e => notify(e.message))}>×</button>}
  </div>;
  return <div className="app">
    <header><button className="menu" aria-label="接続先メニュー" title="接続先メニュー" onClick={() => setSidebar(value => !value)}>☰</button><div className="brand">⌘ Web SSH</div></header>
    {!online && !tabs.length && <div className="notice">Web SSHサーバーとの通信を再接続中です。</div>}
    <div className="workspace">
      {sidebar && <aside><button className="primary sidebar-new" disabled={!online} onClick={() => openDialog()}>＋ 新規接続</button><div className="section-title">接続先 <span>{live.length} 接続中</span></div>
        {!destinations.length && !otherSessions.length && <p className="muted">「新規接続」から接続先を追加できます。</p>}
        {destinations.map(target => {
          const grouped = sessions.filter(session => session.destinationId === target.id);
          return <div className="destination" key={target.id}>
            <div className="destination-heading"><div className="destination-name"><strong>{target.name}</strong></div>
              <button className="destination-action" disabled={!online} title="新しいセッション" aria-label={`${target.name}に新しいセッションを追加`} onClick={() => connectDestination(target)}>＋</button>
              <button className="destination-action" title="接続先を編集" aria-label={`${target.name}を編集`} onClick={() => openDialog({ edit: target })}>編集</button>
            </div>
            {!!grouped.length && <div className="destination-sessions">{grouped.map(session => sessionRow(session, sessionName(session)))}</div>}
          </div>;
        })}
        {!!otherSessions.length && <><div className="section-title">未保存の接続</div>{otherSessions.map(session => sessionRow(session, `${session.name}（${sessionName(session)}）`))}</>}
        <div className="sidebar-footer"><button className="sidebar-settings" onClick={() => setSettings(true)}><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-2v-3l3-1v-4l-3-1-1-3z"/><circle cx="11" cy="11" r="3"/></svg>設定</button></div>
      </aside>}
      <main><nav className="tabs">{tabs.map(id => {
        const session = sessions.find(s => s.id === id);
        return session && <div key={id} className={'tab ' + (id === active ? 'active' : '')}>
          <button onClick={() => setActive(id)}><i className={session.status}/>{session.name}（{sessionName(session)}）</button>
          {['disconnected', 'error'].includes(session.status) && <button className="tab-action" disabled={!online} title="SSH接続を再接続" aria-label={`${session.name}を再接続`} onClick={() => reconnect(session)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5"/><path d="M20 12a8 8 0 1 0-2.3 5.7M20 12a8 8 0 0 0-2.3-5.7"/></svg></button>}
        </div>;
      })}</nav>
        {tabs.map(id => { const session = sessions.find(s => s.id === id); return session && <TerminalView key={id} session={session} active={active === id} online={online} send={send} subscribe={subscribe} scrollback={scrollback} notify={notify} />; })}
        {!tabs.length && <div className="empty"><div className="terminal-mark">&gt;_</div><h1>いつでも、同じターミナルへ。</h1><p>接続先を選ぶか、新しいSSH接続を作成してください。</p><p className="muted">ブラウザを閉じても作業はサーバー側で続きます。</p><button className="primary" disabled={!online} onClick={() => openDialog()}>新規接続</button></div>}
      </main>
    </div>
    {notice && <div role="alert" className="toast" onClick={() => setNotice('')}>{notice}</div>}
    {dialog && <div className="modal-backdrop"><form className="modal" onSubmit={submit}><div className="modal-title"><h2>{dialog.edit ? '接続先を編集' : dialog.connect ? 'SSHパスワード入力' : '新規接続'}</h2><button type="button" onClick={() => { setDialog(null); setForm(old => ({ ...old, password: '' })); }}>×</button></div>
      {[['name', '接続名'], ['host', 'ホスト名 / IPアドレス'], ['username', 'SSHユーザー名']].map(([key, label]) => <label key={key}>{label}<input required disabled={!!dialog.connect} value={form[key as 'name' | 'host' | 'username']} onChange={e => setForm(old => ({ ...old, [key]: e.target.value }))} autoCapitalize="none" autoCorrect="off" spellCheck={false}/></label>)}
      <label>SSHポート<input type="number" min="1" max="65535" required disabled={!!dialog.connect} value={form.port} onChange={e => setForm(old => ({ ...old, port: Number(e.target.value) }))}/></label>
      <label>{dialog.edit?.hasPassword ? '新しいパスワード（空欄なら現在の値を維持）' : 'SSHパスワード'}<input type="password" autoComplete="new-password" required={!dialog.edit} value={form.password} onChange={e => setForm(old => ({ ...old, password: e.target.value }))}/></label>
      {!dialog.edit && !dialog.connect && <label className="checkbox"><input type="checkbox" checked={form.saveDestination} onChange={e => setForm(old => ({ ...old, saveDestination: e.target.checked }))}/>接続先を保存する</label>}
      {form.saveDestination && <label className="checkbox"><input type="checkbox" checked={form.savePassword} onChange={e => setForm(old => ({ ...old, savePassword: e.target.checked }))}/>パスワードを保存する</label>}
      <div className="modal-actions">{dialog.edit && <button type="button" className="danger" onClick={() => { if (confirm('この接続先を削除しますか？ 接続中のセッションは維持されます。')) void api('destinations/' + dialog.edit!.id, 'DELETE').then(load).then(() => setDialog(null)).catch(e => notify(e.message)); }}>接続先を削除</button>}<span className="spacer"/><button className="primary" disabled={!online}>{dialog.edit ? '保存' : '接続'}</button></div>
    </form></div>}
    {settings && <div className="modal-backdrop"><form className="modal" onSubmit={e => { e.preventDefault(); void api('settings', 'PUT', { scrollback }).then(() => setSettings(false)).catch(error => notify(error.message)); }}><div className="modal-title"><h2>設定</h2><button type="button" onClick={() => setSettings(false)}>×</button></div><label>1セッションの履歴保持行数<input type="number" min="0" max="100000" value={scrollback} onChange={e => setScrollback(Number(e.target.value))}/></label><p className="muted">履歴はメモリーに保持されます。Pod・コンテナ再起動で消えます。</p><div className="modal-actions"><span className="spacer"/><button className="primary">保存</button></div></form></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
