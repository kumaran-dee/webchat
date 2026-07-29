// Application State
let state = {
  roomCode: null,
  nickname: null,
  users: [], // Array of objects: { socketId, nickname }
  files: [],
  isHost: false,
  hostSocketId: null,
  isLocked: false,
  isMuted: false,
  waitingNickname: null
};

// Generate or retrieve a unique local client ID (replaces socket.id)
let socketId = sessionStorage.getItem('webchat_socket_id');
if (!socketId) {
  socketId = 'client-' + Date.now() + '-' + Math.round(Math.random() * 1e9);
  sessionStorage.setItem('webchat_socket_id', socketId);
}

// Default App Configuration (Updated asynchronously)
let config = {
  useVercelBlob: false,
  pusherKey: null,
  pusherCluster: null,
  isRedisConfigured: true
};

// Asynchronously load server configuration without blocking DOM event listener registration
fetch('/api/config')
  .then(res => res.json())
  .then(data => {
    config = data;
    initPusher();
    
    const isProduction = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
    if (isProduction && !config.isRedisConfigured) {
      const banner = document.getElementById('db-alert-banner');
      if (banner) banner.classList.remove('hidden');
    }
  })
  .catch(err => {
    console.warn('Config fetch warning:', err);
  });

// Check if kicked recently
if (sessionStorage.getItem('vanishchat_kicked') === 'true') {
  sessionStorage.removeItem('vanishchat_kicked');
  setTimeout(() => {
    showToast('You were removed from the room by the host.', 'error');
  }, 300);
}

// DOM Elements
const el = {
  // Views
  landingView: document.getElementById('landing-view'),
  chatView: document.getElementById('chat-view'),
  connectionStatus: document.getElementById('connection-status'),
  statusPulse: document.querySelector('.pulse-dot'),

  // Forms & Inputs
  createForm: document.getElementById('create-form'),
  createNickname: document.getElementById('create-nickname'),
  btnCreate: document.getElementById('btn-create'),
  joinForm: document.getElementById('join-form'),
  joinNickname: document.getElementById('join-nickname'),
  joinCode: document.getElementById('join-code'),
  btnJoin: document.getElementById('btn-join'),

  // Chat Area Header
  displayRoomCode: document.getElementById('display-room-code'),
  btnCopyCode: document.getElementById('btn-copy-code'),
  muteRoomWrapper: document.getElementById('mute-room-wrapper'),
  muteRoomToggle: document.getElementById('mute-room-toggle'),
  activeUserCount: document.getElementById('active-user-count'),
  btnLeave: document.getElementById('btn-leave'),
  messagesContainer: document.getElementById('messages-container'),
  
  // Sidebar lists
  usersContainer: document.getElementById('users-container'),
  userCount: document.getElementById('user-count'),
  filesContainer: document.getElementById('files-container'),
  fileCount: document.getElementById('file-count'),
  
  // Message Sending
  chatForm: document.getElementById('chat-form'),
  messageInput: document.getElementById('message-input'),
  btnSend: document.getElementById('btn-send'),
  fileInput: document.getElementById('file-input'),
  btnAttach: document.getElementById('btn-attach'),

  // Upload Progress
  uploadProgressPanel: document.getElementById('upload-progress-panel'),
  uploadFilename: document.getElementById('upload-filename'),
  uploadPercent: document.getElementById('upload-percent'),
  uploadProgressBar: document.getElementById('upload-progress-bar'),

  // Sidebar
  chatSidebar: document.querySelector('.chat-sidebar'),
  btnToggleSidebar: document.getElementById('btn-toggle-sidebar'),

  // Toast System
  toastContainer: document.getElementById('toast-container')
};

// Sidebar Toggle Action (Mobile & Tablet)
if (el.btnToggleSidebar && el.chatSidebar) {
  el.btnToggleSidebar.addEventListener('click', () => {
    el.chatSidebar.classList.toggle('active');
  });
}

// --- Real-time Subscription (Pusher) & Polling Fallback Setup ---
let pusher = null;
let roomChannel = null;
let hostChannel = null;
let pollingInterval = null;
let lastKnownMessagesCount = 0;
let lastKnownFilesCount = 0;

function initPusher() {
  if (config.pusherKey) {
    pusher = new Pusher(config.pusherKey, {
      cluster: config.pusherCluster,
      authEndpoint: '/api/pusher/auth'
    });

    pusher.connection.bind('state_change', (states) => {
      const current = states.current;
      if (current === 'connected') {
        el.connectionStatus.innerText = 'Connected';
        el.statusPulse.style.backgroundColor = 'var(--success)';
        el.statusPulse.style.boxShadow = '0 0 8px var(--success)';
      } else {
        el.connectionStatus.innerText = 'Connecting...';
        el.statusPulse.style.backgroundColor = 'var(--danger)';
        el.statusPulse.style.boxShadow = '0 0 8px var(--danger)';
      }
    });
  } else {
    console.warn("Pusher key missing. Real-time functions will use polling.");
    el.connectionStatus.innerText = 'Connected (Polling)';
    el.statusPulse.style.backgroundColor = 'var(--success)';
    el.statusPulse.style.boxShadow = '0 0 8px var(--success)';
  }
}

function subscribeToHostEvents(roomCode, nickname) {
  if (!pusher) return;

  pusher.config.auth = {
    params: {
      nickname: nickname,
      userId: socketId
    }
  };

  const channelName = `private-host-${socketId}`;
  if (hostChannel) pusher.unsubscribe(hostChannel.name);

  hostChannel = pusher.subscribe(channelName);

  hostChannel.bind('kicked', () => {
    sessionStorage.setItem('vanishchat_kicked', 'true');
    window.location.reload();
  });
}

function subscribeToRoomEvents(roomCode, nickname) {
  if (!pusher) return;

  const channelName = `presence-room-${roomCode}`;
  if (roomChannel) pusher.unsubscribe(roomChannel.name);

  roomChannel = pusher.subscribe(channelName);

  roomChannel.bind('user-joined', (data) => {
    state.users = data.users;
    updateUsersCountUI();
    renderAllUsers();
    appendSystemMessage(data.systemMessage.text);
    showToast(`${data.nickname} joined the room.`, 'info');
  });

  roomChannel.bind('user-left', (data) => {
    state.users = data.users;
    updateUsersCountUI();
    renderAllUsers();
    appendSystemMessage(data.systemMessage.text);
    showToast(`${data.nickname} left the room.`, 'info');
  });

  roomChannel.bind('message-received', (message) => {
    appendMessage(message);
    scrollToBottom();
  });

  roomChannel.bind('file-shared', (data) => {
    state.files.push(data.file);
    renderAllFiles();
    appendMessage(data.message);
    scrollToBottom();
    showToast(`${data.file.sender} uploaded: ${data.file.originalName}`, 'success');
  });

  roomChannel.bind('mute-status-changed', (data) => {
    state.isMuted = data.isMuted;
    if (state.isHost) el.muteRoomToggle.checked = state.isMuted;
    updateInputState();
  });

  roomChannel.bind('host-transferred', (data) => {
    state.hostSocketId = data.hostSocketId;
    state.isHost = (socketId === data.hostSocketId);
    
    if (state.isHost) {
      el.muteRoomWrapper.classList.remove('hidden');
      el.muteRoomToggle.checked = state.isMuted;
      showToast('You are now the room host!', 'success');
    } else {
      el.muteRoomWrapper.classList.add('hidden');
    }

    renderAllUsers();
    appendSystemMessage(data.systemMessage.text);
  });
}

function startPolling(roomCode, nickname) {
  if (pollingInterval) clearInterval(pollingInterval);

  const sendHeartbeat = async () => {
    try {
      const res = await fetch('/api/rooms/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode, socketId, nickname })
      });
      if (res.status === 403) {
        sessionStorage.setItem('vanishchat_kicked', 'true');
        window.location.reload();
      }
    } catch (e) {
      console.error('Heartbeat error:', e);
    }
  };

  const poll = async () => {
    try {
      const res = await fetch(`/api/rooms/${roomCode}/updates`);
      if (res.status === 404) {
        clearInterval(pollingInterval);
        showToast('Room expired or has been deleted.', 'error');
        setTimeout(() => window.location.reload(), 2000);
        return;
      }
      const data = await res.json();
      if (!data.success) return;

      const inUsers = data.users.some(u => u.socketId === socketId);

      if (!inUsers && state.roomCode) {
        sessionStorage.setItem('vanishchat_kicked', 'true');
        window.location.reload();
        return;
      }

      state.files = data.files || [];
      state.hostSocketId = data.host;
      state.isHost = (socketId === data.host);

      const serverMuted = data.isMuted === true;
      if (serverMuted !== state.isMuted) {
        state.isMuted = serverMuted;
        if (state.isHost && el.muteRoomToggle) el.muteRoomToggle.checked = state.isMuted;
        updateInputState();
      }

      if (state.isHost && el.muteRoomWrapper && el.muteRoomToggle) {
        el.muteRoomWrapper.classList.remove('hidden');
      } else if (el.muteRoomWrapper) {
        el.muteRoomWrapper.classList.add('hidden');
      }

      // Update local state users only if changed to prevent DOM flickering
      const oldUsersJson = JSON.stringify(state.users);
      const newUsersJson = JSON.stringify(data.users);
      if (oldUsersJson !== newUsersJson) {
        state.users = data.users;
        updateUsersCountUI();
        renderAllUsers();
      }

      if (data.messages && data.messages.length !== lastKnownMessagesCount) {
        el.messagesContainer.innerHTML = '';
        data.messages.forEach(msg => appendMessage(msg));
        scrollToBottom();
        lastKnownMessagesCount = data.messages.length;
      }

      if (data.files && data.files.length !== lastKnownFilesCount) {
        renderAllFiles();
        lastKnownFilesCount = data.files.length;
      }
    } catch (e) {
      console.error('Polling error:', e);
    }
  };

  sendHeartbeat();
  poll();
  pollingInterval = setInterval(() => {
    poll();
    sendHeartbeat();
  }, 3000);
}

// --- View Router ---
function showView(view) {
  const panels = [el.landingView, el.chatView];
  panels.forEach(p => {
    if (p) {
      p.classList.remove('active');
      p.classList.add('hidden');
    }
  });

  let target = null;
  if (view === 'landing') target = el.landingView;
  else if (view === 'chat') target = el.chatView;

  if (target) {
    target.classList.remove('hidden');
    setTimeout(() => target.classList.add('active'), 50);
  }
}

// Set initial screen states
if (el.chatView) el.chatView.classList.add('hidden');

// --- Helper: Format File Size ---
function formatFileSize(bytes) {
  const numBytes = Number(bytes);
  if (isNaN(numBytes) || numBytes <= 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(numBytes) / Math.log(k));
  return parseFloat((numBytes / Math.pow(k, i)).toFixed(2)) + ' ' + (sizes[i] || 'Bytes');
}

// --- Helper: Select File Icon ---
function getFileIconSVG(mimeType) {
  if (!mimeType) mimeType = '';
  
  if (mimeType.startsWith('image/')) {
    return `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" /></svg>`;
  } else if (mimeType.startsWith('video/')) {
    return `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 10.362a.75.75 0 00-1.096-.662l-4.5 2.625a.75.75 0 000 1.324l4.5 2.625a.75.75 0 001.096-.662V10.36z" /></svg>`;
  } else if (mimeType.startsWith('audio/')) {
    return `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 9l10.5-3m0 0v11.25m0-11.25L9 9m0 0v11.25m0-11.25L4.5 12M9 20.25a3 3 0 11-6 0 3 3 0 016 0zm10.5-3a3 3 0 11-6 0 3 3 0 016 0z" /></svg>`;
  } else if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('text/')) {
    return `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>`;
  }
  return `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>`;
}

// --- Toast Notification System ---
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let icon = '';
  if (type === 'success') {
    icon = `<svg fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`;
  } else if (type === 'error') {
    icon = `<svg fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>`;
  } else {
    icon = `<svg fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 111.063.852l-.708 2.836a.75.75 0 001.063.852l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>`;
  }

  toast.innerHTML = `${icon}<span>${message}</span>`;
  el.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('animationend', () => toast.remove());
  }, 4000);
}

// --- Action: Create Room ---
async function handleCreateRoom() {
  const nickname = el.createNickname ? el.createNickname.value.trim() : '';
  if (!nickname) {
    showToast('Please enter your nickname.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/rooms/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname })
    });
    const response = await res.json();
    if (response.success && response.roomCode) {
      joinRoom(response.roomCode, nickname);
    } else {
      showToast(response.error || 'Failed to create room. Try again.', 'error');
    }
  } catch (error) {
    showToast('Network error creating room.', 'error');
  }
}

if (el.createForm) {
  el.createForm.addEventListener('submit', (e) => {
    e.preventDefault();
    handleCreateRoom();
  });
}

if (el.btnCreate) {
  el.btnCreate.addEventListener('click', (e) => {
    e.preventDefault();
    handleCreateRoom();
  });
}

// --- Action: Join Room ---
function handleJoinRoom() {
  const nickname = el.joinNickname ? el.joinNickname.value.trim() : '';
  const roomCode = el.joinCode ? el.joinCode.value.trim().toUpperCase() : '';
  
  if (!nickname) {
    showToast('Please enter your nickname.', 'error');
    return;
  }
  if (!roomCode) {
    showToast('Please enter a room code.', 'error');
    return;
  }

  joinRoom(roomCode, nickname);
}

if (el.joinForm) {
  el.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    handleJoinRoom();
  });
}

if (el.btnJoin) {
  el.btnJoin.addEventListener('click', (e) => {
    e.preventDefault();
    handleJoinRoom();
  });
}

// --- Action: Leave Room ---
el.btnLeave.addEventListener('click', async () => {
  if (!state.roomCode) return;
  try {
    await fetch('/api/rooms/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode: state.roomCode, socketId, nickname: state.nickname })
    });
  } catch (error) {
    console.error('Error leaving room:', error);
  }
  // Reset state and go to landing
  state.roomCode = null;
  state.users = [];
  state.files = [];
  state.isHost = false;
  state.hostSocketId = null;
  state.isLocked = false;
  
  if (pusher) {
    if (roomChannel) pusher.unsubscribe(roomChannel.name);
    if (hostChannel) pusher.unsubscribe(hostChannel.name);
  } else if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  
  showView('landing');
});

// --- Join Room Core Logic ---
async function joinRoom(roomCode, nickname) {
  try {
    const res = await fetch('/api/rooms/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode, nickname, socketId })
    });
    const response = await res.json();

    if (response.success) {
      setupRoom(response, nickname);
    } else {
      showToast(response.error || 'Failed to join room.', 'error');
    }
  } catch (error) {
    showToast('Network error joining room.', 'error');
  }
}

// Setup Room state & populate interface
function setupRoom(response, nickname) {
  state.roomCode = response.roomCode;
  state.nickname = nickname;
  state.users = response.users;
  state.files = response.files;
  state.hostSocketId = response.hostSocketId;
  state.isHost = (socketId === response.hostSocketId);
  state.isMuted = response.isMuted;

  // Set counts for polling comparison
  lastKnownMessagesCount = response.messages.length;
  lastKnownFilesCount = response.files.length;

  // Header Details
  el.displayRoomCode.innerText = response.roomCode;
  updateUsersCountUI();

  // Host panel config
  if (state.isHost) {
    el.muteRoomWrapper.classList.remove('hidden');
    el.muteRoomToggle.checked = state.isMuted;
  } else {
    el.muteRoomWrapper.classList.add('hidden');
  }

  updateInputState();

  // Draw Sidebar Feeds
  renderAllUsers();
  renderAllFiles();

  // Draw message history
  el.messagesContainer.innerHTML = '';
  response.messages.forEach(msg => {
    appendMessage(msg);
  });
  
  if (response.messages.length === 0) {
    appendSystemMessage('You joined the space. Welcome!');
  }

  showView('chat');
  showToast(`Joined Room: ${response.roomCode}`, 'success');
  scrollToBottom();

  // Real-time or polling setup
  if (pusher) {
    subscribeToHostEvents(state.roomCode, nickname);
    subscribeToRoomEvents(state.roomCode, nickname);
  } else {
    startPolling(state.roomCode, nickname);
  }
}

// --- Action: Send Message ---
async function sendMessage() {
  if (!state.roomCode) return;
  const text = el.messageInput ? el.messageInput.value.trim() : '';
  if (!text) return;

  if (state.isMuted && !state.isHost) {
    showToast('Admin Only Chat is enabled. Only the host can send messages.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/rooms/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode: state.roomCode, sender: state.nickname, text, socketId })
    });
    const result = await res.json();
    if (result.success) {
      el.messageInput.value = '';
      el.messageInput.focus();
    } else {
      showToast(result.error || 'Failed to send message.', 'error');
    }
  } catch (err) {
    showToast('Failed to send message.', 'error');
  }
}

if (el.chatForm) {
  el.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });
}

if (el.btnSend) {
  el.btnSend.addEventListener('click', (e) => {
    e.preventDefault();
    sendMessage();
  });
}

function updateInputState() {
  if (state.isMuted && !state.isHost) {
    el.messageInput.disabled = true;
    el.messageInput.placeholder = "Admin Only Chat enabled";
    el.btnAttach.disabled = true;
  } else {
    el.messageInput.disabled = false;
    el.messageInput.placeholder = "Type a message...";
    el.btnAttach.disabled = false;
  }
}

// --- UI Rendering Helpers ---
function updateUsersCountUI() {
  const count = state.users.length;
  el.activeUserCount.innerText = `${count} user${count !== 1 ? 's' : ''} online`;
}

function appendSystemMessage(text) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'system-message';
  msgDiv.innerHTML = `<p>${text}</p>`;
  el.messagesContainer.appendChild(msgDiv);
}

function appendMessage(msg) {
  const isSent = msg.sender === state.nickname;
  const isSys = msg.sender === 'System';
  
  const msgDiv = document.createElement('div');
  msgDiv.id = msg.id;
  
  if (isSys) {
    msgDiv.className = 'system-message';
    msgDiv.innerHTML = `<p>${msg.text}</p>`;
  } else {
    msgDiv.className = `message-bubble ${isSent ? 'sent' : 'received'}`;
    const formattedTime = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let fileAttachmentHtml = '';
    if (msg.file) {
      fileAttachmentHtml = `
        <a href="/api/download/${msg.file.id}" class="message-file-card" data-file-id="${msg.file.id}" target="_blank">
          <div class="file-card-icon">
            ${getFileIconSVG(msg.file.mimeType)}
          </div>
          <div class="file-card-details">
            <span class="file-card-name" title="${msg.file.originalName}">${msg.file.originalName}</span>
            <span class="file-card-size">${formatFileSize(msg.file.size)}</span>
          </div>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" style="width: 16px; height: 16px; margin-left: 8px; color: var(--text-muted);">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
        </a>
      `;
    }

    msgDiv.innerHTML = `
      <span class="sender">${isSent ? 'You' : msg.sender}</span>
      <div class="message-content">
        <p>${msg.text}</p>
        ${fileAttachmentHtml}
      </div>
      <span class="message-time">${formattedTime}</span>
    `;
  }
  el.messagesContainer.appendChild(msgDiv);
}

function renderAllUsers() {
  el.userCount.innerText = state.users.length;
  el.usersContainer.innerHTML = '';

  state.users.forEach(user => {
    const isUserSelf = user.socketId === socketId;
    const isUserHost = user.socketId === state.hostSocketId;

    const item = document.createElement('div');
    item.className = 'user-list-item';

    let roleBadges = '';
    if (isUserHost) {
      roleBadges += `<span class="user-role-badge role-host">Host</span>`;
    }
    if (isUserSelf) {
      roleBadges += `<span class="user-role-badge role-you">You</span>`;
    }

    let kickBtn = '';
    if (state.isHost && !isUserSelf) {
      kickBtn = `
        <button class="btn-kick" title="Kick User" data-socket-id="${user.socketId}">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      `;
    }

    item.innerHTML = `
      <div class="user-item-meta">
        <span class="user-item-name" title="${user.nickname}">${user.nickname}</span>
        ${roleBadges}
      </div>
      ${kickBtn}
    `;

    if (kickBtn) {
      item.querySelector('.btn-kick').addEventListener('click', async () => {
        if (confirm(`Are you sure you want to remove ${user.nickname} from this room?`)) {
          try {
            const res = await fetch('/api/rooms/kick-user', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ roomCode: state.roomCode, socketId, targetSocketId: user.socketId })
            });
            let result = {};
            try { result = await res.json(); } catch(e) {}
            if (res.ok && result.success) {
              state.users = state.users.filter(u => u.socketId !== user.socketId);
              updateUsersCountUI();
              renderAllUsers();
              showToast(`${user.nickname} was removed.`, 'success');
            } else {
              showToast(result.error || 'Failed to remove user.', 'error');
            }
          } catch (e) {
            showToast('Network error removing user.', 'error');
          }
        }
      });
    }

    el.usersContainer.appendChild(item);
  });
}

function renderAllFiles() {
  el.fileCount.innerText = state.files.length;
  
  if (state.files.length === 0) {
    el.filesContainer.innerHTML = `
      <div class="files-empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75Z" />
        </svg>
        <p>No files shared yet. Drag files into chat or click clip to upload.</p>
      </div>
    `;
    return;
  }

  el.filesContainer.innerHTML = '';
  state.files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
      <div class="file-icon">
        ${getFileIconSVG(file.mimeType)}
      </div>
      <div class="file-info">
        <h4 class="file-name" title="${file.originalName}">${file.originalName}</h4>
        <div class="file-meta">
          <span>By ${file.sender === state.nickname ? 'You' : file.sender}</span>
          <span>&bull;</span>
          <span>${formatFileSize(file.size)}</span>
        </div>
      </div>
      <a href="/api/download/${file.id}" target="_blank" class="file-download-btn" title="Download File">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
        </svg>
      </a>
    `;
    el.filesContainer.appendChild(item);
  });
}

function scrollToBottom() {
  el.messagesContainer.scrollTop = el.messagesContainer.scrollHeight;
}

// --- Action: Copy Code ---
el.btnCopyCode.addEventListener('click', () => {
  if (!state.roomCode) return;
  
  navigator.clipboard.writeText(state.roomCode).then(() => {
    const tooltip = el.btnCopyCode.querySelector('.tooltip-text');
    tooltip.innerText = 'Copied!';
    showToast('Room code copied to clipboard!', 'success');
    setTimeout(() => {
      tooltip.innerText = 'Copy';
    }, 2000);
  }).catch(err => {
    console.error('Failed to copy text:', err);
    showToast('Failed to copy. Double-click the code text.', 'error');
  });
});

// --- Action: Leave Room ---
el.btnLeave.addEventListener('click', async () => {
  if (confirm('Are you sure you want to leave the room? All messages and file links will be lost for this session.')) {
    try {
      await fetch('/api/rooms/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode: state.roomCode, socketId, nickname: state.nickname })
      });
    } catch (e) {
      console.error('Error leaving room:', e);
    }
    window.location.reload();
  }
});

// --- Action: Cancel Waiting Request ---
el.btnCancelWaiting.addEventListener('click', async () => {
  try {
    await fetch('/api/rooms/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode: state.roomCode, socketId, nickname: state.waitingNickname })
    });
  } catch (e) {
    console.error(e);
  }
  window.location.reload();
});

// --- Action: Toggle Room Mute (Admin Only Chat) ---
if (el.muteRoomToggle) {
  el.muteRoomToggle.addEventListener('change', async () => {
    const desiredMute = el.muteRoomToggle.checked;
    state.isMuted = desiredMute;
    updateInputState();
    try {
      const res = await fetch('/api/rooms/toggle-mute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode: state.roomCode, socketId, muted: desiredMute })
      });
      if (!res.ok) {
        state.isMuted = !desiredMute;
        el.muteRoomToggle.checked = !desiredMute;
        updateInputState();
        showToast('Failed to change mute state.', 'error');
      }
    } catch (e) {
      state.isMuted = !desiredMute;
      el.muteRoomToggle.checked = !desiredMute;
      updateInputState();
      showToast('Failed to change mute state.', 'error');
    }
  });
}

// --- File Upload Infrastructure ---
if (el.btnAttach && el.fileInput) {
  el.btnAttach.addEventListener('click', () => {
    el.fileInput.click();
  });

  el.fileInput.addEventListener('change', () => {
    if (el.fileInput.files.length > 0) {
      uploadFile(el.fileInput.files[0]);
    }
  });
}

// Drag and Drop Files inside Messages Feed
if (el.messagesContainer) {
  const feed = el.messagesContainer;

  ['dragenter', 'dragover'].forEach(eventName => {
    feed.addEventListener(eventName, (e) => {
      e.preventDefault();
      feed.style.backgroundColor = 'rgba(99, 102, 241, 0.05)';
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    feed.addEventListener(eventName, (e) => {
      e.preventDefault();
      feed.style.backgroundColor = '';
    }, false);
  });

  feed.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      uploadFile(files[0]);
    }
  });
}

async function uploadFile(file) {
  if (state.isMuted && !state.isHost) {
    showToast('Admin Only Chat is enabled. Only the host can share files.', 'error');
    if (el.fileInput) el.fileInput.value = '';
    return;
  }

  const maxBytes = 50 * 1024 * 1024;
  if (file.size > maxBytes) {
    showToast('File is too large. Capped at 50MB.', 'error');
    if (el.fileInput) el.fileInput.value = '';
    return;
  }

  if (el.uploadFilename) el.uploadFilename.innerText = file.name;
  if (el.uploadPercent) el.uploadPercent.innerText = '0%';
  if (el.uploadProgressBar) el.uploadProgressBar.style.width = '0%';
  if (el.uploadProgressPanel) el.uploadProgressPanel.classList.remove('hidden');

  try {
    const fileUrl = await uploadLocalMultipart(file);

    const res = await fetch('/api/rooms/file-shared', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomCode: state.roomCode,
        socketId: socketId,
        sender: state.nickname,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        url: fileUrl
      })
    });
    
    let fileRes;
    try {
      fileRes = await res.json();
    } catch (parseErr) {
      throw new Error(`Upload server error (${res.status}). Check backend logs.`);
    }

    if (fileRes.success) {
      showToast('File shared successfully!', 'success');
      if (fileRes.file) {
        state.files.push(fileRes.file);
        renderAllFiles();
        lastKnownFilesCount++;
      }
      if (fileRes.message) {
        appendMessage(fileRes.message);
        scrollToBottom();
        lastKnownMessagesCount++;
      }
    } else {
      showToast(fileRes.error || 'Failed to register shared file.', 'error');
    }
  } catch (err) {
    console.error('Upload failed:', err);
    showToast(err.message || 'Error uploading file.', 'error');
  } finally {
    el.uploadProgressPanel.classList.add('hidden');
    el.fileInput.value = '';
  }
}

function uploadLocalMultipart(file) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload', true);

    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) {
        const percentage = Math.round((e.loaded / e.total) * 100);
        el.uploadPercent.innerText = `${percentage}%`;
        el.uploadProgressBar.style.width = `${percentage}%`;
      }
    };

    xhr.onload = function () {
      if (xhr.status === 200) {
        let res;
        try { res = JSON.parse(xhr.responseText); } catch (e) {
          return reject(new Error('Server returned an unexpected response. Check server logs.'));
        }
        if (res.success) {
          resolve(res.url);
        } else {
          reject(new Error(res.error || 'Local upload failed.'));
        }
      } else {
        let res = {};
        try { res = JSON.parse(xhr.responseText); } catch (e) {}
        reject(new Error(res.error || `Upload failed with status ${xhr.status}.`));
      }
    };

    xhr.onerror = function () {
      reject(new Error('Network error during upload.'));
    };

    xhr.send(formData);
  });
}
