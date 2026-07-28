const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// Express App Setup
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure Uploads Directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    // Save file with a unique name
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// HTTP and Socket.io Server Setup
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// In-Memory Database
// Key: roomCode (string) -> Value: { code, createdAt, messages: [], files: [], users: Map(socket.id -> nickname) }
const rooms = new Map();

// Helper to generate room codes
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(code));
  return code;
}

// Clean up expired messages and files (Older than 1 hour = 3,600,000 ms)
const EXPIRATION_TIME = 60 * 60 * 1000; // 1 hour

function cleanupExpiredData() {
  const now = Date.now();
  console.log(`Running cleanup check at ${new Date().toISOString()}...`);

  rooms.forEach((room, roomCode) => {
    // 1. Clean up expired messages
    const expiredMessages = room.messages.filter(msg => now - msg.timestamp >= EXPIRATION_TIME);
    if (expiredMessages.length > 0) {
      room.messages = room.messages.filter(msg => now - msg.timestamp < EXPIRATION_TIME);
      // Notify room clients about expired messages
      expiredMessages.forEach(msg => {
        io.to(roomCode).emit('message-expired', { id: msg.id });
      });
      console.log(`Removed ${expiredMessages.length} expired messages in room ${roomCode}`);
    }

    // 2. Clean up expired files
    const expiredFiles = room.files.filter(file => now - file.timestamp >= EXPIRATION_TIME);
    if (expiredFiles.length > 0) {
      room.files = room.files.filter(file => now - file.timestamp < EXPIRATION_TIME);
      expiredFiles.forEach(file => {
        // Delete physical file
        fs.unlink(file.path, (err) => {
          if (err) {
            console.error(`Failed to delete expired file ${file.path}:`, err);
          } else {
            console.log(`Deleted physical file: ${file.originalName}`);
          }
        });
        // Notify room clients about expired file
        io.to(roomCode).emit('file-expired', { id: file.id });
      });
      console.log(`Removed ${expiredFiles.length} expired files in room ${roomCode}`);
    }

    // 3. Clean up empty & old rooms (inactive for more than 1 hour with no activity and no users)
    const activeUsersCount = room.users.size;
    const hasMessagesOrFiles = room.messages.length > 0 || room.files.length > 0;
    if (activeUsersCount === 0 && !hasMessagesOrFiles && (now - room.createdAt >= EXPIRATION_TIME)) {
      rooms.delete(roomCode);
      console.log(`Deleted empty/expired room: ${roomCode}`);
    }
  });
}

// Run cleanup check every 30 seconds
setInterval(cleanupExpiredData, 30000);

// API Endpoints
// File Upload Endpoint
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File is too large. Capped at 50MB.' });
      }
      return res.status(400).json({ error: err.message || 'File upload failed.' });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
      }

      const { roomCode, sender } = req.body;
      if (!roomCode || !rooms.has(roomCode)) {
        // Clean up uploaded file if room doesn't exist
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Invalid room code.' });
      }

      const room = rooms.get(roomCode);
      const fileId = 'file-' + Date.now() + '-' + Math.round(Math.random() * 1e9);
      
      const fileData = {
        id: fileId,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        path: req.file.path,
        sender: sender || 'Anonymous',
        timestamp: Date.now()
      };

      room.files.push(fileData);

      // Create a special chat message to announce file sharing
      const systemMessage = {
        id: 'msg-file-' + Date.now(),
        sender: 'System',
        text: `${sender || 'Someone'} shared a file: ${fileData.originalName}`,
        timestamp: Date.now(),
        file: {
          id: fileData.id,
          originalName: fileData.originalName,
          size: fileData.size,
          mimeType: fileData.mimeType
        }
      };
      room.messages.push(systemMessage);

      // Broadcast file and system message to room
      io.to(roomCode).emit('file-shared', { file: fileData, message: systemMessage });

      res.status(200).json({ success: true, file: fileData });
    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({ error: 'File upload failed.' });
    }
  });
});

// File Download Endpoint
app.get('/api/download/:fileId', (req, res) => {
  const { fileId } = req.params;
  let foundFile = null;

  // Search through all rooms to find the file
  for (const room of rooms.values()) {
    foundFile = room.files.find(f => f.id === fileId);
    if (foundFile) break;
  }

  if (!foundFile) {
    return res.status(404).send('File not found or has expired.');
  }

  // Check if file exists on disk
  if (!fs.existsSync(foundFile.path)) {
    return res.status(404).send('File missing from server.');
  }

  res.download(foundFile.path, foundFile.originalName);
});

// Socket.io Connection Logic
io.on('connection', (socket) => {
  // socket.roomCode and socket.nickname will hold the state for this socket

  // Handle Room Creation
  socket.on('create-room', ({ nickname }, callback) => {
    const code = generateRoomCode();
    const newRoom = {
      code: code,
      createdAt: Date.now(),
      messages: [],
      files: [],
      users: new Map(), // socket.id -> nickname
      host: null,       // socket.id of host
      isLocked: false,
      waitingLobby: new Map() // socket.id -> nickname
    };
    
    rooms.set(code, newRoom);
    callback({ success: true, roomCode: code });
  });

  // Handle Joining Room
  socket.on('join-room', ({ roomCode, nickname }, callback) => {
    const formattedCode = roomCode.toUpperCase().trim();
    if (!rooms.has(formattedCode)) {
      return callback({ success: false, error: 'Room does not exist or has expired.' });
    }

    const room = rooms.get(formattedCode);
    const cleanedNickname = nickname.trim() || 'Anonymous';

    // Prevent double join
    if (room.users.has(socket.id)) {
      return callback({ success: false, error: 'You are already in this room.' });
    }

    // Set first joiner as host
    if (!room.host) {
      room.host = socket.id;
    }

    // Check Lobby / Lock State
    if (room.isLocked && socket.id !== room.host) {
      room.waitingLobby.set(socket.id, cleanedNickname);
      // Notify host of knock request
      io.to(room.host).emit('lobby-knock', {
        socketId: socket.id,
        nickname: cleanedNickname
      });
      return callback({ success: true, status: 'waiting' });
    }

    // Approve join immediately (unlocked or is host)
    socket.roomCode = formattedCode;
    socket.nickname = cleanedNickname;
    room.users.set(socket.id, cleanedNickname);

    socket.join(formattedCode);

    // Get active messages and files
    const now = Date.now();
    const activeMessages = room.messages.filter(msg => now - msg.timestamp < EXPIRATION_TIME);
    const activeFiles = room.files.filter(file => now - file.timestamp < EXPIRATION_TIME).map(f => ({
      id: f.id,
      originalName: f.originalName,
      size: f.size,
      mimeType: f.mimeType,
      sender: f.sender,
      timestamp: f.timestamp
    }));

    const userList = Array.from(room.users.entries()).map(([id, name]) => ({
      socketId: id,
      nickname: name
    }));

    callback({
      success: true,
      status: 'approved',
      roomCode: formattedCode,
      messages: activeMessages,
      files: activeFiles,
      users: userList,
      hostSocketId: room.host,
      isLocked: room.isLocked
    });

    // Notify other users in the room
    socket.to(formattedCode).emit('user-joined', {
      nickname: cleanedNickname,
      socketId: socket.id,
      users: userList,
      systemMessage: {
        id: 'msg-sys-' + Date.now(),
        sender: 'System',
        text: `${cleanedNickname} joined the room.`,
        timestamp: Date.now()
      }
    });
  });

  // Handle Waiting User Approval (from Host)
  socket.on('approve-join', ({ targetSocketId, approved }) => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms.has(roomCode)) return;

    const room = rooms.get(roomCode);
    if (socket.id !== room.host) return; // Only host approves

    if (!room.waitingLobby.has(targetSocketId)) return;

    const targetNickname = room.waitingLobby.get(targetSocketId);
    room.waitingLobby.delete(targetSocketId);

    const targetSocket = io.sockets.sockets.get(targetSocketId);

    if (approved) {
      if (targetSocket) {
        targetSocket.roomCode = roomCode;
        targetSocket.nickname = targetNickname;
        room.users.set(targetSocketId, targetNickname);
        targetSocket.join(roomCode);

        const now = Date.now();
        const activeMessages = room.messages.filter(msg => now - msg.timestamp < EXPIRATION_TIME);
        const activeFiles = room.files.filter(file => now - file.timestamp < EXPIRATION_TIME).map(f => ({
          id: f.id,
          originalName: f.originalName,
          size: f.size,
          mimeType: f.mimeType,
          sender: f.sender,
          timestamp: f.timestamp
        }));

        const userList = Array.from(room.users.entries()).map(([id, name]) => ({
          socketId: id,
          nickname: name
        }));

        // Send approval to wait user
        targetSocket.emit('join-approved', {
          roomCode: roomCode,
          messages: activeMessages,
          files: activeFiles,
          users: userList,
          hostSocketId: room.host,
          isLocked: room.isLocked
        });

        // Broadcast user joined to other users
        targetSocket.to(roomCode).emit('user-joined', {
          nickname: targetNickname,
          socketId: targetSocketId,
          users: userList,
          systemMessage: {
            id: 'msg-sys-' + Date.now(),
            sender: 'System',
            text: `${targetNickname} joined the room.`,
            timestamp: Date.now()
          }
        });
      }
    } else {
      // Decline user request
      if (targetSocket) {
        targetSocket.emit('join-declined', { reason: 'Your request to join was declined by the host.' });
      }
    }
    
    // Clean up host list
    socket.emit('lobby-resolved', { socketId: targetSocketId });
  });

  // Handle Room Lock Toggle (from Host)
  socket.on('toggle-lock', ({ locked }) => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms.has(roomCode)) return;

    const room = rooms.get(roomCode);
    if (socket.id !== room.host) return;

    room.isLocked = !!locked;
    
    io.to(roomCode).emit('lock-status-changed', { isLocked: room.isLocked });

    // System announce in chat
    const systemMessage = {
      id: 'msg-sys-lock-' + Date.now(),
      sender: 'System',
      text: `Room has been ${room.isLocked ? 'locked (waiting lobby enabled)' : 'unlocked'}.`,
      timestamp: Date.now()
    };
    room.messages.push(systemMessage);
    io.to(roomCode).emit('message-received', systemMessage);
  });

  // Handle Kick User (from Host)
  socket.on('kick-user', ({ targetSocketId }) => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms.has(roomCode)) return;

    const room = rooms.get(roomCode);
    if (socket.id !== room.host) return;

    if (!room.users.has(targetSocketId)) return;

    const targetNickname = room.users.get(targetSocketId);
    room.users.delete(targetSocketId);

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('kicked');
      targetSocket.leave(roomCode);
      targetSocket.roomCode = null;
      targetSocket.nickname = null;
    }

    const userList = Array.from(room.users.entries()).map(([id, name]) => ({
      socketId: id,
      nickname: name
    }));

    io.to(roomCode).emit('user-left', {
      nickname: targetNickname,
      users: userList,
      systemMessage: {
        id: 'msg-sys-kick-' + Date.now(),
        sender: 'System',
        text: `${targetNickname} was removed by the host.`,
        timestamp: Date.now()
      }
    });
  });

  // Handle Chat Message
  socket.on('send-message', ({ text }) => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms.has(roomCode)) return;

    const room = rooms.get(roomCode);
    const message = {
      id: 'msg-' + Date.now() + '-' + Math.round(Math.random() * 1e9),
      sender: socket.nickname,
      text: text,
      timestamp: Date.now()
    };

    room.messages.push(message);

    // Broadcast message to room
    io.to(roomCode).emit('message-received', message);
  });

  // Handle User Disconnect
  socket.on('disconnect', () => {
    // Check wait lobby
    rooms.forEach((room, roomCode) => {
      if (room.waitingLobby.has(socket.id)) {
        room.waitingLobby.delete(socket.id);
        io.to(room.host).emit('lobby-left', { socketId: socket.id });
      }
    });

    const roomCode = socket.roomCode;
    if (roomCode && rooms.has(roomCode)) {
      const room = rooms.get(roomCode);
      room.users.delete(socket.id);

      const userList = Array.from(room.users.entries()).map(([id, name]) => ({
        socketId: id,
        nickname: name
      }));

      // Host transfer check
      let hostTransferred = false;
      let newHostName = '';
      if (socket.id === room.host) {
        if (room.users.size > 0) {
          const nextHostId = room.users.keys().next().value;
          room.host = nextHostId;
          newHostName = room.users.get(nextHostId);
          hostTransferred = true;
        } else {
          room.host = null;
        }
      }

      socket.to(roomCode).emit('user-left', {
        nickname: socket.nickname,
        users: userList,
        systemMessage: {
          id: 'msg-sys-left-' + Date.now(),
          sender: 'System',
          text: `${socket.nickname} left the room.`,
          timestamp: Date.now()
        }
      });

      if (hostTransferred && room.host) {
        io.to(roomCode).emit('host-transferred', {
          hostSocketId: room.host,
          nickname: newHostName,
          systemMessage: {
            id: 'msg-sys-host-' + Date.now(),
            sender: 'System',
            text: `${newHostName} is now the room host.`,
            timestamp: Date.now()
          }
        });
      }

      // If room is empty, clear it
      if (room.users.size === 0 && room.messages.length === 0 && room.files.length === 0) {
        rooms.delete(roomCode);
      }
    }
  });
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
