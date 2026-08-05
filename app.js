/* ============================================================
   一起看 v43 — Cinema Architecture (sync & security fixes)
   IIFE · 模块化 · 移动优先 · MQTT 同步
   ============================================================ */
(function() {
'use strict';

// ============================================================
// MODULE 0: 基础工具
// ============================================================
const $ = (sel, ctx) => (ctx||document).querySelector(sel);
const $$ = (sel, ctx) => [...(ctx||document).querySelectorAll(sel)];

function safeJSON(str) {
  try { return JSON.parse(str); } catch(e) { return null; }
}

function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

function genId() {
  return String(Math.floor(1000 + Math.random() * 9000));  // 4-digit room code
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function copyText(text) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea'); ta.value = text;
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch(e) {}
  document.body.removeChild(ta);
}

// ============================================================
// MODULE 1: 配置
// ============================================================
const CFG = {
  MQTT_BROKER: 'wss://broker.emqx.io:8084/mqtt',
  MQTT_OPTS: { keepalive: 30, clean: true, reconnectPeriod: 0, connectTimeout: 15000 },
  // 多代理 fallback (codetabs 可能 522)
  PROXIES: [
    'https://proxy.cors.sh/',
    'https://api.codetabs.com/v1/proxy/?quest=',
  ],
  // 片源: 苹果CMS v10 JSON API, 直接返回 m3u8 — 4源并行
  SEARCH_SOURCES: [
    { name: 'lziapi', icon: '🟢', api: 'https://cj.lziapi.com/api.php/provide/vod/' },
    { name: 'ffzy', icon: '🔵', api: 'https://cj.ffzyapi.com/api.php/provide/vod/' },
    { name: 'mdzy', icon: '🟣', api: 'https://www.mdzyapi.com/api.php/provide/vod/' },
    { name: 'dzzy', icon: '🟠', api: 'https://cdn.dzzyapi.com/api.php/provide/vod/' },
  ],
  EMOJI: ['😂','😭','❤️','👍','🔥','🎉','😱','👏','🤔','💩'],
  RECONNECT_DELAYS: [1000, 2000, 4000, 8000, 15000, 30000],
  SYNC_DEBOUNCE: 200,
};
let proxyIdx = 0;

function getProxy(i) { return CFG.PROXIES[i != null ? i : proxyIdx]; }
function rotateProxy() { proxyIdx = (proxyIdx + 1) % CFG.PROXIES.length; }

// ============================================================
// MODULE 2: DOM 管理器 (自动扫描全部 [id])
// ============================================================
const DOM = { _map:{} };
function initDOM() {
  $$('[id]').forEach(el => { if (el.id) DOM._map[el.id] = el; });
}
function el(id) { return DOM._map[id] || null; }

// ============================================================
// MODULE 3: Toast
// ============================================================
const Toast = {
  show(msg, type) {
    const t = document.createElement('div');
    t.className = 'toast ' + (type||'');
    t.textContent = msg;
    el('toast-container').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s';
      setTimeout(() => t.remove(), 300); }, 3000);
  },
  info(m) { this.show(m, 'info'); },
  warn(m) { this.show(m, 'warn'); },
  error(m) { this.show(m, 'error'); },
};

// ============================================================
// MODULE 4: 应用状态
// ============================================================
const S = {
  nickname: localStorage.getItem('wt_nick') || '',
  roomId: '',
  connState: 'idle', // idle|connecting|connected|reconnecting|degraded|disconnected
  peerName: '',
  peerOnline: false,
  peerPlaying: true,
  peerVideo: '',
  isSyncing: false,
  lastSyncRx: 0,     // 上次接收同步的时间戳，防止连续回调
  videoUrl: null,
  videoType: null,
  playbackSpeed: 1,
  hlsInstance: null,
  hlsRetryDone: false,
  episodes: [],
  currentEpisode: 0,
  episodeSource: '',
  client: null,
  reconnectAttempt: 0,
  reconnectTimer: null,
  reconnecting: false,
  muted: false,
  unreadChat: 0,
  chatHidden: true,
  lastLocalAction: 0,   // 本地操作时间戳，防远端回弹
  lastManualSeek: 0,    // 拖动进度条时间戳，10s 保护窗口
  videoTitle: '',       // 当前播放的片名（用于播放列表显示）
  seekWaitAck: false,   // 等待对方 seek-ack 确认
  _seekAckTimer: null,  // seek-ack 超时计时器
  _skipSeekSync: false, // 本地键盘快进/快退时跳过 seek 同步
  _blobUrls: [],        // SSL 重试生成的 blob URL（cleanup 时统一回收）
  lastPeerSeen: 0,      // 最近一次收到对方消息的时间（离线心跳检测）
};

// ============================================================
// MODULE 5: 网络
// ============================================================
const Net = {
  fetch(url, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
  },

  // 尝试直连 → 代理1 → 代理2
  proxyGet(url, timeoutMs = 12000) {
    const start = proxyIdx;
    function tryNext(err) {
      rotateProxy();
      if (proxyIdx === start) return Promise.reject(err || new Error('所有代理已耗尽'));
      return Net.fetch(getProxy() + encodeURIComponent(url), timeoutMs).then(r => r.text()).catch(tryNext);
    }
    // 先尝试直连 (某些 API 有 CORS 头)
    return Net.fetch(url, timeoutMs).then(r => r.text()).catch(() => {
      // 直连失败 → 走代理 (编码防止 ? & 被截断)
      return Net.fetch(getProxy() + encodeURIComponent(url), timeoutMs).then(r => r.text()).catch(tryNext);
    });
  },
};

// ============================================================
// MODULE 6: 日志与聊天
// ============================================================
const Log = {
  add(text, cls) {
    const list = el('msg-list');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'msg-row' + (cls ? ' ' + cls : '');
    const now = new Date();
    const time = ('0'+now.getHours()).slice(-2) + ':' + ('0'+now.getMinutes()).slice(-2);
    const escaped = escapeHtml(text);
    const linked = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    row.innerHTML = '<span class="msg-time">'+time+'</span><span class="msg-bubble">'+linked+'</span>';
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
    if (el('chat-empty')) el('chat-empty').classList.add('hidden');
  },
  sys(text) { this.add(text, 'sys'); },
  chat(name, text, self) {
    const list = el('msg-list');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'msg-row' + (self ? ' self' : '');
    const now = new Date();
    const time = ('0'+now.getHours()).slice(-2) + ':' + ('0'+now.getMinutes()).slice(-2);
    const safeName = escapeHtml(self ? '我' : (name || '朋友'));
    const escaped = escapeHtml(text || '');
    const linked = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    row.innerHTML = '<span class="msg-name">' + safeName + ' · ' + time + '</span><span class="msg-bubble">' + linked + '</span>';
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
    if (el('chat-empty')) el('chat-empty').classList.add('hidden');
  },
};

// ============================================================
// MODULE 7: MQTT 连接管理
// ============================================================
const MQTT = {
  setState(state) {
    S.connState = state;
    const dot = el('conn-dot'), st = el('status');
    if (dot) { dot.className = 'conn-dot ' + state; }
    if (st) {
      const map = { idle:'就绪', connecting:'连接中...', connected:'已连接', reconnecting:'重连中...', degraded:'降级模式', disconnected:'已断开' };
      st.textContent = map[state] || state;
    }
  },

  connect(roomId) {
    if (S.client) { try { S.client.end(true); } catch(e) {} }
    this.setState('connecting');
    S.roomId = roomId;
    S.reconnectAttempt = 0;
    S.reconnecting = false;

    const client = mqtt.connect(CFG.MQTT_BROKER, CFG.MQTT_OPTS);
    S.client = client;

    client.on('connect', () => {
      this.setState('connected');
      S.reconnectAttempt = 0;
      S.reconnecting = false;
      client.subscribe('wt/' + roomId + '/#');
      Log.sys('✓ 已连接 · 进入房间');
      const badge = el('room-badge'); if (badge) badge.textContent = roomId;
      // Send join now that we're connected
      if (S.nickname) MQTT.publish({ t: 'join', name: S.nickname });
    });

    client.on('message', (topic, payload) => {
      try { MsgHandler.handle(topic, JSON.parse(payload.toString())); } catch(e) {}
    });

    client.on('close', () => {
      if (S.connState === 'connected') {
        this.setState('disconnected');
        this._scheduleReconnect();
      }
    });

    client.on('error', (e) => {
      if (S.connState === 'connecting') {
        this.setState('disconnected');
        Log.sys('✗ 连接失败');
        Toast.error('连接失败，正在自动重连...');
      }
      if (!S.reconnecting) this._scheduleReconnect();
    });

    client.on('offline', () => {
      if (S.connState === 'connected') { this.setState('degraded'); }
    });
  },

  _scheduleReconnect() {
    if (S.reconnecting) return;
    S.reconnecting = true;
    S.reconnectAttempt++;
    const maxRetries = CFG.RECONNECT_DELAYS.length;
    // 超过最大重试次数 → 放弃，显示手动重试按钮
    if (S.reconnectAttempt > maxRetries) {
      S.reconnecting = false;
      this.setState('disconnected');
      Log.sys('✗ 连接失败：重试' + maxRetries + '次均未成功');
      const retry = el('retry-conn');
      if (retry) retry.classList.remove('hidden');
      return;
    }
    const delay = CFG.RECONNECT_DELAYS[S.reconnectAttempt - 1];
    this.setState('reconnecting');
    Log.sys('⟳ ' + (delay/1000).toFixed(1) + 's 后重连...');
    Toast.info('正在重连... (' + S.reconnectAttempt + '/' + maxRetries + ')');
    S.reconnectTimer = setTimeout(() => {
      if (S.roomId) this.connect(S.roomId);
    }, delay);
  },

  publish(msg) {
    if (S.client && S.connState === 'connected') {
      S.client.publish('wt/' + S.roomId + '/msg', JSON.stringify(msg));
    }
  },

  disconnect() {
    S.reconnecting = false;
    if (S.reconnectTimer) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; }
    if (S.client) { try { S.client.end(true); } catch(e) {}; S.client = null; }
    this.setState('disconnected');
  },
};

// ============================================================
// MODULE 8: 消息处理
// ============================================================
const MsgHandler = {
  handle(topic, data) {
    if (!data || !data.t) return;
    // 心跳：收到对方任何带昵称的消息即认为对方在线（用于对方直接关页不触发 leave 的离线检测）
    if (data.name && data.name !== S.nickname) S.lastPeerSeen = Date.now();
    switch (data.t) {
      case 'join': this._onJoin(data); break;
      case 'leave': this._onLeave(data); break;
      case 'hello': this._onHello(data); break;
      case 'play': this._onPlay(data); break;
      case 'pause': this._onPause(data); break;
      case 'seek': this._onSeek(data); break;
      case 'seek-ack': this._onSeekAck(data); break;
      case 'video-url': this._onVideoUrl(data); break;
      case 'chat': this._onChat(data); break;
      case 'speed': this._onSpeed(data); break;
      case 'sync-req': this._onSyncReq(); break;
      case 'sync-ack': this._onSyncAck(data); break;
      case 'ping': this._onPing(data); break;
      case 'pong': this._onPong(data); break;
    }
  },

  _onJoin(data) {
    S.peerOnline = true;
    S.peerName = data.name || '朋友';
    const pp = el('peer-presence'), pn = el('peer-name');
    if (pp) pp.classList.remove('hidden');
    if (pn) pn.textContent = S.peerName;
    Log.sys(S.peerName + ' 加入了房间');
    Toast.info('👋 ' + S.peerName + ' 加入了房间');
    Member.render();
    MQTT.publish({ t: 'hello', name: S.nickname });
    if (S.videoUrl) this._sendState();
    this._updateOnlineStatus();
  },

  _onHello(data) {
    S.peerOnline = true;
    S.peerName = data.name || S.peerName || '朋友';
    const pp = el('peer-presence'), pn = el('peer-name');
    if (pp) pp.classList.remove('hidden');
    if (pn) pn.textContent = S.peerName;
    Member.render();
    this._updateOnlineStatus();
  },

  // 心跳协议：对方 ping → 回 pong；收到任何对方消息都会刷新 lastPeerSeen
  _onPing(data) {
    S.peerOnline = true;
    if (data.name && data.name !== S.nickname) {
      MQTT.publish({ t: 'pong', name: S.nickname });
    }
    this._updateOnlineStatus();
  },
  _onPong() {
    S.peerOnline = true;
    this._updateOnlineStatus();
  },

  _onLeave(data) {
    const name = data.name || S.peerName || '朋友';
    S.peerOnline = false;
    const pp = el('peer-presence'); if (pp) pp.classList.add('hidden');
    Log.sys(name + ' 离开了房间');
    Toast.warn('🚪 ' + name + ' 离开了房间');
    Member.render();
    this._updateOnlineStatus();
  },

  _updateOnlineStatus() {
    const count = el('online-count');
    const dot = el('peer-dot');
    if (count) {
      count.textContent = S.peerOnline ? '👥 2 人在线' : '👤 1 人在线';
    }
    if (dot) {
      dot.classList.toggle('solo', !S.peerOnline);
    }
  },

  _onPlay(data) {
    S.peerOnline = true;
    S.peerPlaying = true;
    // B站 iframe 模式：走 postMessage 统一接口
    if (Player._mode !== 'video') {
      const cur = Player.getCurrentTime();
      if (Date.now() - S.lastSyncRx < 2000 && Math.abs(cur - (data.time || 0)) < 2) return;
      S.lastSyncRx = Date.now();
      S.isSyncing = true;
      const target = Math.max(cur, data.time || 0);
      if (Math.abs(cur - target) > 0.5) Player.seek(target);
      Player.play();
      Toast.info('▶ ' + (data.name || S.peerName) + ' 播放');
      setTimeout(() => { S.isSyncing = false; }, 150);
      return;
    }
    const v = el('player');
    if (!v.duration) return;
    // 2秒内忽略重复同步，避免回声和频繁seek
    if (Date.now() - S.lastSyncRx < 2000 && Math.abs(v.currentTime - (data.time || 0)) < 2) return;
    S.lastSyncRx = Date.now();
    S.isSyncing = true;
    // 只跟进不后退：取本地和远端中更晚的时间
    const target = Math.max(v.currentTime, data.time || 0);
    if (Math.abs(v.currentTime - target) > 0.5) v.currentTime = target;
    v.play().catch(() => {});
    Toast.info('▶ ' + (data.name || S.peerName) + ' 播放');
    setTimeout(() => { S.isSyncing = false; }, 150);
  },

  _onPause(data) {
    S.peerOnline = true;
    S.peerPlaying = false;
    if (Player._mode !== 'video') {
      const cur = Player.getCurrentTime();
      if (Date.now() - S.lastSyncRx < 2000 && Math.abs(cur - (data.time || 0)) < 2) return;
      S.lastSyncRx = Date.now();
      S.isSyncing = true;
      const target = Math.max(cur, data.time || 0);
      if (Math.abs(cur - target) > 0.5) Player.seek(target);
      Player.pause();
      Toast.info('⏸ ' + (data.name || S.peerName) + ' 暂停');
      setTimeout(() => { S.isSyncing = false; }, 150);
      return;
    }
    const v = el('player');
    if (!v.duration) return;
    if (Date.now() - S.lastSyncRx < 2000 && Math.abs(v.currentTime - (data.time || 0)) < 2) return;
    S.lastSyncRx = Date.now();
    S.isSyncing = true;
    // 只跟进不后退
    const target = Math.max(v.currentTime, data.time || 0);
    if (Math.abs(v.currentTime - target) > 0.5) v.currentTime = target;
    v.pause();
    Toast.info('⏸ ' + (data.name || S.peerName) + ' 暂停');
    setTimeout(() => { S.isSyncing = false; }, 150);
  },

  _onSeek(data) {
    S.peerOnline = true;
    S.peerPlaying = data.peerPlaying !== false;
    // B站 iframe 模式：即时跟随跳转（iframe 内拖拽本身是即时的）
    if (Player._mode !== 'video') {
      const target = data.time || 0;
      const cur = Player.getCurrentTime();
      S.isSyncing = true;
      if (Math.abs(cur - target) <= 1) {
        if (S.peerPlaying) Player.play(); else Player.pause();
        setTimeout(() => { S.isSyncing = false; }, 150);
        return;
      }
      Player.seek(target);
      if (S.peerPlaying) Player.play(); else Player.pause();
      setTimeout(() => { S.isSyncing = false; }, 150);
      return;
    }
    const v = el('player');
    if (!v.duration) return;
    S.isSyncing = true;
    const target = data.time || 0;

    if (data.sync) {
      // 同步模式：对方拖进度条 → seek 到位置后暂停，等待对方统一播放
      S.lastSyncRx = 0;  // 清除防抖，让后续 play 消息能通过
      v.currentTime = target;
      Toast.info('⏩ ' + (data.name || S.peerName) + ' 拖到 ' + fmtTime(target));
      v.addEventListener('seeked', function f() {
        v.removeEventListener('seeked', f);
        v.pause();
        MQTT.publish({ t: 'seek-ack', time: v.currentTime });
        S.isSyncing = false;
      }, { once: true });
    } else {
      // 精确跟随（允许后退）
      if (Math.abs(v.currentTime - target) <= 0.5) {
        if (S.peerPlaying) v.play().catch(() => {});
        else v.pause();
        S.isSyncing = false;
        return;
      }
      v.currentTime = target;
      const to = fmtTime(target);
      Toast.info('⏩ ' + (data.name || S.peerName) + ' 跳转到 ' + to);
      v.addEventListener('seeked', function f() {
        v.removeEventListener('seeked', f);
        if (S.peerPlaying) v.play().catch(() => {});
        else v.pause();
      }, { once: true });
      setTimeout(() => { S.isSyncing = false; }, 600);
    }
  },

  _onSeekAck(data) {
    // 对方已加载到目标位置 → 双方统一播放
    if (!S.seekWaitAck) return;
    S.seekWaitAck = false;
    if (S._seekAckTimer) { clearTimeout(S._seekAckTimer); S._seekAckTimer = null; }
    if (Player._mode !== 'video') {
      if (data.time != null) Player.seek(data.time);
      Player.play();
      MQTT.publish({ t: 'play', time: Player.getCurrentTime(), name: S.nickname });
      Toast.info('✅ 同步播放');
      return;
    }
    const v = el('player');
    if (data.time != null) v.currentTime = data.time;
    S.isSyncing = true;  // 防止 play 事件重复发送
    v.play().catch(() => {});
    MQTT.publish({ t: 'play', time: v.currentTime, name: S.nickname });
    Toast.info('✅ 同步播放');
    setTimeout(() => { S.isSyncing = false; }, 200);
  },

  _updateSpeedUI(rate) {
    if (!rate) return;
    S.playbackSpeed = rate;
    const v = el('player'); if (v) v.playbackRate = rate;
    $$('.speed-opt').forEach(o => o.classList.toggle('active', parseFloat(o.dataset.speed) === rate));
  },

  _onVideoUrl(data) {
    S.peerOnline = true;
    // 空 URL 表示停止播放 → 清空视频
    if (data.url === '' || data.url === null) {
      Player.clear(); S.videoUrl = ''; S.videoType = '';
      return;
    }
    if (!data.url || S.videoUrl === data.url) return;
    // B站：通过 iframe 加载（纯同步，无需后端）
    if (data.type === 'bili' && data.url.indexOf('bili:') === 0) {
      const m = data.url.match(/bili:(BV[A-Za-z0-9]+)(?:\?p=(\d+))?/);
      if (m) {
        S.videoUrl = data.url;
        S.videoType = 'bili';
        Player.embedBili(m[1], m[2] ? parseInt(m[2], 10) : 1);
        S.videoTitle = data.videoTitle || S.videoTitle || 'B站视频';
        return;
      }
    }
    // YouTube：走 iframe + postMessage（yt: 前缀不能交给 Player.load）
    if (data.url.indexOf('yt:') === 0) {
      const ytVid = data.url.match(/yt:([\w-]+)/);
      S.videoUrl = data.url;
      S.videoType = 'youtube';
      if (ytVid) Player.embedYouTube(ytVid[1]);
      S.videoTitle = data.videoTitle || S.videoTitle || 'YouTube';
      return;
    }
    S.videoUrl = data.url;
    S.videoType = data.type || 'direct';
    Player.load(data.url, true);
    // 同步速度
    if (data.speed) this._updateSpeedUI(data.speed);
    // 新视频：等 loadedmetadata 触发后同步时间
    const v = el('player');
    const syncTime = () => {
      v.removeEventListener('loadedmetadata', syncTime);
      if (data.time != null) {
        // 新视频：取远端时间，不后退
        v.currentTime = Math.max(v.currentTime, data.time);
        if (data.peerPlaying) v.play().catch(() => {});
        else v.pause();
      }
    };
    v.addEventListener('loadedmetadata', syncTime);
  },

  _onChat(data) {
    // 聊天面板未激活时才累计未读并显示徽标
    if (S.chatHidden) {
      S.unreadChat++;
      this._updateChatBadge();
    }
    Log.chat(data.name||'朋友', data.text||'', false);
    // Floating emoji reaction for single-emoji messages
    if (data.text && /^[\u{1F300}-\u{1FAFF}😀-🙏🌀-🗿]$/u.test(data.text.trim())) {
      this._floatEmoji(data.text.trim());
    }
  },

  // 未读聊天徽标：移动端 chat tab + 桌面端聊天标题
  _updateChatBadge() {
    const n = S.unreadChat || 0;
    const setBadge = (host) => {
      if (!host) return;
      let b = host.querySelector('.tab-badge');
      if (n > 0) {
        if (!b) { b = document.createElement('span'); b.className = 'tab-badge'; host.appendChild(b); }
        b.textContent = n > 99 ? '99+' : n;
      } else if (b) { b.remove(); }
    };
    $$('#mobile-panel-tabs .mpt-tab[data-mpt="chat"]').forEach(tab => setBadge(tab));
    const title = $('#pnl-chat .pnl-sec-title');
    if (title) setBadge(title);
  },

  _floatEmoji(emoji) {
    const stage = el('video-stage');
    if (!stage) return;
    const span = document.createElement('span');
    span.textContent = emoji;
    span.style.cssText = 'position:absolute;bottom:20%;left:'+ (30 + Math.random()*40) +'%;font-size:40px;pointer-events:none;z-index:20;animation:floatUp 1.8s ease-out forwards';
    stage.appendChild(span);
    setTimeout(() => span.remove(), 2000);
  },

  _onSpeed(data) {
    S.peerOnline = true;
    this._updateSpeedUI(data.rate);
  },

  _onSyncReq() {
    S.peerOnline = true;
    if (!S.videoUrl) return;
    this._sendState();
  },

  _onSyncAck(data) {
    S.peerOnline = true;
    // 显示对方在看什么
    if (data.videoTitle) {
      const pv = el('peer-video'); if (pv) pv.textContent = '📺 ' + data.videoTitle;
    }
    // 远端在播放 B站 → 用 iframe 加载（bili: 前缀不能走 Player.load）
    if (data.videoUrl && data.videoUrl !== S.videoUrl) {
      if (data.type === 'bili' && data.videoUrl.indexOf('bili:') === 0) {
        const m = data.videoUrl.match(/bili:(BV[A-Za-z0-9]+)(?:\?p=(\d+))?/);
        if (m) {
          const page = m[2] ? parseInt(m[2], 10) : 1;
          S.videoUrl = data.videoUrl;
          S.videoType = 'bili';
          Player.embedBili(m[1], page);
          S.episodes = [{ label: 'B站', bv: m[1], page: page }];
          S.currentEpisode = 0;
          S.episodeSource = 'bili';
          const peerTitle = (data.videoTitle || '').replace(/^\d+:\d+\s*/, '');
          if (peerTitle) S.videoTitle = peerTitle;
        }
      } else if (data.videoUrl.indexOf('yt:') === 0) {
        // YouTube：iframe + postMessage 同步加载（yt: 前缀不能走 Player.load）
        const ytVid = data.videoUrl.match(/yt:([\w-]+)/);
        S.videoUrl = data.videoUrl;
        S.videoType = 'youtube';
        if (ytVid) Player.embedYouTube(ytVid[1]);
      } else {
        S.videoUrl = data.videoUrl; S.videoType = data.type || 'direct';
        Player.load(data.videoUrl, true);
      }
    }
    if (data.peerPlaying !== undefined) S.peerPlaying = data.peerPlaying;
    // 速度同步
    if (data.speed && data.speed !== S.playbackSpeed) this._updateSpeedUI(data.speed);
    // 进度漂移校准 (只往前跟, 不往后拉)
    if (data.time == null || S.isSyncing) return;
    if (Date.now() - S.lastSyncRx < 1500) return;
    S.lastSyncRx = Date.now();
    // 拖动进度条: 10s 保护；播放/暂停: 3s 保护
    const guard = (Date.now() - S.lastManualSeek < 10000) || (Date.now() - S.lastLocalAction < 3000);
    if (guard) return;
    if (Player._mode !== 'video') {
      const cur = Player.getCurrentTime() || 0;
      const ahead = Math.max(cur, data.time);
      if (ahead - cur > 1.5) Player.seek(ahead);
      if (data.peerPlaying) Player.play(); else Player.pause();
      return;
    }
    const v = el('player');
    if (!v || !v.duration) return;
    const ahead = Math.max(v.currentTime, data.time);
    if (ahead - v.currentTime > 1.5) {
      S.isSyncing = true;
      v.currentTime = ahead;
      if (data.peerPlaying) v.play().catch(() => {});
      else v.pause();
      setTimeout(() => { S.isSyncing = false; }, 400);
    }
  },

  _sendState() {
    const v = el('player');
    let time = 0, playing = false, title = '';
    if (Player._mode !== 'video') {
      // iframe（B站/YouTube）：用 postMessage 回传的进度/播放态（video 元素是隐藏的）
      time = Player.getCurrentTime() || 0;
      playing = !Player.isPaused();
      title = S.videoTitle || (Player._mode === 'bili' ? 'B站视频' : 'YouTube');
    } else if (v && v.duration) {
      time = v.currentTime;
      playing = !v.paused;
      title = (S.episodes && S.episodes.length ? (S.episodes[S.currentEpisode]||{}).label || '' : '');
    }
    MQTT.publish({
      t: 'sync-ack',
      videoUrl: S.videoUrl, type: S.videoType,
      time: time,
      peerPlaying: playing,
      speed: S.playbackSpeed,
      videoTitle: title ? (fmtTime(time) + ' ' + title) : '',
    });
  },
};

// ============================================================
// MODULE 9: 同步调度
// ============================================================
const Sync = {
  _timer: null,
  send(type, extra = {}) {
    if (S.isSyncing) return;
    clearTimeout(this._timer);
    // seek 立即发送，play/pause 50ms 防抖
    const delay = type === 'seek' ? 0 : 50;
    this._timer = setTimeout(() => {
      MQTT.publish({ t: type, ...extra });
    }, delay);
  },
};

// ============================================================
// MODULE 10: 视频播放器
// ============================================================
const Player = {

  load(url, fromPeer = false) {
    this.cleanup();
    S.hlsRetryDone = false;
    // 切换视频时清掉上一轮的 seek-ack 等待状态，防止旧计时器误触
    S.seekWaitAck = false;
    if (S._seekAckTimer) { clearTimeout(S._seekAckTimer); S._seekAckTimer = null; }
    if (!fromPeer) S.videoUrl = url;

    const v = el('player'), pl = el('placeholder'), clr = el('clear-btn');
    const fs = el('fullscreen-btn'), vc = el('vid-controls'), eo = el('video-err-overlay');
    if (pl) pl.style.display = 'none';
    v.style.display = 'block';
    if (clr) clr.classList.remove('hidden');
    if (fs) fs.classList.remove('hidden');
    if (vc) vc.classList.remove('hidden');
    if (eo) eo.classList.add('hidden');
    this._resetSeek();
    v.playbackRate = S.playbackSpeed;

    if (!fromPeer) this._showLoad('加载中...');

    const isHLS = url.includes('m3u8');
    if (isHLS && typeof Hls !== 'undefined' && Hls.isSupported()) {
      this._loadHLS(url, fromPeer);
    } else {
      this._loadDirect(url, fromPeer);
    }
  },

  _loadHLS(url, fromPeer) {
    S.videoType = 'hls';
    const hls = new Hls({ enableWorker: false, lowLatencyMode: true });
    S.hlsInstance = hls;
    const v = el('player');

    // 先 attach，后 load（避免 video 元素未就绪）
    hls.attachMedia(v);
    hls.loadSource(url);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      // manifest 解析完毕：尝试自动播放（不隐藏 loading，等首帧渲染）
      if (!fromPeer || S.peerPlaying) {
        v.play().catch(() => {});
      }
    });

    hls.on(Hls.Events.ERROR, (evt, data) => {
      if (!data.fatal) return;
      hls.destroy(); S.hlsInstance = null;
      this._hideLoad();

      // SSL 证书过期 → 代理重试一次
      if (!S.hlsRetryDone && (data.type === Hls.ErrorTypes.NETWORK_ERROR)) {
        S.hlsRetryDone = true;
        this._showLoad('重试中...');
        Net.fetch(getProxy() + encodeURIComponent(url), 12000)
          .then(r => r.text())
          .then(m3u8 => {
            const base = url.substring(0, url.lastIndexOf('/') + 1);
            const rewritten = m3u8.replace(/^([^#\s].+)$/gm, (line) => {
              if (line.startsWith('http')) return getProxy() + encodeURIComponent(line);
              return getProxy() + encodeURIComponent(base + line);
            });
            const blob = new Blob([rewritten], { type: 'application/vnd.apple.mpegurl' });
            const blobUrl = URL.createObjectURL(blob);
            S._blobUrls = S._blobUrls || [];
            S._blobUrls.push(blobUrl);
            this._loadHLS(blobUrl, fromPeer);
          })
          .catch(() => { this._hideLoad(); Toast.warn('代理重试失败，换个片源试试'); });
      } else {
        this._hideLoad();
        Toast.warn('播放失败，换个片源试试');
      }
    });
  },

  _loadDirect(url, fromPeer) {
    S.videoType = 'direct';
    const v = el('player');
    v.src = url;
    // canplay 才隐藏 loading（不依赖 loadedmetadata，那个可能很慢）
    const onReady = () => {
      v.removeEventListener('canplay', onReady);
      this._hideLoad();
      if (!fromPeer || S.peerPlaying) {
        v.play().catch(e => { if (e.name === 'NotAllowedError') Toast.warn('请点击播放'); });
      }
    };
    v.addEventListener('canplay', onReady);
  },

  cleanup() {
    // iframe（B站/YouTube）：注销消息监听 + 清理定时器 + 移除 iframe
    window.removeEventListener('message', Player._onFrameMsg);
    if (Player._frameTimer) { clearInterval(Player._frameTimer); Player._frameTimer = null; }
    if (Player._frame) { Player._frame.remove(); Player._frame = null; }
    Player._mode = 'video';
    Player._biliPaused = true;
    Player._ytPaused = true;
    Player._biliTime = 0;
    Player._ytTime = 0;
    if (S.hlsInstance) { try { S.hlsInstance.destroy(); } catch(e) {} S.hlsInstance = null; }
    // 清理 SSL 重试产生的 blob URL
    if (S._blobUrls) { S._blobUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch(e) {} }); S._blobUrls = []; }
    const v = el('player');
    v.pause();
    v.removeAttribute('src');
    v.style.display = 'block';
    this._hideLoad();
    const vc = el('vid-controls'); if (vc) { vc.classList.add('hidden'); vc.classList.remove('bili-mode'); vc.classList.remove('yt-mode'); }
    $$('.embed-frame').forEach(f => f.remove());
  },

  clear() {
    this.cleanup();
    S.videoUrl = null; S.videoType = null;
    S.videoTitle = '';
    S.episodes = []; S.currentEpisode = 0; S.episodeSource = '';
    S.peerPlaying = true;
    const v = el('player'), pl = el('placeholder'), clr = el('clear-btn');
    const ep = el('ep-list'), vc = el('vid-controls');
    v.style.display = 'none';
    if (pl) pl.style.display = '';
    if (clr) clr.classList.add('hidden');
    if (ep) { ep.classList.add('hidden'); ep.innerHTML = ''; }
    if (vc) vc.classList.add('hidden');
  },

  _showLoad(msg) {
    const lo = el('load-overlay'), lt = el('load-txt');
    if (lo) lo.classList.remove('hidden');
    if (lt) lt.textContent = msg || '加载中...';
  },
  _hideLoad() {
    const lo = el('load-overlay'); if (lo) lo.classList.add('hidden');
  },
  _resetSeek() {
    const sb = el('vid-seek'), vc = el('vid-cur'), vd = el('vid-dur');
    if (sb) { sb.value = 0; sb.style.background = ''; }
    if (vc) vc.textContent = '0:00';
    if (vd) vd.textContent = '0:00';
  },

  // ====== B站 iframe (postMessage 同步，零后端) ======
  embedBili(bv, page) {
    this.cleanup();
    Player._mode = 'bili';
    Player._frameReady = false;
    Player._biliPaused = true;
    Player._biliTime = 0;
    Player._ytPaused = true;
    Player._ytTime = 0;
    const v = el('player'), pl = el('placeholder');
    if (v) v.style.display = 'none';
    if (pl) pl.style.display = 'none';
    const iframe = document.createElement('iframe');
    iframe.className = 'embed-frame';
    const pg = (page && page > 1) ? '&page=' + page : '';
    iframe.src = 'https://player.bilibili.com/player.html?bvid=' + bv + pg +
      '&high_quality=1&danmaku=0&as_wide=1&autoplay=0';
    iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
    iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;z-index:5;background:#000';
    iframe.addEventListener('load', () => {
      Player._frameReady = true;
      Player._framePost({ command: 'getCurrentTime' });
    });
    window.removeEventListener('message', Player._onFrameMsg);
    window.addEventListener('message', Player._onFrameMsg);
    el('video-stage').appendChild(iframe);
    Player._frame = iframe;
    S.videoUrl = 'bili:' + bv + (page > 1 ? '?p=' + page : '');
    S.videoType = 'bili';
    const vc = el('vid-controls');
    if (vc) { vc.classList.remove('hidden'); vc.classList.add('bili-mode'); }
    this._hideLoad();
    // 周期请求时间回传（兜底：部分情况下 B站不主动推送进度）
    Player._frameTimer = setInterval(() => {
      if (Player._mode === 'bili') Player._framePost({ command: 'getCurrentTime' });
    }, 3000);
  },

  // ====== YouTube iframe (postMessage 同步，enablejsapi) ======
  embedYouTube(vid) {
    this.cleanup();
    Player._mode = 'yt';
    Player._frameReady = false;
    Player._ytPaused = true;
    Player._ytTime = 0;
    const v = el('player'), pl = el('placeholder');
    if (v) v.style.display = 'none';
    if (pl) pl.style.display = 'none';
    const iframe = document.createElement('iframe');
    iframe.className = 'embed-frame';
    const origin = encodeURIComponent(window.location.origin || '');
    iframe.src = 'https://www.youtube.com/embed/' + vid + '?enablejsapi=1&autoplay=0&rel=0&playsinline=1&origin=' + origin;
    iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
    iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;z-index:5;background:#000';
    iframe.addEventListener('load', () => {
      Player._frameReady = true;
      Player._framePost({ func: 'getCurrentTime' });
    });
    window.removeEventListener('message', Player._onFrameMsg);
    window.addEventListener('message', Player._onFrameMsg);
    el('video-stage').appendChild(iframe);
    Player._frame = iframe;
    S.videoUrl = 'yt:' + vid;
    S.videoType = 'youtube';
    const vc = el('vid-controls');
    if (vc) { vc.classList.remove('hidden'); vc.classList.add('yt-mode'); }
    this._hideLoad();
    // 周期请求时间回传（兜底：部分情况下 YT 不主动推送进度）
    Player._frameTimer = setInterval(() => {
      if (Player._mode === 'yt') Player._framePost({ func: 'getCurrentTime' });
    }, 3000);
  },

  // ---- 统一播放控制（video / iframe 共用，MsgHandler 调用）----
  play() {
    if (this._mode === 'bili' && this._frame) { this._framePost({ command: 'play' }); this._biliPaused = false; }
    else if (this._mode === 'yt' && this._frame) { this._framePost({ func: 'playVideo' }); this._ytPaused = false; }
    else { const v = el('player'); if (v) v.play().catch(() => {}); }
  },
  pause() {
    if (this._mode === 'bili' && this._frame) { this._framePost({ command: 'pause' }); this._biliPaused = true; }
    else if (this._mode === 'yt' && this._frame) { this._framePost({ func: 'pauseVideo' }); this._ytPaused = true; }
    else { const v = el('player'); if (v) v.pause(); }
  },
  seek(t) {
    if (this._mode === 'bili' && this._frame) { this._framePost({ command: 'seek', arg: Math.floor(t) }); this._biliTime = t; }
    else if (this._mode === 'yt' && this._frame) { this._framePost({ func: 'seekTo', args: [t, true] }); this._ytTime = t; }
    else { const v = el('player'); if (v) v.currentTime = t; }
  },
  getCurrentTime() {
    if (this._mode === 'bili') return this._biliTime;
    if (this._mode === 'yt') return this._ytTime;
    const v = el('player'); return v ? v.currentTime : 0;
  },
  isPaused() {
    if (this._mode === 'bili') return this._biliPaused;
    if (this._mode === 'yt') return this._ytPaused;
    const v = el('player'); return v ? v.paused : true;
  },
  _framePost(msg) {
    if (this._frame && this._frame.contentWindow) {
      try {
        if (this._mode === 'yt') {
          this._frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: msg.func, args: msg.args || [] }), '*');
        } else {
          this._frame.contentWindow.postMessage(JSON.stringify(msg), '*');
        }
      } catch (e) {}
    }
  },
  // window message 监听：捕获 iframe（B站/YouTube）回传的播放状态
  _onFrameMsg(e) {
    if (Player._mode === 'video') return;
    let d;
    try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (_) { return; }
    if (!d) return;
    if (Player._mode === 'bili') {
      // 只接受 B站播放器 iframe 的消息，忽略其它窗口（防伪造/串台）
      if (e.origin && e.origin !== 'https://player.bilibili.com') return;
      if (d.from !== 'bilibili') return;
      if (d.title) S.videoTitle = d.title;
      const t = d.currentTime != null ? d.currentTime
        : (d.time != null ? d.time
        : (d.data && d.data.currentTime != null ? d.data.currentTime : null));
      if (t != null) Player._biliTime = t;
      const cmd = d.command || d.event;
      if (cmd === 'ready') {
        Player._frameReady = true;
      } else if (cmd === 'play' || cmd === 'playing' || cmd === 'video_play') {
        Player._biliPaused = false;
        if (!S.isSyncing) Sync.send('play', { time: Player._biliTime, name: S.nickname });
      } else if (cmd === 'pause' || cmd === 'video_pause') {
        Player._biliPaused = true;
        if (!S.isSyncing) Sync.send('pause', { time: Player._biliTime, name: S.nickname });
      } else if (cmd === 'seek' || cmd === 'video_seek') {
        // 对方在 iframe 内拖动进度条 → 我方即时跟随跳转
        if (!S.isSyncing) Sync.send('seek', { time: Player._biliTime, name: S.nickname, peerPlaying: !Player._biliPaused });
      }
      return;
    }
    // YouTube：enablejsapi=1 时回传 onReady / onStateChange / infoDelivery
    if (e.origin && e.origin !== 'https://www.youtube.com' && e.origin !== 'https://www.youtube-nocookie.com') return;
    if (d.event === 'onReady') {
      Player._frameReady = true;
      Player._framePost({ func: 'getCurrentTime' });
    } else if (d.event === 'onStateChange' && d.info) {
      const st = d.info.playerState;
      if (st === 1) {
        Player._ytPaused = false;
        if (!S.isSyncing) Sync.send('play', { time: Player._ytTime, name: S.nickname });
      } else if (st === 2) {
        Player._ytPaused = true;
        if (!S.isSyncing) Sync.send('pause', { time: Player._ytTime, name: S.nickname });
      }
    } else if (d.event === 'infoDelivery' && d.info) {
      if (d.info.currentTime != null) Player._ytTime = d.info.currentTime;
      if (d.info.playerState === 1) Player._ytPaused = false;
      else if (d.info.playerState === 2) Player._ytPaused = true;
    }
  },

  // 嵌入通用 iframe
  embedFrame(src, label) {
    this.cleanup();
    const v = el('player'), pl = el('placeholder');
    v.style.display = 'none';
    if (pl) pl.style.display = 'none';
    const iframe = document.createElement('iframe');
    iframe.className = 'embed-frame';
    iframe.src = src;
    iframe.allow = 'autoplay; fullscreen; encrypted-media';
    iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;z-index:5';
    el('video-stage').appendChild(iframe);
    el('placeholder').style.display = 'none';
    const vc = el('vid-controls'); if (vc) vc.classList.remove('hidden');
    this._hideLoad();
  },
};

// ============================================================
// MODULE 11: 搜索引擎
// ============================================================
const Search = {

  // ---- 链接解析 ----
  parse(input) {
    const kw = input.trim(); if (!kw) return;

    // Direct m3u8/mp4
    if (/^https?:\/\/.+\.(m3u8|mp4)(\?.*)?$/i.test(kw)) {
      return Search.loadPlayPage(kw, 'direct', null);
    }
    // Bilibili 短链 b23.tv：解析重定向后提取 BV 号
    const b23 = kw.match(/b23\.tv\/([A-Za-z0-9]+)/);
    if (b23) return this._resolveB23(b23[1]);
    // Bilibili（完整链接或裸 BV 号）
    const bv = kw.match(/bilibili\.com\/video\/(BV[A-Za-z0-9]+)/) || kw.match(/\b(BV[A-Za-z0-9]+)\b/);
    if (bv) {
      const pMatch = kw.match(/[?&]p=(\d+)/);
      return this._loadBili(bv[1], pMatch ? parseInt(pMatch[1], 10) : 1);
    }
    // YouTube
    const yt = kw.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);
    if (yt) return this._loadYouTube(yt[1]);
    // 抖音
    if (/douyin\.com/.test(kw)) return this._loadDouyin(kw);
    // Other URL — try as direct
    if (/^https?:\/\//.test(kw)) return Search.loadPlayPage(kw, 'direct', null);
    // Search keyword
    this._addHistory(kw);
    this._doSearch(kw);
  },

  _addHistory(kw) {
    if (kw.length < 2) return;
    const hist = JSON.parse(localStorage.getItem('wt_history') || '[]');
    const idx = hist.indexOf(kw);
    if (idx >= 0) hist.splice(idx, 1);
    hist.unshift(kw);
    if (hist.length > 8) hist.pop();
    localStorage.setItem('wt_history', JSON.stringify(hist));
    this._renderHistory();
  },

  _renderHistory() {
    const hist = JSON.parse(localStorage.getItem('wt_history') || '[]');
    const sh = el('search-history');
    if (!sh) return;
    if (!hist.length) { sh.classList.add('hidden'); return; }
    sh.classList.remove('hidden');
    sh.innerHTML = hist.map(k => '<span class="hist-tag" data-kw="' + escapeHtml(String(k)).replace(/"/g, '&quot;') + '">' + escapeHtml(String(k)) + '</span>').join('');
    // Bind clicks
    sh.querySelectorAll('.hist-tag').forEach(t => {
      t.addEventListener('click', () => {
        el('url-input').value = t.dataset.kw;
        Search.parse(t.dataset.kw);
      });
    });
  },

  // ====== Bilibili (iframe + postMessage 同步) ======
  // 注意：B站对公共代理 IP 触发安全风控(HTTP 412)，任何 API 直连解析都不可行。
  // 因此采用官方 iframe 播放器 + postMessage 同步，纯前端、零后端。
  _loadBili(bv, page) {
    Player._showLoad('加载B站视频...');
    Player.embedBili(bv, page || 1);
    S.episodes = [{ label: 'B站', bv: bv, page: page || 1 }];
    S.currentEpisode = 0;
    S.episodeSource = 'bili';
    S.videoTitle = S.videoTitle || 'B站视频';
    Playlist.addToPlaylist(S.videoUrl, '🎬 B站视频', 'bili');
    Toast.info('B站视频已加载 · 与好友同步播放');
    // 通知对方用 iframe 加载同一 B站 视频（类型必须为 bili，否则对方会误走 Player.load）
    MQTT.publish({ t: 'video-url', url: S.videoUrl, type: 'bili', time: 0, peerPlaying: true, speed: S.playbackSpeed });
  },

  // ====== b23.tv 短链解析 ======
  _resolveB23(code) {
    if (/^BV[A-Za-z0-9]{10}$/.test(code)) return this._loadBili(code);
    Player._showLoad('解析 b23.tv 短链...');
    Net.proxyGet('https://b23.tv/' + code, 12000)
      .then(text => {
        const m = String(text || '').match(/BV[A-Za-z0-9]{10}/);
        if (m) {
          this._loadBili(m[0]);
        } else {
          Player._hideLoad();
          Toast.warn('b23.tv 解析失败，请粘贴完整 bilibili.com/video/BVxxx 链接');
        }
      })
      .catch(() => {
        Player._hideLoad();
        Toast.warn('b23.tv 解析失败，请粘贴完整 bilibili.com/video/BVxxx 链接');
      });
  },

  // ====== YouTube（iframe + postMessage 同步，与 B站方案一致）======
  _loadYouTube(vid) {
    Player.embedYouTube(vid);
    S.videoUrl = 'yt:' + vid;
    S.videoType = 'youtube';
    S.videoTitle = S.videoTitle || 'YouTube';
    Playlist.addToPlaylist('yt:'+vid, '🎬 YouTube', 'youtube');
    Toast.info('YouTube 已加载 · 与好友同步播放');
    // 通知对方嵌入同一 YouTube 视频（类型必须为 youtube，否则对方会误走 Player.load）
    MQTT.publish({ t: 'video-url', url: S.videoUrl, type: 'youtube', time: 0, peerPlaying: true, speed: S.playbackSpeed });
  },

  // ====== 抖音 ======
  _loadDouyin(url) {
    Player._showLoad('解析抖音...');
    const vid = url.match(/video\/(\d+)/);
    const api = vid ? 'https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=' + vid[1] : url;
    Net.proxyGet(api, 10000)
      .then(text => {
        const data = safeJSON(text);
        let videoUrl = '';
        if (data?.item_list?.[0]?.video?.play_addr?.url_list?.[0]) {
          videoUrl = data.item_list[0].video.play_addr.url_list[0].replace('playwm', 'play');
        }
        if (videoUrl) {
          Player.load(videoUrl);
          Playlist.addToPlaylist(videoUrl, '🎵 抖音', 'douyin');
        } else {
          this._embedDouyinFallback(url, vid && vid[1]);
        }
      }).catch(() => { this._embedDouyinFallback(url, vid && vid[1]); });
  },

  // 抖音直链解析失败 → 退回分享页 iframe（可能被站点反嵌限制，尽力而为）
  _embedDouyinFallback(url, id) {
    Player._hideLoad();
    const embedSrc = id ? 'https://www.iesdouyin.com/share/video/' + id : url;
    Player.embedFrame(embedSrc, '抖音');
    Toast.warn('抖音直链解析失败，已尝试嵌入分享页（可能受限）');
  },

  // ---- 多源搜索 ----
  _doSearch(kw) {
    const sr = el('search-res'), se = el('search-empty'), sk = el('search-sk');
    if (!sr) return;
    sr.classList.add('hidden'); sr.innerHTML = '';
    if (se) se.classList.add('hidden');
    if (sk) sk.classList.remove('hidden');

    const self = this;
    const results = [];
    let done = 0;

    function checkDone() {
      if (done < CFG.SEARCH_SOURCES.length) return;
      if (sk) sk.classList.add('hidden');
      if (results.length) {
        results.sort((a, b) => Search._matchScore(kw, b.title) - Search._matchScore(kw, a.title));
        sr.classList.remove('hidden');
        if (se) se.classList.add('hidden');
        self._renderResults(results);
      } else {
        sr.classList.add('hidden');
        if (se) se.classList.remove('hidden');
      }
    }

    // 多源 CMS API 并行搜索
    CFG.SEARCH_SOURCES.forEach((src) => {
      self._searchCMS(kw, src, (items) => {
        done++;
        if (items) items.forEach(it => { it.source = src.name; results.push(it); });
        checkDone();
      });
    });
  },

  // 搜索匹配评分: 精确 100, 前缀 80, 子串 50, 字符都包含 20
  _matchScore(kw, title) {
    if (!kw || !title) return 0;
    const k = kw.toLowerCase().replace(/\s+/g, '');
    const t = title.toLowerCase().replace(/\s+/g, '');
    if (t === k) return 100;
    if (t.startsWith(k)) return 80;
    if (t.includes(k)) return 50;
    // 模糊: 关键词每个字都出现
    let i = 0;
    for (const ch of k) {
      const idx = t.indexOf(ch, i);
      if (idx === -1) return 0;
      i = idx + 1;
    }
    return 20;
  },

  // 苹果CMS v10 标准 API 搜索
  _searchCMS(kw, src, cb) {
    const api = src.api + '?ac=detail&wd=' + encodeURIComponent(kw);
    let tried = 0;
    const proxyUrls = CFG.PROXIES.map(p => p + encodeURIComponent(api));
    function tryFetch() {
      const fetchUrl = tried === 0 ? api : proxyUrls[tried - 1];
      Net.fetch(fetchUrl, 15000)
        .then(r => r.text())
        .then(text => {
          const data = safeJSON(text);
          if (!data && tried < proxyUrls.length) { tried++; return tryFetch(); }
          if (!data || data.code !== 1 || !data.list?.length) { cb(null); return; }
          cb(data.list.filter(v => v.vod_play_url).map(v => ({
            title: v.vod_name || '未知',
            url: v.vod_play_url,
            remarks: v.vod_remarks || (v.vod_year || ''),
            cms: true,
          })));
        })
        .catch(() => {
          if (tried < proxyUrls.length) { tried++; tryFetch(); }
          else cb(null);
        });
    }
    tryFetch();
  },

  _renderResults(items) {
    const sr = el('search-res');
    if (!sr) return;
    // 远端 CMS 数据不可信：文本用 escapeHtml，属性值额外转义双引号
    const esc = (s) => escapeHtml(String(s == null ? '' : s));
    const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
    sr.innerHTML = items.map((it, i) => {
      const srcBadge =
        it.source === 'lziapi' ? '<span class="s-badge s-lziapi">🟢 量子</span>' :
        it.source === 'ffzy' ? '<span class="s-badge s-ffzy">🔵 非凡</span>' :
        it.source === 'mdzy' ? '<span class="s-badge s-mdzy">🟣 魔都</span>' :
        it.source === 'dzzy' ? '<span class="s-badge s-dzzy">🟠 大众</span>' : '';
      const safeUrl = escAttr(it.url);
      const safeTitle = escAttr(it.title);
      return '<div class="search-item" data-url="' + safeUrl +
        '"' + (it.cms ? ' data-cms="1"' : '') + ' data-source="' + escAttr(it.source) +
        '" data-title="' + safeTitle + '">' +
        '<span class="s-num">' + (i+1) + '</span>' +
        '<span class="s-info"><span class="s-title">' + esc(it.title) + '</span>' +
        ' <span class="s-remarks">' + esc(it.remarks) + '</span> ' + srcBadge + '</span></div>';
    }).join('');
  },

  // ---- 播放页加载 ----
  loadPlayPage(url, source, cmsData, title) {
    if (title) S.videoTitle = title;
    if (cmsData) {
      // CMS 格式: 第01集$url#第02集$url
      const eps = [];
      url.split('#').forEach(part => {
        const idx = part.indexOf('$');
        if (idx > 0) eps.push({ label: part.substring(0, idx).trim(), url: part.substring(idx + 1).trim() });
        else if (part) eps.push({ label: 'HD', url: part.trim() });
      });
      if (!eps.length) return Toast.error('无法解析片源');
      S.episodes = eps; S.currentEpisode = 0; S.episodeSource = source;
      this.renderEpisodes();
      this.switchEpisode(0);
    } else {
      // Direct URL (m3u8/mp4)
      S.episodes = [{ label: 'HD', url: url }];
      S.currentEpisode = 0; S.episodeSource = 'direct';
      this.renderEpisodes();
      Player.load(url);
      // 通知对方同步加载（Player.load 内部已设置 S.videoType: hls/direct）
      MQTT.publish({ t: 'video-url', url: url, type: S.videoType || 'direct',
        time: el('player').currentTime || 0, peerPlaying: !el('player').paused,
        speed: S.playbackSpeed });
      Playlist.addToPlaylist(url, title || '🔗 直接链接', 'direct');
    }
  },

  renderEpisodes() {
    const html = this._buildEpsHTML();
    const epList = el('ep-list');
    if (epList) { epList.innerHTML = html; epList.classList.remove('hidden'); }
  },

  _buildEpsHTML() {
    if (!S.episodes.length) return '';
    let h = '<div class="ep-header">选集 (' + S.episodes.length + '集)</div><div class="ep-grid">';
    S.episodes.forEach((ep, i) => {
      h += '<span class="ep-item' + (i === S.currentEpisode ? ' ep-active' : '') +
        '" data-idx="' + i + '">' + escapeHtml(String(ep.label || '')) + '</span>';
    });
    return h + '</div>';
  },

  switchEpisode(idx) {
    if (idx < 0 || idx >= S.episodes.length) return;
    S.currentEpisode = idx;
    const ep = S.episodes[idx];
    this.renderEpisodes();

    // B站：切换分P → 重新 embedBili（iframe 模式，纯同步）
    if (S.episodeSource === 'bili' && ep.bv) {
      Player.embedBili(ep.bv, ep.page || 1);
      S.videoUrl = 'bili:' + ep.bv + (ep.page > 1 ? '?p=' + ep.page : '');
      MQTT.publish({ t: 'video-url', url: S.videoUrl, type: 'bili',
        time: 0, peerPlaying: true, speed: S.playbackSpeed });
      const listLabel = '🎬 ' + (S.videoTitle || 'B站视频') + ' · ' + ep.label;
      Playlist.addToPlaylist(S.videoUrl, listLabel, 'bili');
      return;
    }

    // CMS 直链 (m3u8) 或 direct URL — 直接用 HLS.js / video 播放
    Player.load(ep.url);
    S.videoUrl = ep.url;
    MQTT.publish({ t: 'video-url', url: ep.url, type: 'hls',
      time: el('player').currentTime || 0, peerPlaying: !el('player').paused,
      speed: S.playbackSpeed });
    // 播放列表显示: "片名 · 集标签" 或 fallback 到 "集标签"
    const listLabel = S.videoTitle ? '📺 ' + S.videoTitle + ' · ' + ep.label : '📺 ' + ep.label;
    Playlist.addToPlaylist(ep.url, listLabel, S.episodeSource);
  },
};

// ============================================================
// MODULE 12: 播放列表
// ============================================================
const Playlist = {
  items: JSON.parse(localStorage.getItem('wt_playlist') || '[]'),

  // 启动时清理重复项（按主标题去重，保留最新）
  _dedupe() {
    const seen = {};
    const deduped = [];
    for (const it of this.items) {
      const main = (it.label || '').replace(/📺\s*/, '').split(/[·\s]/)[0];
      if (!main) { deduped.push(it); continue; }
      if (!seen[main]) { seen[main] = true; deduped.push(it); }
    }
    if (deduped.length !== this.items.length) {
      this.items = deduped;
      localStorage.setItem('wt_playlist', JSON.stringify(this.items));
    }
  },

  addToPlaylist(url, label, source) {
    // 主标题去重: 提取 "片名" 部分（"赌金·第01集" → "赌金"）
    const mainTitle = (label || '').replace(/📺\s*/, '').split(/[·\s]/)[0];
    const existing = this.items.findIndex(i => {
      const t = (i.label || '').replace(/📺\s*/, '').split(/[·\s]/)[0];
      return mainTitle && t === mainTitle;
    });
    if (existing >= 0) {
      // 同片名：移到顶部 + 更新为最新源（更可靠的 m3u8）
      const [item] = this.items.splice(existing, 1);
      item.url = url; item.label = label; item.source = source; item.time = Date.now();
      this.items.unshift(item);
    } else {
      this.items.unshift({ url, label, source, time: Date.now() });
    }
    // 上限 30 条
    while (this.items.length > 30) this.items.pop();
    localStorage.setItem('wt_playlist', JSON.stringify(this.items));
    this.render();
  },

  render() {
    const pl = el('playlist'), pe = el('playlist-empty');
    if (!pl) return;
    if (!this.items.length) { pl.innerHTML = ''; if (pe) pe.classList.remove('hidden'); return; }
    if (pe) pe.classList.add('hidden');
    pl.innerHTML = this.items.map((it, i) => {
      const esc = (s) => escapeHtml(String(s == null ? '' : s));
      const srcBadge = it.source && it.source !== 'direct' ?
        '<span class="pl-badge">'+esc(it.source)+'</span>' : '';
      const active = S.videoUrl === it.url ? ' active' : '';
      return '<div class="playlist-item' + active + '" data-idx="' + i + '">' +
        '<span class="pl-title">' + esc(it.label || it.url.substring(0,40)) + '</span>' +
        srcBadge + '<span class="pl-del" data-idx="'+i+'">×</span></div>';
    }).join('');
  },

  remove(idx) {
    this.items.splice(idx, 1);
    localStorage.setItem('wt_playlist', JSON.stringify(this.items));
    this.render();
  },

  clearAll() {
    this.items = [];
    localStorage.setItem('wt_playlist', JSON.stringify(this.items));
    this.render();
  },
};

// ============================================================
// MODULE 12.5: 在线成员
// ============================================================
const Member = {
  render() {
    const list = el('member-list');
    if (!list) return;
    list.innerHTML = '';
    const selfItem = document.createElement('div');
    selfItem.className = 'member-item';
    selfItem.innerHTML = '👤 ' + escapeHtml(S.nickname || '我') + ' <span style="color:var(--accent);font-size:10px">(我)</span>';
    list.appendChild(selfItem);
    // 过滤同名/空名
    if (S.peerOnline && S.peerName && S.peerName !== S.nickname) {
      const peerItem = document.createElement('div');
      peerItem.className = 'member-item';
      peerItem.innerHTML = '👤 ' + escapeHtml(S.peerName) + ' <span style="color:var(--success);font-size:10px">● 在线</span>';
      list.appendChild(peerItem);
    }
  },
};

// ============================================================
// MODULE 13: UI 管理器
// ============================================================
const UI = {
  showLobby() { el('lobby').classList.add('active'); el('watch').classList.remove('active');
    S.connState = 'idle'; },

  showWatch() { el('lobby').classList.remove('active'); el('watch').classList.add('active'); },

  toggleTheme() {
    const html = document.documentElement;
    const next = html.dataset.theme === 'dark' ? 'light' : 'dark';
    html.dataset.theme = next;
    localStorage.setItem('wt_theme', next);
  },

  initTheme() {
    const saved = localStorage.getItem('wt_theme') || 'dark';
    document.documentElement.dataset.theme = saved;
  },

  _setTheme(theme) {
    document.documentElement.dataset.theme = theme || 'dark';
  },

  // Mobile panel tab switching (replaces old drawer system)
  _initMobilePanel() {
    const tabs = $$('.mpt-tab');
    if (!tabs.length) return;
    const sections = {
      search: el('pnl-search'),
      chat: el('pnl-chat'),
      list: el('pnl-playlist'),
      members: el('pnl-members'),
    };
    // Activate default tab
    const activate = (tabName) => {
      tabs.forEach(t => t.classList.toggle('active', t.dataset.mpt === tabName));
      Object.keys(sections).forEach(k => {
        if (sections[k]) sections[k].classList.toggle('mpt-active', k === tabName);
      });
      if (tabName === 'chat') {
        S.chatHidden = false; S.unreadChat = 0;
      } else {
        S.chatHidden = true;
      }
      MsgHandler._updateChatBadge();
    };
    tabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        activate(tab.dataset.mpt);
      });
    });
    // Default to search tab
    activate('search');
  },

};

// ============================================================
// MODULE 14: 房间管理
// ============================================================
const Room = {
  create(nick) {
    S.nickname = nick || '用户' + Math.floor(Math.random() * 9000 + 1000);
    localStorage.setItem('wt_nick', S.nickname);
    const roomId = genId();
    window.location.hash = roomId;
    this.enter(roomId);
  },

  join(input) {
    let roomId = input.trim();
    if (!roomId) return Toast.warn('请输入4位房间号');
    // Extract from URL
    const m = roomId.match(/#?(\d{4})$/);
    if (m) roomId = m[1];
    window.location.hash = roomId;
    this.enter(roomId);
  },

  enter(roomId) {
    S.roomId = roomId;
    // 重置房间状态（防上一房间残留）
    S.peerOnline = false;
    S.peerName = '';
    S.peerPlaying = false;
    S.peerVideo = '';
    S.isSyncing = false;
    S.lastSyncRx = 0;
    S.lastPeerSeen = 0;
    UI.showWatch();
    MQTT.connect(roomId);
    UI.initTheme();
    // 初始在线状态
    const count = el('online-count');
    if (count) count.textContent = '👤 1 人在线';
    const dot = el('peer-dot');
    if (dot) dot.classList.add('solo');
    const pp = el('peer-presence');
    if (pp) pp.classList.add('hidden');
    const pv = el('peer-video');
    if (pv) pv.textContent = '';
    // 清空聊天
    const ml = el('msg-list');
    if (ml) ml.innerHTML = '';
    // 清除 seek 同步等待状态
    S.seekWaitAck = false;
    if (S._seekAckTimer) { clearTimeout(S._seekAckTimer); S._seekAckTimer = null; }
    // 清除未读聊天
    S.unreadChat = 0; S.chatHidden = true;
    MsgHandler._updateChatBadge();
    if (window.innerWidth <= 768) UI._initMobilePanel();
    Playlist._dedupe();
    Playlist.render();
    Member.render();
    Search._renderHistory();
  },

  leave() {
    MQTT.publish({ t: 'leave', name: S.nickname });
    MQTT.disconnect();
    Player.clear();
    window.location.hash = '';
    UI.showLobby();
  },

  switchRoom(newRoom) {
    MQTT.publish({ t: 'leave', name: S.nickname });
    MQTT.disconnect();
    Player.clear();
    this.enter(newRoom.trim());
  },
};

// ============================================================
// MODULE 15: 聊天
// ============================================================
const Chat = {
  send(text) {
    if (!text) return;
    Log.chat(S.nickname, text, true);
    MQTT.publish({ t: 'chat', name: S.nickname, text: text });
  },
};

// ============================================================
// MODULE 16: 启动
// ============================================================
function boot() {
  initDOM();

  // Safe event binding — silently skip missing elements
  const on = (id, evt, fn) => { const e = el(id); if (e) e.addEventListener(evt, fn); };

  // ---- Lobby ----
  const nickInput = el('nick-input');
  if (nickInput) {
    const saved = localStorage.getItem('wt_nick') || '用户' + Math.floor(Math.random() * 9000 + 1000);
    nickInput.value = saved; S.nickname = saved;
    el('nick-save').addEventListener('click', () => {
      S.nickname = nickInput.value.trim() || S.nickname;
      localStorage.setItem('wt_nick', S.nickname);
      nickInput.value = S.nickname;
      Toast.info('昵称已保存');
    });
  }
  el('create-btn').addEventListener('click', () => Room.create(nickInput ? nickInput.value.trim() : ''));
  el('join-btn').addEventListener('click', () => Room.join(el('join-input').value));
  el('join-input').addEventListener('keydown', e => { if (e.key === 'Enter') Room.join(el('join-input').value); });

  // ---- Watch Topbar ----
  el('leave-btn').addEventListener('click', () => Room.leave());
  el('change-room-btn').addEventListener('click', () => el('room-switch-overlay').classList.remove('hidden'));
  // Manual retry connection
  const retryBtn = el('retry-conn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      retryBtn.classList.add('hidden');
      S.reconnecting = false;
      S.reconnectAttempt = 0;
      MQTT.connect(S.roomId);
    });
  }
  // Panel collapse toggle (desktop only)
  const panelToggle = el('panel-toggle-btn');
  if (panelToggle) {
    panelToggle.addEventListener('click', () => {
      const panel = el('panel-desktop');
      if (!panel) return;
      const collapsed = panel.classList.toggle('collapsed');
      panelToggle.textContent = collapsed ? '▶' : '◀';
    });
  }
  el('change-room-cancel').addEventListener('click', () => el('room-switch-overlay').classList.add('hidden'));
  el('change-room-go').addEventListener('click', () => {
    el('room-switch-overlay').classList.add('hidden');
    Room.switchRoom(el('change-room-input').value);
  });
  el('theme-toggle').addEventListener('click', () => UI.toggleTheme());

  // ---- Search ----
  el('url-btn').addEventListener('click', () => Search.parse(el('url-input').value));
  el('url-input').addEventListener('keydown', e => { if (e.key === 'Enter') Search.parse(el('url-input').value); });
  // Search result click delegate
  el('search-res').addEventListener('click', e => {
    const item = e.target.closest('.search-item');
    if (!item) return;
    const url = item.dataset.url, source = item.dataset.source, isCms = item.dataset.cms === '1';
    const title = item.dataset.title || '';
    Search.loadPlayPage(url, source, isCms ? url : null, title);
  });

  // Episode click delegate (desktop)
  el('ep-list').addEventListener('click', e => {
    const ep = e.target.closest('.ep-item');
    if (!ep) return;
    Search.switchEpisode(parseInt(ep.dataset.idx));
  });

  // ---- Playlist ----
  el('playlist').addEventListener('click', e => {
    const del = e.target.closest('.pl-del');
    if (del) { Playlist.remove(parseInt(del.dataset.idx)); return; }
    const item = e.target.closest('.playlist-item');
    if (!item) return;
    const idx = parseInt(item.dataset.idx);
    const it = Playlist.items[idx];
    if (it) {
      if (it.source === 'bili') {
        const bvMatch = it.url.match(/BV([A-Za-z0-9]+)/);
        if (bvMatch) { Search._loadBili(bvMatch[1]); return; }
      }
      if (it.source === 'youtube' || it.url.indexOf('yt:') === 0) {
        const ytMatch = it.url.match(/yt:([\w-]+)/);
        if (ytMatch) { Search._loadYouTube(ytMatch[1]); return; }
      }
      Search.loadPlayPage(it.url, it.source || 'direct', null);
      S.episodes = [{ label: it.label || 'HD', url: it.url }];
      S.currentEpisode = 0;
    }
  });
  el('playlist-clear').addEventListener('click', () => Playlist.clearAll());

  // ---- Chat ----
  const sendChat = () => {
    const txt = el('chat-input').value.trim();
    if (txt) { Chat.send(txt); el('chat-input').value = ''; }
  };
  el('chat-btn').addEventListener('click', sendChat);
  el('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  // 桌面端：查看聊天（点击面板/聚焦输入框）即清除未读徽标
  const chatPanelEl = el('pnl-chat');
  if (chatPanelEl) chatPanelEl.addEventListener('click', () => { S.unreadChat = 0; MsgHandler._updateChatBadge(); });
  el('chat-input').addEventListener('focus', () => { S.unreadChat = 0; MsgHandler._updateChatBadge(); });

  // Emoji
  const emojiPicker = el('emoji-picker');
  CFG.EMOJI.forEach(e => {
    const span = document.createElement('span');
    span.className = 'emoji-item'; span.textContent = e;
    span.addEventListener('click', () => {
      el('chat-input').value += e;
      el('chat-input').focus();
      emojiPicker.classList.remove('show');
    });
    emojiPicker.appendChild(span);
  });
  el('emoji-btn').addEventListener('click', e => {
    e.stopPropagation();
    emojiPicker.classList.toggle('show');
  });
  document.addEventListener('click', e => {
    if (!emojiPicker.contains(e.target) && e.target !== el('emoji-btn')) emojiPicker.classList.remove('show');
  });

  // ---- Video Controls ----
  el('clear-btn').addEventListener('click', () => {
    Player.clear();
    MQTT.publish({ t: 'video-url', url: '', type: '' });
  });

  // Manual sync button (desktop + mobile)
  function doManualSync(btn) {
    if (!S.roomId || S.connState !== 'connected') { Toast.warn('未连接房间'); return; }
    S.lastLocalAction = Date.now();
    if (btn) btn.classList.add('spinning');
    setTimeout(() => { if (btn) btn.classList.remove('spinning'); }, 600);
    MQTT.publish({ t: 'sync-req' });
    Toast.info('已发送同步请求');
  }
  const syncBtn = el('sync-btn');
  if (syncBtn) syncBtn.addEventListener('click', () => doManualSync(syncBtn));
  const mobileSyncBtn = el('mobile-sync-btn');
  if (mobileSyncBtn) mobileSyncBtn.addEventListener('click', () => doManualSync(mobileSyncBtn));

  // Play/pause button
  const ppBtn = el('playpause-btn');
  if (ppBtn) {
    const ppPlay = ppBtn.querySelector('.pp-play'), ppPause = ppBtn.querySelector('.pp-pause');
    function updatePPIcon() {
      const v = el('player');
      if (v.paused) { if (ppPlay) ppPlay.style.display = ''; if (ppPause) ppPause.style.display = 'none'; }
      else { if (ppPlay) ppPlay.style.display = 'none'; if (ppPause) ppPause.style.display = ''; }
    }
    ppBtn.addEventListener('click', () => {
      const v = el('player');
      if (v.paused) v.play().catch(() => {}); else v.pause();
      updatePPIcon();
      S.lastLocalAction = Date.now();  // 防回弹
    });
    el('player').addEventListener('play', updatePPIcon);
    el('player').addEventListener('pause', updatePPIcon);
  }

  // Video click to toggle play/pause (when not clicking controls)
  el('video-stage').addEventListener('click', (e) => {
    if (e.target.closest('.vid-ctrl-btn') || e.target.closest('.vid-seek-wrap') ||
        e.target.closest('.speed-group') || e.target.closest('#vid-controls')) return;
    const v = el('player');
    if (!S.videoUrl) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
    S.lastLocalAction = Date.now();
  });

  el('fullscreen-btn').addEventListener('click', () => {
    const stage = el('video-stage');
    if (document.fullscreenElement) document.exitFullscreen();
    else stage.requestFullscreen().catch(() => {});
  });

  // Speed
  $$('.speed-opt').forEach(o => {
    o.addEventListener('click', () => {
      const rate = parseFloat(o.dataset.speed);
      MsgHandler._updateSpeedUI(rate);
      Sync.send('speed', { rate });
    });
  });

  // Copy link
  el('copy-link-btn').addEventListener('click', () => {
    const link = window.location.origin + window.location.pathname + '#' + S.roomId;
    copyText(link);
    Toast.info('链接已复制！');
  });

  // PIP
  const pipBtn = el('pip-btn');
  if (pipBtn) {
    pipBtn.addEventListener('click', () => {
      const v = el('player');
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
      } else if (document.pictureInPictureEnabled) {
        v.requestPictureInPicture().catch(() => {});
      }
    });
  }

  // Volume
  const volSlider = el('vol-slider');
  if (volSlider) {
    volSlider.addEventListener('input', () => {
      el('player').volume = parseFloat(volSlider.value);
      const icon = el('vol-slider').parentElement.querySelector('.vol-icon');
      if (icon) icon.textContent = volSlider.value > 0.5 ? '🔊' : volSlider.value > 0 ? '🔉' : '🔇';
    });
  }

  // ---- Player Events ----
  const v = el('player');
  v.addEventListener('play', () => { if (!S.isSyncing) Sync.send('play', { time: v.currentTime, name: S.nickname }); });
  v.addEventListener('pause', () => { if (!S.isSyncing) Sync.send('pause', { time: v.currentTime, name: S.nickname }); });
  v.addEventListener('seeked', () => {
    if (S._skipSeekSync) { S._skipSeekSync = false; return; }
    if (!S.isSyncing) {
      v.pause(); // 拖动进度条后先暂停
      S.seekWaitAck = true;
      Sync.send('seek', { time: v.currentTime, name: S.nickname, peerPlaying: !v.paused, sync: true });
      // 超时保护：5 秒无应答自动恢复
      clearTimeout(S._seekAckTimer);
      S._seekAckTimer = setTimeout(() => {
        if (S.seekWaitAck) {
          S.seekWaitAck = false;
          v.play().catch(() => {});
          Toast.warn('对方未响应，自动恢复播放');
        }
      }, 5000);
    }
  });
  // 缓冲指示器 — seek/等待时显示，播放时隐藏
  v.addEventListener('seeking', () => { Player._showLoad('加载中...'); });
  v.addEventListener('waiting', () => {
    if (v.duration && v.currentTime > 0) Player._showLoad('缓冲中...');
  });
  v.addEventListener('canplay', () => { Player._hideLoad(); });
  v.addEventListener('playing', () => { Player._hideLoad(); });
  v.addEventListener('stalled', () => { if (v.duration) Player._showLoad('缓冲中...'); });
  v.addEventListener('ended', () => {
    // Auto-play next episode if available
    if (S.episodes.length > 1 && S.currentEpisode < S.episodes.length - 1) {
      Search.switchEpisode(S.currentEpisode + 1);
      Toast.info('自动播放下一集');
    }
  });
  v.addEventListener('loadedmetadata', () => {
    v.playbackRate = S.playbackSpeed;
  });
  v.addEventListener('error', () => {
    Player._hideLoad();
    const code = v.error?.code;
    const msg = code === 4 ? '视频源不可用' : '视频加载失败';
    const eo = el('video-err-overlay'), et = el('video-err-txt');
    const ea = el('video-err-actions');
    if (et) et.textContent = msg;
    if (ea) ea.innerHTML = '<button class="btn btn-primary btn-sm" id="ve-retry">重试</button>' +
      '<button class="btn btn-sm btn-secondary" id="ve-close">关闭</button>';
    if (eo) eo.classList.remove('hidden');
    setTimeout(() => {
      const retry = $('#ve-retry'), close = $('#ve-close');
      if (retry) retry.addEventListener('click', () => {
        if (eo) eo.classList.add('hidden');
        if (S.videoUrl) Player.load(S.videoUrl);
      });
      if (close) close.addEventListener('click', () => { if (eo) eo.classList.add('hidden'); });
    }, 50);
    Toast.error(msg);
  });

  // ---- Seek Bar ----
  let seekDragging = false;
  const seekBar = el('vid-seek'), vidCur = el('vid-cur'), vidDur = el('vid-dur');
  // 缓存 accent 色值，避免 timeupdate 每帧 getComputedStyle
  let _accent = '#E11D48';
  try { _accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#E11D48'; } catch(e) {}

  v.addEventListener('timeupdate', () => {
    if (seekDragging || !seekBar) return;
    const pct = v.duration ? (v.currentTime / v.duration) * 100 : 0;
    seekBar.value = pct;
    seekBar.style.background = 'linear-gradient(to right,' + _accent + ' ' + pct + '%,rgba(255,255,255,0.2) ' + pct + '%)';
    if (vidCur) vidCur.textContent = fmtTime(v.currentTime);
  });
  v.addEventListener('durationchange', () => {
    if (vidDur && v.duration && isFinite(v.duration)) vidDur.textContent = fmtTime(v.duration);
  });

  if (seekBar) {
    seekBar.addEventListener('input', () => {
      seekDragging = true;
      const t = (parseFloat(seekBar.value) / 100) * (v.duration || 0);
      if (vidCur) vidCur.textContent = fmtTime(t);
      seekBar.style.background = 'linear-gradient(to right,' + _accent + ' ' + seekBar.value + '%,rgba(255,255,255,0.2) ' + seekBar.value + '%)';
    });
    const endSeek = () => {
      v.pause(); // 拖动进度条立即暂停
      v.currentTime = (parseFloat(seekBar.value) / 100) * (v.duration || 0);
      seekDragging = false;
      S.lastLocalAction = Date.now();
      S.lastManualSeek = Date.now();   // seek 用 10s 保护窗口
    };
    seekBar.addEventListener('change', endSeek);
    seekBar.addEventListener('pointerup', endSeek);
    seekBar.addEventListener('touchend', endSeek);
  }

  // ---- Controls interaction ----
  const vidControls = el('vid-controls');
  if (vidControls && window.innerWidth > 768) {
    let hideTimer;
    const stage = el('video-stage');
    stage.addEventListener('mousemove', () => {
      vidControls.classList.add('interacting');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => vidControls.classList.remove('interacting'), 2500);
    });
    stage.addEventListener('mouseleave', () => {
      hideTimer = setTimeout(() => vidControls.classList.remove('interacting'), 800);
    });
    if (seekBar) seekBar.addEventListener('pointerdown', () => vidControls.classList.add('interacting'));
  }

  // ---- Fullscreen sync ----
  document.addEventListener('fullscreenchange', () => {
    const fs = el('fullscreen-btn');
    if (fs) {
      const icon = document.fullscreenElement ?
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 8 4 4 8 4"/><polyline points="16 4 20 4 20 8"/><polyline points="20 16 20 20 16 20"/><polyline points="8 20 4 20 4 16"/></svg>' :
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
      fs.innerHTML = icon;
    }
  });

  // ---- Tab restore ----
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.roomId && S.connState === 'connected') {
      setTimeout(() => MQTT.publish({ t: 'sync-req' }), 500);
    }
  });

  // ---- Periodic sync (every 8s) —— 定期自检校准 ----
  let _periodicSync = setInterval(() => {
    if (!S.roomId || S.connState !== 'connected' || !S.videoUrl || !S.peerOnline) return;
    // iframe 模式（B站/YouTube）无 video.duration，直接发同步请求
    if (Player._mode !== 'video') { MQTT.publish({ t: 'sync-req' }); return; }
    const v = el('player');
    if (!v || !v.duration || S.isSyncing) return;
    MQTT.publish({ t: 'sync-req' });
  }, 8000);

  // ---- Peer heartbeat（检测对方直接关页/断网，不触发 leave 的离线状态）----
  let _heartbeat = setInterval(() => {
    if (!S.roomId || S.connState !== 'connected') return;
    MQTT.publish({ t: 'ping', name: S.nickname });
    // 45s 未收到对方任何消息 → 判定离线
    if (S.peerOnline && S.lastPeerSeen && Date.now() - S.lastPeerSeen > 45000) {
      S.peerOnline = false;
      S.peerName = '';
      const pp = el('peer-presence'); if (pp) pp.classList.add('hidden');
      const pv = el('peer-video'); if (pv) pv.textContent = '';
      Log.sys('对方已离线（超时）');
      Toast.warn('👋 对方已离线');
      Member.render();
      MsgHandler._updateOnlineStatus();
    }
  }, 15000);

  // 离开房间时清理 timer
  const _origDisconnect = MQTT.disconnect.bind(MQTT);
  MQTT.disconnect = function() {
    clearInterval(_periodicSync);
    clearInterval(_heartbeat);
    _origDisconnect();
  };

  // ---- Keyboard Shortcuts ----
  document.addEventListener('keydown', (e) => {
    // 只在播放页且不在输入框时触发
    if (!S.roomId || document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
    const v = el('player');
    // iframe 模式（B站/YouTube）：仅支持 播放/暂停（其余由 iframe 自带控制栏处理）
    if (Player._mode !== 'video') {
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        if (Player.isPaused()) Player.play(); else Player.pause();
      }
      return;
    }
    switch (e.key) {
      case ' ': case 'k':
        e.preventDefault();
        if (v.paused) v.play().catch(() => {}); else v.pause();
        break;
      case 'ArrowLeft': e.preventDefault(); S._skipSeekSync = true; if (v.currentTime) v.currentTime = Math.max(0, v.currentTime - 5); break;
      case 'ArrowRight': e.preventDefault(); S._skipSeekSync = true; if (v.duration) v.currentTime = Math.min(v.duration, v.currentTime + 5); break;
      case 'ArrowUp': e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); break;
      case 'ArrowDown': e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); break;
      case 'f': e.preventDefault(); el('video-stage').requestFullscreen().catch(() => {}); break;
      case 'm': e.preventDefault(); v.muted = !v.muted; break;
    }
  });

  // ---- Auto OS Theme ----
  const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
  if (!localStorage.getItem('wt_theme')) {
    UI._setTheme(darkMQ.matches ? 'dark' : 'light');
  }
  darkMQ.addEventListener('change', e => {
    if (!localStorage.getItem('wt_theme')) UI._setTheme(e.matches ? 'dark' : 'light');
  });

  // ---- Auto-restore hash ----
  const hash = window.location.hash.slice(1);
  if (hash) Room.enter(hash);
}

// Fire it up
document.addEventListener('DOMContentLoaded', boot);

})();
