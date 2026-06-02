/**
 * Watch Together - 双人同步观影
 * P2P-based synchronized video watching with chat
 * Uses PeerJS for WebRTC signaling with multiple fallback servers
 */

// ============================================
// CONFIG
// ============================================
const CONFIG = {
  // Multiple signaling servers for reliability
  signalServers: [
    { host: '0.peerjs.com', port: 443, secure: true },
    { host: 'peerjs-server.onrender.com', port: 443, secure: true },
  ],
  // TURN/STUN for NAT traversal
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  connectTimeout: 30000,
  heartbeatInterval: 5000,
  syncInterval: 4000,
  maxRetries: 3,
};

// ============================================
// STATE
// ============================================
const State = {
  peer: null,
  conn: null,
  peerId: null,
  roomId: null,
  isHost: false,
  isConnected: false,
  isConnecting: false,
  videoSource: null,
  videoUrl: null,
  isSyncing: false,
  nickname: '',
  peerNickname: '',
  serverIndex: 0,
  retryCount: 0,
  heartbeatTimer: null,
};

// ============================================
// DOM REFS
// ============================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
  statusDot: $('.status-dot'),
  statusText: $('#status-text'),
  roomInfo: $('#room-info'),
  lobby: $('#lobby'),
  watchRoom: $('#watch-room'),
  nicknameInput: $('#nickname-input'),
  roomIdInput: $('#room-id-input'),
  createRoomBtn: $('#create-room-btn'),
  joinRoomBtn: $('#join-room-btn'),
  displayRoomId: $('#display-room-id'),
  copyRoomId: $('#copy-room-id'),
  videoContainer: $('#video-container'),
  videoPlaceholder: $('#video-placeholder'),
  mainVideo: $('#main-video'),
  syncControls: $('#sync-controls'),
  syncBadge: $('#sync-badge'),
  sourcePanel: $('#source-panel'),
  uploadArea: $('#upload-area'),
  fileInput: $('#file-input'),
  urlInput: $('#url-input'),
  urlLoadBtn: $('#url-load-btn'),
  chatMessages: $('#chat-messages'),
  chatInput: $('#chat-input'),
  chatSendBtn: $('#chat-send-btn'),
  toastContainer: $('#toast-container'),
  myNameDisplay: $('#my-name-display'),
  peerNameDisplay: $('#peer-name-display'),
  peerMember: $('#peer-member'),
  memberList: $('#member-list'),
};

// ============================================
// UTILITY
// ============================================
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function generateNickname() {
  const adjectives = ['快乐', '悠闲', '好奇', '酷酷', '暖暖', '萌萌', '静静', '闪闪'];
  const nouns = ['小猫', '小狗', '小熊', '小兔', '小鱼', '小鸟', '星星', '月亮'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return adj + noun;
}

function showToast(message, type) {
  if (type === void 0) type = 'success';
  var toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);
  setTimeout(function () {
    toast.classList.add('removing');
    setTimeout(function () { toast.remove(); }, 200);
  }, 3500);
}

function formatTime(date) {
  if (date === void 0) date = new Date();
  var h = date.getHours().toString().padStart(2, '0');
  var m = date.getMinutes().toString().padStart(2, '0');
  return h + ':' + m;
}

function setConnectionStatus(status) {
  dom.statusDot.className = 'status-dot ' + status;
  var texts = {
    offline: '未连接',
    connecting: '连接中...',
    connected: '已连接',
  };
  dom.statusText.textContent = texts[status] || status;
}

function escapeHtml(text) {
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================
// SCREEN MANAGEMENT
// ============================================
function showScreen(screenId) {
  $$('.screen').forEach(function (s) { s.classList.remove('active'); });
  var screen = document.getElementById(screenId);
  if (screen) screen.classList.add('active');
}

// ============================================
// NICKNAME
// ============================================
function getNickname() {
  var input = dom.nicknameInput.value.trim();
  if (!input) {
    input = generateNickname();
    dom.nicknameInput.value = input;
  }
  State.nickname = input;
  dom.myNameDisplay.textContent = input;
}

// ============================================
// PEER CONNECTION - Core
// ============================================
function createPeerOptions(customId) {
  var opts = {
    debug: 0,
    config: { iceServers: CONFIG.iceServers },
  };

  var server = CONFIG.signalServers[State.serverIndex % CONFIG.signalServers.length];
  if (server) {
    opts.host = server.host;
    opts.port = server.port;
    opts.secure = server.secure;
  }

  if (customId) {
    opts.key = undefined;
    // For custom ID: use path-based approach
    opts.path = '/';
  }

  return opts;
}

function setupConnection(conn) {
  State.conn = conn;

  conn.on('open', function () {
    State.isConnected = true;
    State.isConnecting = false;
    State.retryCount = 0;
    setConnectionStatus('connected');

    // Send username immediately on connection open
    sendMessage('hello', { nickname: State.nickname });

    if (State.isHost) {
      dom.roomInfo.textContent = '好友已加入房间';
      addChatMessage('system', '好友加入了房间，正在同步...');
      // Sync video state if any
      setTimeout(function () {
        if (State.videoUrl) syncVideoState();
      }, 500);
    } else {
      dom.roomInfo.textContent = '已加入房间';
      addChatMessage('system', '成功加入房间，等待同步...');
    }

    showScreen('watch-room');
    updateRoomUI();
    startHeartbeat();
  });

  conn.on('data', function (data) {
    handleDataMessage(data);
  });

  conn.on('close', function () {
    handleDisconnect();
  });

  conn.on('error', function (err) {
    console.error('Connection error:', err);
    handleDisconnect();
  });
}

function handleDisconnect() {
  stopHeartbeat();
  State.isConnected = false;
  State.isConnecting = false;
  State.conn = null;
  setConnectionStatus('offline');
  dom.roomInfo.textContent = '';
  dom.peerMember.style.display = 'none';
  addChatMessage('system', '连接已断开');
  showToast('连接已断开，请重新创建或加入房间', 'error');
  showScreen('lobby');
}

function sendMessage(type, payload) {
  if (payload === void 0) payload = {};
  if (!State.conn || !State.isConnected) return false;
  try {
    State.conn.send(Object.assign({ type: type, ts: Date.now() }, payload));
    return true;
  } catch (e) {
    console.error('Send error:', e);
    return false;
  }
}

// ============================================
// HEARTBEAT
// ============================================
function startHeartbeat() {
  stopHeartbeat();
  State.heartbeatTimer = setInterval(function () {
    if (State.isConnected) {
      sendMessage('heartbeat', {});
    }
  }, CONFIG.heartbeatInterval);
}

function stopHeartbeat() {
  if (State.heartbeatTimer) {
    clearInterval(State.heartbeatTimer);
    State.heartbeatTimer = null;
  }
}

// ============================================
// MESSAGE HANDLING
// ============================================
function handleDataMessage(data) {
  switch (data.type) {
    case 'hello':
      // Received peer's nickname
      if (data.nickname) {
        State.peerNickname = data.nickname;
        dom.peerNameDisplay.textContent = data.nickname;
        dom.peerMember.style.display = 'flex';
      }
      // If host receives hello from joiner, send back hello
      if (State.isHost) {
        sendMessage('hello', { nickname: State.nickname });
        // Also sync current video state
        if (State.videoUrl) {
          setTimeout(function () { syncVideoState(); }, 300);
        }
      }
      break;

    case 'heartbeat':
      // Just acknowledge presence
      break;

    case 'chat':
      addChatMessage('peer', data.text);
      break;

    case 'video-load':
      if (!State.isHost) {
        State.videoSource = data.source;
        State.videoUrl = data.url;
        loadVideoFromPeer(data.source, data.url, data.currentTime || 0);
      }
      break;

    case 'play':
      if (!State.isHost) {
        State.isSyncing = true;
        dom.mainVideo.currentTime = data.currentTime || dom.mainVideo.currentTime;
        dom.mainVideo.play().catch(function () {});
        setTimeout(function () { State.isSyncing = false; }, 200);
      }
      break;

    case 'pause':
      if (!State.isHost) {
        State.isSyncing = true;
        dom.mainVideo.currentTime = data.currentTime || dom.mainVideo.currentTime;
        dom.mainVideo.pause();
        setTimeout(function () { State.isSyncing = false; }, 200);
      }
      break;

    case 'seek':
      if (!State.isHost) {
        State.isSyncing = true;
        dom.mainVideo.currentTime = data.currentTime;
        setTimeout(function () { State.isSyncing = false; }, 200);
      }
      break;

    case 'sync-state':
      if (!State.isHost && data.videoUrl && data.videoSource) {
        State.videoSource = data.videoSource;
        State.videoUrl = data.videoUrl;
        loadVideoFromPeer(data.videoSource, data.videoUrl, data.currentTime || 0, data.paused);
      }
      break;

    default:
      break;
  }
}

// ============================================
// ROOM MANAGEMENT
// ============================================
function peerIdFromRoom(roomId) {
  return 'wt-' + roomId;
}

function destroyPeer() {
  stopHeartbeat();
  if (State.conn) {
    try { State.conn.close(); } catch (e) {}
    State.conn = null;
  }
  if (State.peer) {
    try { State.peer.destroy(); } catch (e) {}
    State.peer = null;
  }
}

async function createRoom() {
  if (State.isConnecting) return;

  getNickname();
  destroyPeer();

  State.isConnecting = true;
  State.isHost = true;
  State.roomId = generateRoomId();
  State.retryCount = 0;
  State.serverIndex = 0;
  setConnectionStatus('connecting');

  tryCreateHost();
}

function tryCreateHost() {
  var customId = peerIdFromRoom(State.roomId);
  var opts = createPeerOptions();
  // Set custom ID as peer id
  opts.key = undefined;

  try {
    State.peer = new Peer(customId, opts);

    State.peer.on('open', function (id) {
      State.peerId = id;
      setConnectionStatus('connected');
      dom.roomInfo.textContent = '等待好友加入...';
      showScreen('watch-room');
      updateRoomUI();
      addChatMessage('system', '房间已创建，房间号: ' + State.roomId);
      showToast('房间创建成功！复制房间号邀请好友');
    });

    State.peer.on('error', function (err) {
      console.error('Peer error:', err.type, err.message);

      if (err.type === 'unavailable-id') {
        // Try a different room ID
        State.peer.destroy();
        State.peer = null;
        State.roomId = generateRoomId();
        tryCreateHost();
        return;
      }

      if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
        // Try next signaling server
        State.serverIndex++;
        if (State.peer) { State.peer.destroy(); State.peer = null; }
        if (State.serverIndex < CONFIG.signalServers.length) {
          showToast('切换信令服务器重试...');
          setTimeout(function () { tryCreateHost(); }, 500);
          return;
        }
      }

      State.isConnecting = false;
      setConnectionStatus('offline');
      showToast('创建房间失败，请检查网络后重试', 'error');
    });

    State.peer.on('connection', function (conn) {
      if (State.conn) {
        conn.close();
        return;
      }
      State.conn = conn;
      setupConnection(conn);
    });

    State.peer.on('disconnected', function () {
      if (State.peer && !State.peer.destroyed) {
        State.peer.reconnect();
      }
    });

  } catch (err) {
    State.isConnecting = false;
    setConnectionStatus('offline');
    showToast('创建房间失败', 'error');
    console.error(err);
  }
}

async function joinRoom() {
  var roomId = dom.roomIdInput.value.trim().toUpperCase();
  if (!roomId) {
    showToast('请输入房间号', 'error');
    return;
  }
  if (State.isConnecting) return;

  getNickname();
  destroyPeer();

  State.isConnecting = true;
  State.isHost = false;
  State.roomId = roomId;
  State.retryCount = 0;
  State.serverIndex = 0;
  setConnectionStatus('connecting');

  tryJoin();
}

function tryJoin() {
  var opts = createPeerOptions();

  try {
    State.peer = new Peer(opts);

    var connectTimeoutId = null;

    State.peer.on('open', function (id) {
      State.peerId = id;

      var hostId = peerIdFromRoom(State.roomId);
      var conn = State.peer.connect(hostId, {
        reliable: true,
        serialization: 'json',
      });

      State.conn = conn;
      setupConnection(conn);

      // Set connection timeout
      connectTimeoutId = setTimeout(function () {
        if (!State.isConnected && State.isConnecting) {
          State.isConnecting = false;
          if (State.conn) { State.conn.close(); State.conn = null; }
          setConnectionStatus('offline');

          State.retryCount++;
          if (State.retryCount < CONFIG.maxRetries) {
            showToast('连接超时，正在重试 (' + (State.retryCount + 1) + '/' + CONFIG.maxRetries + ')...');
            destroyPeer();
            setTimeout(function () { tryJoin(); }, 1000);
          } else {
            showToast('连接失败，请确认房间号正确且房主在线', 'error');
          }
        }
      }, CONFIG.connectTimeout);
    });

    State.peer.on('error', function (err) {
      if (connectTimeoutId) clearTimeout(connectTimeoutId);

      if (err.type === 'peer-unavailable') {
        State.retryCount++;
        if (State.retryCount < CONFIG.maxRetries) {
          showToast('房间暂未响应，正在重试 (' + (State.retryCount + 1) + '/' + CONFIG.maxRetries + ')...');
          if (State.peer) { State.peer.destroy(); State.peer = null; }
          setTimeout(function () { tryJoin(); }, 1500);
          return;
        }
        State.isConnecting = false;
        setConnectionStatus('offline');
        showToast('找不到该房间，请检查房间号是否正确', 'error');
        return;
      }

      if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
        State.serverIndex++;
        if (State.peer) { State.peer.destroy(); State.peer = null; }
        if (State.serverIndex < CONFIG.signalServers.length) {
          showToast('切换信令服务器重试...');
          setTimeout(function () { tryJoin(); }, 500);
          return;
        }
      }

      State.isConnecting = false;
      setConnectionStatus('offline');
      showToast('连接失败，请检查网络后重试', 'error');
      console.error(err);
    });

    State.peer.on('disconnected', function () {
      if (State.peer && !State.peer.destroyed) {
        State.peer.reconnect();
      }
    });

  } catch (err) {
    State.isConnecting = false;
    setConnectionStatus('offline');
    showToast('加入房间失败', 'error');
    console.error(err);
  }
}

function updateRoomUI() {
  dom.displayRoomId.textContent = State.roomId || '---';
  dom.myNameDisplay.textContent = State.nickname || '我';

  // Update role text
  var roleSpan = dom.memberList.querySelector('.member-role');
  if (roleSpan) {
    roleSpan.textContent = State.isHost ? '（房主）' : '（成员）';
  }
}

function copyRoomId() {
  if (!State.roomId) return;
  navigator.clipboard.writeText(State.roomId).then(function () {
    showToast('房间号已复制到剪贴板');
  }).catch(function () {
    var input = document.createElement('input');
    input.value = State.roomId;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    showToast('房间号已复制');
  });
}

// ============================================
// VIDEO MANAGEMENT
// ============================================
function loadVideo(source, url, startTime) {
  if (startTime === void 0) startTime = 0;

  State.videoSource = source;
  State.videoUrl = url;

  dom.mainVideo.src = url;
  dom.mainVideo.style.display = 'block';
  dom.videoPlaceholder.style.display = 'none';
  dom.syncControls.classList.add('visible');

  dom.mainVideo.onloadedmetadata = function () {
    if (startTime > 0) {
      dom.mainVideo.currentTime = startTime;
    }
  };

  if (State.isHost && State.isConnected) {
    sendMessage('video-load', {
      source: source,
      url: url,
      currentTime: dom.mainVideo.currentTime,
    });
  }
}

function loadVideoFromPeer(source, url, currentTime, isPaused) {
  State.videoSource = source;
  State.videoUrl = url;

  dom.mainVideo.src = url;
  dom.mainVideo.style.display = 'block';
  dom.videoPlaceholder.style.display = 'none';
  dom.syncControls.classList.add('visible');

  dom.mainVideo.onloadedmetadata = function () {
    dom.mainVideo.currentTime = currentTime;
    if (isPaused) {
      dom.mainVideo.pause();
    } else {
      dom.mainVideo.play().catch(function () {});
    }
  };

  addChatMessage('system', '房主加载了新视频');
}

function handleFileUpload(file) {
  if (!file) return;
  if (!file.type.startsWith('video/')) {
    showToast('请选择视频文件', 'error');
    return;
  }

  // Check file size - warn if > 200MB
  if (file.size > 200 * 1024 * 1024) {
    showToast('文件较大（>' + Math.round(file.size / 1024 / 1024) + 'MB），加载可能需要一些时间');
  }

  showToast('正在加载视频...');

  var url = URL.createObjectURL(file);
  loadVideo('upload', url);
  showToast('视频已加载');
}

function handleUrlLoad() {
  var url = dom.urlInput.value.trim();
  if (!url) {
    showToast('请输入视频链接', 'error');
    return;
  }

  // Validate URL
  try {
    new URL(url);
  } catch (e) {
    showToast('请输入有效的URL地址', 'error');
    return;
  }

  loadVideo('url', url);
  showToast('视频已加载');
}

function syncVideoState() {
  if (!State.isHost || !State.isConnected) return;
  if (!State.videoUrl) return;

  sendMessage('sync-state', {
    videoSource: State.videoSource,
    videoUrl: State.videoUrl,
    currentTime: dom.mainVideo.currentTime,
    paused: dom.mainVideo.paused,
  });
}

// ============================================
// VIDEO EVENT HANDLERS
// ============================================
function setupVideoEvents() {
  var video = dom.mainVideo;

  video.addEventListener('play', function () {
    if (State.isSyncing) return;
    if (State.isHost && State.isConnected) {
      sendMessage('play', { currentTime: video.currentTime });
    }
  });

  video.addEventListener('pause', function () {
    if (State.isSyncing) return;
    if (State.isHost && State.isConnected) {
      sendMessage('pause', { currentTime: video.currentTime });
    }
  });

  video.addEventListener('seeked', function () {
    if (State.isSyncing) return;
    if (State.isHost && State.isConnected) {
      sendMessage('seek', { currentTime: video.currentTime });
    }
  });

  // Periodic sync to correct drift
  setInterval(function () {
    if (State.isHost && State.isConnected && State.videoUrl && !video.paused) {
      sendMessage('play', { currentTime: video.currentTime });
    }
  }, CONFIG.syncInterval);
}

// ============================================
// CHAT
// ============================================
function addChatMessage(sender, text) {
  var msgDiv = document.createElement('div');
  msgDiv.className = 'chat-message' + (sender === 'system' ? ' system' : '');
  var now = formatTime();

  if (sender === 'system') {
    msgDiv.innerHTML = '<span class="msg-text">' + escapeHtml(text) + '</span>';
  } else if (sender === 'peer') {
    var peerName = State.peerNickname || '好友';
    msgDiv.innerHTML =
      '<div class="msg-sender">' + escapeHtml(peerName) + '</div>' +
      '<div class="msg-text">' + escapeHtml(text) + '</div>' +
      '<div class="msg-time">' + now + '</div>';
  } else {
    var myName = State.nickname || '我';
    msgDiv.innerHTML =
      '<div class="msg-sender">' + escapeHtml(myName) + '</div>' +
      '<div class="msg-text">' + escapeHtml(text) + '</div>' +
      '<div class="msg-time">' + now + '</div>';
  }

  var empty = dom.chatMessages.querySelector('.chat-empty');
  if (empty) empty.remove();

  dom.chatMessages.appendChild(msgDiv);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function sendChat() {
  var text = dom.chatInput.value.trim();
  if (!text) return;
  if (!State.isConnected) {
    showToast('请先连接到房间', 'error');
    return;
  }

  addChatMessage('me', text);
  sendMessage('chat', { text: text });
  dom.chatInput.value = '';
}

// ============================================
// EVENT BINDINGS
// ============================================
function bindEvents() {
  // Lobby
  dom.createRoomBtn.addEventListener('click', createRoom);
  dom.joinRoomBtn.addEventListener('click', joinRoom);
  dom.roomIdInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') joinRoom();
  });

  // Room
  dom.copyRoomId.addEventListener('click', copyRoomId);

  // Source tabs
  $$('.source-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var tabName = tab.dataset.tab;
      $$('.source-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      $$('.source-pane').forEach(function (p) { p.classList.remove('active'); });
      document.getElementById('pane-' + tabName).classList.add('active');
    });
  });

  // File upload
  dom.uploadArea.addEventListener('click', function () { dom.fileInput.click(); });
  dom.fileInput.addEventListener('change', function (e) {
    handleFileUpload(e.target.files[0]);
  });

  // Drag and drop
  dom.uploadArea.addEventListener('dragover', function (e) {
    e.preventDefault();
    dom.uploadArea.classList.add('drag-over');
  });
  dom.uploadArea.addEventListener('dragleave', function () {
    dom.uploadArea.classList.remove('drag-over');
  });
  dom.uploadArea.addEventListener('drop', function (e) {
    e.preventDefault();
    dom.uploadArea.classList.remove('drag-over');
    handleFileUpload(e.dataTransfer.files[0]);
  });

  // URL load
  dom.urlLoadBtn.addEventListener('click', handleUrlLoad);
  dom.urlInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') handleUrlLoad();
  });

  // Chat
  dom.chatSendBtn.addEventListener('click', sendChat);
  dom.chatInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') sendChat();
  });

  // Video events
  setupVideoEvents();
}

// ============================================
// INIT
// ============================================
function init() {
  bindEvents();
  setConnectionStatus('offline');
  // Pre-fill a random nickname
  dom.nicknameInput.value = generateNickname();
}

document.addEventListener('DOMContentLoaded', init);
