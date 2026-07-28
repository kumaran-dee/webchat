// Connect to Socket.io (Served from same host)
const socket = io();

// Check if kicked recently (Genius UX check across reload)
if (sessionStorage.getItem('vanishchat_kicked') === 'true') {
  sessionStorage.removeItem('vanishchat_kicked');
  setTimeout(() => {
    showToast('You were removed from the room by the host.', 'error');
  }, 300);
}

// Application State
let state = {
  roomCode: null,
  nickname: null,
  users: [], // Array of objects: { socketId, nickname }
  files: [],
  isHost: false,
  hostSocketId: null,
  isLocked: false,
  waitingNickname: null
};

// DOM Elements
const el = {
  // Views
  landingView: document.getElementById('landing-view'),
  chatView: document.getElementById('chat-view'),
  waitingView: document.getElementById('waiting-view'),
  waitNickname: document.getElementById('wait-nickname'),
  btnCancelWaiting: document.getElementById('btn-cancel-waiting'),
  connectionStatus: document.getElementById('connection-status'),
  statusPulse: document.querySelector('.pulse-dot'),

  // Forms & Inputs
  createForm: document.getElementById('create-form'),
  createNickname: document.getElementById('create-nickname'),
  joinForm: document.getElementById('join-form'),
  joinNickname: document.getElementById('join-nickname'),
  joinCode: document.getElementById('join-code'),

  // Chat Area Header
  displayRoomCode: document.getElementById('display-room-code'),
  btnCopyCode: document.getElementById('btn-copy-code'),
  lockRoomWrapper: document.getElementById('lock-room-wrapper'),
  lockRoomToggle: document.getElementById('lock-room-toggle'),
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
  fileInput: document.getElementById('file-input'),
  btnAttach: document.getElementById('btn-attach'),

  // Upload Progress
  uploadProgressPanel: document.getElementById('upload-progress-panel'),
  uploadFilename: document.getElementById('upload-filename'),
  uploadPercent: document.getElementById('upload-percent'),
  uploadProgressBar: document.getElementById('upload-progress-bar'),

  // Toast & Knock requests
  toastContainer: document.getElementById('toast-container'),
  lobbyRequestsContainer: document.getElementById('lobby-requests-container')
};

// --- View Router ---
function showView(view) {
  const panels = [el.landingView, el.chatView, el.waitingView];
  panels.forEach(p => {
    if (p) {
      p.classList.remove('active');
      p.classList.add('hidden');
    }
  });

  let target = null;
  if (view === 'landing') target = el.landingView;
  else if (view === 'chat') target = el.chatView;
  else if (view === 'waiting') target = el.waitingView;

  if (target) {
    target.classList.remove('hidden');
    setTimeout(() => target.classList.add('active'), 50);
  }
}

// Set initial screen states
el.chatView.classList.add('hidden');
el.waitingView.classList.add('hidden');

// --- Helper: Format File Size ---
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
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
    icon = `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`;
  } else if (type === 'error') {
    icon = `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>`;
  } else {
    icon = `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 111.063.852l-.708 2.836a.75.75 0 001.063.852l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" /></svg>`;
  }

  toast.innerHTML = `${icon}<span>${message}</span>`;
  el.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('animationend', () => toast.remove());
  }, 4000);
}

// --- Connection Status Indicators ---
socket.on('connect', () => {
  el.connectionStatus.innerText = 'Connected';
  el.statusPulse.style.backgroundColor = 'var(--success)';
  el.statusPulse.style.boxShadow = '0 0 8px var(--success)';
});

socket.on('disconnect', () => {
  el.connectionStatus.innerText = 'Disconnected. Retrying...';
  el.statusPulse.style.backgroundColor = 'var(--danger)';
  el.statusPulse.style.boxShadow = '0 0 8px var(--danger)';
  showToast('Connection to server lost. Trying to reconnect...', 'error');
});

// --- Action: Create Room ---
el.createForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nickname = el.createNickname.value.trim();
  if (!nickname) return;

  socket.emit('create-room', { nickname }, (response) => {
    if (response.success) {
      joinRoom(response.roomCode, nickname);
    } else {
      showToast('Failed to create room. Try again.', 'error');
    }
  });
});

// --- Action: Join Room ---
el.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nickname = el.joinNickname.value.trim();
  const roomCode = el.joinCode.value.trim().toUpperCase();
  
  if (!nickname || !roomCode) return;
  joinRoom(roomCode, nickname);
});

// --- Join Room Core Logic ---
function joinRoom(roomCode, nickname) {
  socket.emit('join-room', { roomCode, nickname }, (response) => {
    if (response.success) {
      if (response.status === 'waiting') {
        state.waitingNickname = nickname;
        el.waitNickname.innerText = nickname;
        showView('waiting');
        showToast('Room is locked. Waiting for host approval...', 'info');
        return;
      }
      setupRoom(response, nickname);
    } else {
      showToast(response.error || 'Failed to join room.', 'error');
    }
  });
}

// Setup Room state & populate interface
function setupRoom(response, nickname) {
  state.roomCode = response.roomCode;
  state.nickname = nickname;
  state.users = response.users;
  state.files = response.files;
  state.hostSocketId = response.hostSocketId;
  state.isHost = (socket.id === response.hostSocketId);
  state.isLocked = response.isLocked;

  // Header Details
  el.displayRoomCode.innerText = response.roomCode;
  updateUsersCountUI();

  // Host panel config
  if (state.isHost) {
    el.lockRoomWrapper.classList.remove('hidden');
    el.lockRoomToggle.checked = state.isLocked;
  } else {
    el.lockRoomWrapper.classList.add('hidden');
  }

  // Draw Sidebar Feeds
  renderAllUsers();
  renderAllFiles();

  // Draw message history
  el.messagesContainer.innerHTML = '';
  response.messages.forEach(msg => {
    appendMessage(msg);
  });
  
  if (response.messages.length === 0) {
    appendSystemMessage('You joined the ephemeral space. Welcome!');
  }

  showView('chat');
  showToast(`Joined Room: ${response.roomCode}`, 'success');
  scrollToBottom();
}

// --- Action: Send Message ---
el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.messageInput.value.trim();
  if (!text) return;

  socket.emit('send-message', { text });
  el.messageInput.value = '';
  el.messageInput.focus();
});

// --- Socket Event Listeners ---
socket.on('user-joined', (data) => {
  state.users = data.users;
  updateUsersCountUI();
  renderAllUsers();
  appendSystemMessage(data.systemMessage.text);
  showToast(`${data.nickname} joined the room.`, 'info');
});

socket.on('user-left', (data) => {
  state.users = data.users;
  updateUsersCountUI();
  renderAllUsers();
  appendSystemMessage(data.systemMessage.text);
  showToast(`${data.nickname} left the room.`, 'info');
});

socket.on('message-received', (message) => {
  appendMessage(message);
  scrollToBottom();
});

socket.on('file-shared', (data) => {
  state.files.push(data.file);
  renderAllFiles();
  appendMessage(data.message);
  scrollToBottom();
  showToast(`${data.file.sender} uploaded: ${data.file.originalName}`, 'success');
});

// Real-time Expiration Listeners
socket.on('message-expired', (data) => {
  const msgEl = document.getElementById(data.id);
  if (msgEl) {
    msgEl.style.transition = 'all 0.5s ease';
    msgEl.style.opacity = '0';
    msgEl.style.transform = 'translateY(-10px)';
    msgEl.style.maxHeight = '0';
    msgEl.style.padding = '0';
    msgEl.style.margin = '0';
    setTimeout(() => msgEl.remove(), 500);
  }
});

socket.on('file-expired', (data) => {
  state.files = state.files.filter(f => f.id !== data.id);
  renderAllFiles();

  const attachLink = document.querySelector(`[data-file-id="${data.id}"]`);
  if (attachLink) {
    attachLink.style.pointerEvents = 'none';
    attachLink.style.opacity = '0.4';
    attachLink.querySelector('.file-card-size').innerText = 'Expired and deleted';
  }
  showToast('A shared file has expired and was deleted.', 'info');
});

// Wait lobby status approvals
socket.on('join-approved', (data) => {
  setupRoom(data, state.waitingNickname);
  state.waitingNickname = null;
  showToast('Host approved your join request!', 'success');
});

socket.on('join-declined', (data) => {
  showView('landing');
  showToast(data.reason || 'Your join request was declined by the host.', 'error');
  state.waitingNickname = null;
});

socket.on('kicked', () => {
  sessionStorage.setItem('vanishchat_kicked', 'true');
  window.location.reload();
});

socket.on('lock-status-changed', (data) => {
  state.isLocked = data.isLocked;
  el.lockRoomToggle.checked = data.isLocked;
});

socket.on('host-transferred', (data) => {
  state.hostSocketId = data.hostSocketId;
  state.isHost = (socket.id === data.hostSocketId);
  
  if (state.isHost) {
    el.lockRoomWrapper.classList.remove('hidden');
    el.lockRoomToggle.checked = state.isLocked;
    showToast('You are now the room host!', 'success');
  } else {
    el.lockRoomWrapper.classList.add('hidden');
  }

  renderAllUsers();
  appendSystemMessage(data.systemMessage.text);
});

// Host lobby requests listeners
socket.on('lobby-knock', (data) => {
  if (document.getElementById(`knock-req-${data.socketId}`)) return;

  const card = document.createElement('div');
  card.className = 'request-card';
  card.id = `knock-req-${data.socketId}`;
  card.innerHTML = `
    <div class="request-info">
      <strong>${data.nickname}</strong> wants to join the chat
    </div>
    <div class="request-actions">
      <button class="btn-approve btn-approve-accept">Accept</button>
      <button class="btn-approve btn-approve-decline">Decline</button>
    </div>
  `;

  card.querySelector('.btn-approve-accept').addEventListener('click', () => {
    socket.emit('approve-join', { targetSocketId: data.socketId, approved: true });
  });
  card.querySelector('.btn-approve-decline').addEventListener('click', () => {
    socket.emit('approve-join', { targetSocketId: data.socketId, approved: false });
  });

  el.lobbyRequestsContainer.appendChild(card);
  showToast(`Entry request from ${data.nickname}`, 'info');
});

socket.on('lobby-left', (data) => {
  const card = document.getElementById(`knock-req-${data.socketId}`);
  if (card) card.remove();
});

socket.on('lobby-resolved', (data) => {
  const card = document.getElementById(`knock-req-${data.socketId}`);
  if (card) card.remove();
});

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
    const isUserSelf = user.socketId === socket.id;
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
    // Show kick button if current user is host AND target user is NOT self
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

    // Bind kick listener
    if (kickBtn) {
      item.querySelector('.btn-kick').addEventListener('click', () => {
        if (confirm(`Are you sure you want to kick ${user.nickname} from this room?`)) {
          socket.emit('kick-user', { targetSocketId: user.socketId });
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
el.btnLeave.addEventListener('click', () => {
  if (confirm('Are you sure you want to leave the room? All messages and file links will be lost for this session.')) {
    window.location.reload();
  }
});

// --- Action: Cancel Waiting Request ---
el.btnCancelWaiting.addEventListener('click', () => {
  window.location.reload();
});

// --- Action: Toggle Room Lock ---
el.lockRoomToggle.addEventListener('change', () => {
  socket.emit('toggle-lock', { locked: el.lockRoomToggle.checked });
});

// --- File Upload Infrastructure ---
el.btnAttach.addEventListener('click', () => {
  el.fileInput.click();
});

el.fileInput.addEventListener('change', () => {
  if (el.fileInput.files.length > 0) {
    uploadFile(el.fileInput.files[0]);
  }
});

// Drag and Drop Files inside Messages Feed
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

function uploadFile(file) {
  const maxBytes = 50 * 1024 * 1024;
  if (file.size > maxBytes) {
    showToast('File is too large. Capped at 50MB.', 'error');
    el.fileInput.value = '';
    return;
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('roomCode', state.roomCode);
  formData.append('sender', state.nickname);

  el.uploadFilename.innerText = file.name;
  el.uploadPercent.innerText = '0%';
  el.uploadProgressBar.style.width = '0%';
  el.uploadProgressPanel.classList.remove('hidden');

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
    el.uploadProgressPanel.classList.add('hidden');
    el.fileInput.value = '';

    if (xhr.status === 200) {
      const res = JSON.parse(xhr.responseText);
      if (res.success) {
        showToast('File shared successfully!', 'success');
      } else {
        showToast(res.error || 'Failed to upload file.', 'error');
      }
    } else {
      const res = JSON.parse(xhr.responseText || '{}');
      showToast(res.error || 'Error uploading file to server.', 'error');
    }
  };

  xhr.onerror = function () {
    el.uploadProgressPanel.classList.add('hidden');
    el.fileInput.value = '';
    showToast('Network error during file upload.', 'error');
  };

  xhr.send(formData);
}
