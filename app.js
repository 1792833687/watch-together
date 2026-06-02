/**
 * Watch Together - 双人同步观影
 * P2P-based synchronized video watching with chat
 * Uses PeerJS for WebRTC signaling
 */

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

function showToast(message, type) {
  if (type === void 0) type = 'success';
  var toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);
  setTimeout(function () {
    toast.classList.add('removing');
    setTimeout(function () { toast.remove(); }, 200);
  }, 3000);
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

// ============================================
// SCREEN MANAGEMENT
// ============================================
function showScreen(screenId) {
  $$('.screen').forEach(function (s) { s.classList.remove('active'); });
  var screen = document.getElementById(screenId);
  if (screen) screen.classList.add('active');
}

// ============================================
// PEER CONNECTION
// ============================================
function setupConnection(conn) {
  conn.on('open', function () {
    State.isConnected = true;
    State.isConnecting = false;
    setConnectionStatus('connected');

    if (State.isHost) {
      dom.roomInfo.textContent = '好友已加入房间';
      addChatMessage('system', '好友加入了房间');
      syncVideoState();
    } else {
      dom.roomInfo.textContent = '已加入房间';
      addChatMessage('system', '成功加入房间');
    }

    showScreen('watch-room');
    updateRoomUI();
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
  State.isConnected = false;
  State.isConnecting = false;
  State.conn = null;
  setConnectionStatus('offline');
  dom.roomInfo.textContent = '';
  addChatMessage('system', '连接已断开');
  showScreen('lobby');
}

function sendMessage(type, payload) {
  if (payload === void 0) payload = {};
  if (!State.conn || !State.isConnected) return;
  try {
    State.conn.send(Object.assign({ type: type, ts: Date.now() }, payload));
  } catch (e) {
    console.error('Send error:', e);
  }
}

// ============================================
// MESSAGE HANDLING
// ============================================
function handleDataMessage(data) {
  switch (data.type) {
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
// Strategy: Host creates peer with custom ID = "wt-" + roomId.
// Joiner connects to "wt-" + roomId.

function peerIdFromRoom(roomId) {
  return 'wt-' + roomId;
}

async function createRoom() {
  if (State.isConnecting) return;

  State.isConnecting = true;
  State.isHost = true;
  State.roomId = generateRoomId();
  setConnectionStatus('connecting');

  var customId = peerIdFromRoom(State.roomId);

  try {
    State.peer = new Peer(customId, { debug: 0 });

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
      State.isConnecting = false;
      setConnectionStatus('offline');

      if (err.type === 'unavailable-id') {
        // Retry with a new ID
        State.peer.destroy();
        State.roomId = generateRoomId();
        createRoom();
        return;
      }

      showToast('创建房间失败，请检查网络连接', 'error');
      console.error(err);
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
      // PeerJS may try to reconnect
      State.peer.reconnect();
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

  State.isConnecting = true;
  State.isHost = false;
  State.roomId = roomId;
  setConnectionStatus('connecting');

  try {
    State.peer = new Peer(undefined, { debug: 0 });

    var connectTimer = null;

    State.peer.on('open', function (id) {
      State.peerId = id;

      var hostId = peerIdFromRoom(roomId);
      var conn = State.peer.connect(hostId, { reliable: true });
      State.conn = conn;
      setupConnection(conn);
    });

    State.peer.on('error', function (err) {
      State.isConnecting = false;
      setConnectionStatus('offline');
      if (err.type === 'peer-unavailable') {
        showToast('找不到该房间，请检查房间号', 'error');
      } else {
        showToast('连接失败，请检查网络', 'error');
      }
      console.error(err);
    });

    // Timeout
    setTimeout(function () {
      if (!State.isConnected && State.isConnecting) {
        State.isConnecting = false;
        if (State.conn) { State.conn.close(); State.conn = null; }
        setConnectionStatus('offline');
        showToast('连接超时，请检查房间号是否正确', 'error');
      }
    }, 20000);

  } catch (err) {
    State.isConnecting = false;
    setConnectionStatus('offline');
    showToast('加入房间失败', 'error');
    console.error(err);
  }
}

function updateRoomUI() {
  dom.displayRoomId.textContent = State.roomId || '---';
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

  // Show loading state
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

  // For CORS-restricted external URLs, the video tag may fail.
  // We attempt direct loading; the browser will handle CORS.
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

  // Periodic sync to correct drift (every 4 seconds when playing)
  setInterval(function () {
    if (State.isHost && State.isConnected && State.videoUrl && !video.paused) {
      sendMessage('play', { currentTime: video.currentTime });
    }
  }, 4000);
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
    msgDiv.innerHTML =
      '<div class="msg-sender">好友</div>' +
      '<div class="msg-text">' + escapeHtml(text) + '</div>' +
      '<div class="msg-time">' + now + '</div>';
  } else {
    msgDiv.innerHTML =
      '<div class="msg-sender">我</div>' +
      '<div class="msg-text">' + escapeHtml(text) + '</div>' +
      '<div class="msg-time">' + now + '</div>';
  }

  var empty = dom.chatMessages.querySelector('.chat-empty');
  if (empty) empty.remove();

  dom.chatMessages.appendChild(msgDiv);
  dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function escapeHtml(text) {
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
}

document.addEventListener('DOMContentLoaded', init);
