// 서버 연결 담당: 자동 재연결, 핑 측정, 메시지 디스패치, 대역폭 집계.
export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.ping = 0;
    this.ready = false;
    this.joined = false;
    this.nick = '';
    this.cls = 'striker';
    this.room = 'main';
    this.token = localStorage.getItem('skyarena.token') || '';
    this.rx = 0;                 // 초당 수신 바이트
    this._rx = 0;
    this._rxT = performance.now();
    this._pingTimer = 0;
    this._retry = 0;
  }

  on(type, fn) { this.handlers.set(type, fn); return this; }

  connect(room = 'main') {
    this.room = room;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`);
    this.ws = ws;

    ws.onopen = () => {
      this.ready = true;
      this._retry = 0;
      this._emit('open');
      if (this.joined) this.join(this.nick, this.cls);   // 재연결 시 자동 재참가
      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => this.send({ t: 'pi', c: performance.now() }), 2000);
    };

    ws.onmessage = (e) => {
      const bytes = e.data.length;
      this._rx += bytes;
      const now = performance.now();
      if (now - this._rxT > 1000) {
        this.rx = Math.round(this._rx / ((now - this._rxT) / 1000) / 1024 * 10) / 10;
        this._rx = 0; this._rxT = now;
      }
      const m = JSON.parse(e.data);
      if (m.t === 'po') { this.ping = Math.round(performance.now() - m.c); return; }
      this._emit(m.t, m, bytes);
    };

    ws.onclose = () => {
      this.ready = false;
      clearInterval(this._pingTimer);
      this._emit('close');
      this._retry = Math.min(this._retry + 1, 6);
      setTimeout(() => this.connect(this.room), 400 * this._retry);
    };

    ws.onerror = () => ws.close();
  }

  _emit(type, msg, bytes) {
    const fn = this.handlers.get(type);
    if (fn) fn(msg, bytes);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  join(nick, cls, diff) {
    this.nick = nick;
    this.cls = cls || this.cls;
    this.diff = diff || this.diff;
    this.joined = true;
    this.send({ t: 'join', name: nick, cls: this.cls, diff: this.diff, token: this.token });
  }

  saveToken(token) {
    this.token = token;
    localStorage.setItem('skyarena.token', token);
  }
}
