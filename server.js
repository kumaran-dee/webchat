import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import Pusher from 'pusher';
import { Redis } from '@upstash/redis';
import { del } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Express App Setup
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure Local Uploads Directory exists (for local fallback)
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!process.env.VERCEL && !fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Vercel/serverless: must NOT write to filesystem — use memory storage
// Local dev: can use disk storage for convenience
const isVercel = !!process.env.VERCEL;
const storage = isVercel
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, UPLOADS_DIR),
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
      }
    });

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB hard limit
});

// --- Mock Redis for Local Development ---
class MockRedis {
  constructor() {
    this.store = new Map();
    this.ttls = new Map();
  }

  async exists(key) {
    this._checkExpired(key);
    return this.store.has(key) ? 1 : 0;
  }

  async hset(key, fieldOrObj, value) {
    this._checkExpired(key);
    if (!this.store.has(key)) this.store.set(key, {});
    const data = this.store.get(key);
    if (typeof fieldOrObj === 'object') {
      Object.assign(data, fieldOrObj);
    } else {
      data[fieldOrObj] = value;
    }
  }

  async hgetall(key) {
    this._checkExpired(key);
    return this.store.get(key) || null;
  }

  async hget(key, field) {
    this._checkExpired(key);
    const data = this.store.get(key);
    return data ? data[field] : null;
  }

  async hdel(key, field) {
    this._checkExpired(key);
    const data = this.store.get(key);
    if (data) delete data[field];
  }

  async del(key) {
    this.store.delete(key);
    this.ttls.delete(key);
  }

  async rpush(key, value) {
    this._checkExpired(key);
    if (!this.store.has(key)) this.store.set(key, []);
    const arr = this.store.get(key);
    arr.push(value);
  }

  async lrange(key, start, stop) {
    this._checkExpired(key);
    const arr = this.store.get(key) || [];
    if (stop === -1) return arr.slice(start);
    return arr.slice(start, stop + 1);
  }

  async expire(key, seconds) {
    this.ttls.set(key, Date.now() + seconds * 1000);
  }

  async set(key, value) {
    this._checkExpired(key);
    this.store.set(key, value);
  }

  async get(key) {
    this._checkExpired(key);
    const val = this.store.get(key);
    return (val !== undefined && typeof val !== 'object') ? val : null;
  }

  _checkExpired(key) {
    if (this.ttls.has(key) && Date.now() > this.ttls.get(key)) {
      this.store.delete(key);
      this.store.delete(`${key}:messages`);
      this.store.delete(`${key}:files`);
      this.store.delete(`${key}:users`);
      this.store.delete(`${key}:lobby`);
      this.store.delete(`${key}:kicked`);
      this.ttls.delete(key);
    }
  }
}

// --- Initialize Database & Real-time Clients ---
const isRedisConfigured = !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL);
const redis = isRedisConfigured
  ? new Redis({
      url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : new MockRedis();

if (!isRedisConfigured) {
  console.log('Using in-memory Mock Redis for local development.');
}

const isPusherConfigured = !!(process.env.PUSHER_APP_ID && process.env.PUSHER_KEY && process.env.PUSHER_SECRET);
const pusher = isPusherConfigured
  ? new Pusher({
      appId: process.env.PUSHER_APP_ID,
      key: process.env.PUSHER_KEY,
      secret: process.env.PUSHER_SECRET,
      cluster: process.env.PUSHER_CLUSTER,
      useTLS: true,
    })
  : null;

if (!isPusherConfigured) {
  console.warn('Pusher credentials missing. Real-time functions will fall back to polling.');
}

// Constant configuration
const EXPIRATION_TIME = 60 * 60 * 1000; // 1 hour

// Helper to generate room codes
async function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  let exists = true;
  while (exists) {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    exists = await redis.exists(`room:${code}`);
  }
  return code;
}

// Helper to trigger Pusher events
async function triggerEvent(channel, event, data) {
  if (pusher) {
    try {
      await pusher.trigger(channel, event, data);
    } catch (err) {
      console.error(`Pusher trigger error:`, err);
    }
  }
}

// --- API Endpoints ---

// 1. Get Application Configuration
app.get('/api/config', (req, res) => {
  res.json({
    useVercelBlob: !!process.env.BLOB_READ_WRITE_TOKEN,
    pusherKey: process.env.PUSHER_KEY || null,
    pusherCluster: process.env.PUSHER_CLUSTER || null,
    isRedisConfigured: isRedisConfigured,
    envKeys: Object.keys(process.env)
  });
});

// 2. Create Room
app.post('/api/rooms/create', async (req, res) => {
  try {
    const { nickname } = req.body;
    if (!nickname) {
      return res.status(400).json({ error: 'Nickname is required.' });
    }

    const code = await generateRoomCode();
    const roomKey = `room:${code}`;

    await redis.hset(roomKey, {
      code: code,
      createdAt: Date.now().toString(),
      isLocked: 'false',
      isMuted: 'false',
      host: '' // Will be set when host joins/authenticates
    });
    
    // Set 1 hour TTL
    await redis.expire(roomKey, 3600);
    await redis.expire(`${roomKey}:messages`, 3600);
    await redis.expire(`${roomKey}:files`, 3600);
    await redis.expire(`${roomKey}:users`, 3600);
    await redis.expire(`${roomKey}:lobby`, 3600);

    res.status(200).json({ success: true, roomCode: code });
  } catch (error) {
    console.error('Create room error:', error);
    res.status(500).json({ error: 'Failed to create room.' });
  }
});

// 3. Join Room
app.post('/api/rooms/join', async (req, res) => {
  try {
    const { roomCode, nickname, socketId } = req.body;
    const formattedCode = roomCode.toUpperCase().trim();
    const roomKey = `room:${formattedCode}`;

    const exists = await redis.exists(roomKey);
    if (!exists) {
      return res.status(400).json({ error: 'Room does not exist or has expired.' });
    }

    const room = await redis.hgetall(roomKey);
    const isKicked = await redis.hget(`${roomKey}:kicked`, socketId);
    if (isKicked === 'true') {
      return res.status(403).json({ error: 'You were removed from this room by the host.' });
    }

    const isLocked = room.isLocked === 'true';
    let host = room.host;

    // Set first joiner as host
    if (!host) {
      host = socketId;
      await redis.hset(roomKey, { host: host });
    }

    // Approve join immediately
    await redis.hset(`${roomKey}:users`, { [socketId]: nickname });

    // Get messages & files
    const messagesRaw = await redis.lrange(`${roomKey}:messages`, 0, -1);
    const filesRaw = await redis.lrange(`${roomKey}:files`, 0, -1);

    const now = Date.now();
    const messages = messagesRaw.map(m => typeof m === 'string' ? JSON.parse(m) : m)
                                .filter(m => now - m.timestamp < EXPIRATION_TIME);
    const files = filesRaw.map(f => typeof f === 'string' ? JSON.parse(f) : f)
                          .filter(f => now - f.timestamp < EXPIRATION_TIME);

    const usersMap = await redis.hgetall(`${roomKey}:users`) || {};
    const userList = Object.entries(usersMap).map(([id, name]) => ({
      socketId: id,
      nickname: name
    }));

    // Notify others in room
    await triggerEvent(`presence-room-${formattedCode}`, 'user-joined', {
      nickname: nickname,
      socketId: socketId,
      users: userList,
      systemMessage: {
        id: 'msg-sys-' + Date.now(),
        sender: 'System',
        text: `${nickname} joined the room.`,
        timestamp: Date.now()
      }
    });

    res.status(200).json({
      success: true,
      status: 'approved',
      roomCode: formattedCode,
      messages: messages,
      files: files,
      users: userList,
      hostSocketId: host,
      isMuted: room.isMuted === 'true'
    });
  } catch (error) {
    console.error('Join room error:', error);
    res.status(500).json({ error: 'Failed to join room.' });
  }
});

// 4. Send Message
app.post('/api/rooms/message', async (req, res) => {
  try {
    const { roomCode, sender, text, socketId } = req.body;
    const formattedCode = roomCode.toUpperCase().trim();
    const roomKey = `room:${formattedCode}`;

    const exists = await redis.exists(roomKey);
    if (!exists) {
      return res.status(400).json({ error: 'Room does not exist or has expired.' });
    }

    const room = await redis.hgetall(roomKey);
    if (room.isMuted === 'true' && socketId !== room.host) {
      return res.status(403).json({ error: 'Host only messaging is enabled.' });
    }

    const message = {
      id: 'msg-' + Date.now() + '-' + Math.round(Math.random() * 1e9),
      sender: sender,
      text: text,
      timestamp: Date.now()
    };

    await redis.rpush(`${roomKey}:messages`, JSON.stringify(message));
    
    // Broadcast message
    await triggerEvent(`presence-room-${formattedCode}`, 'message-received', message);

    res.status(200).json({ success: true, message });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message.' });
  }
});



// 5. Toggle Admin-Only Chat Mute
app.post('/api/rooms/toggle-mute', async (req, res) => {
  try {
    const { roomCode, socketId, muted } = req.body;
    const formattedCode = roomCode.toUpperCase().trim();
    const roomKey = `room:${formattedCode}`;

    const host = await redis.hget(roomKey, 'host');
    if (socketId !== host) {
      return res.status(403).json({ error: 'Only the host can toggle Admin-Only chat.' });
    }

    const isMutedStr = muted ? 'true' : 'false';
    await redis.hset(roomKey, { isMuted: isMutedStr });

    const systemMessage = {
      id: 'msg-sys-mute-' + Date.now(),
      sender: 'System',
      text: muted ? 'Admin Only Chat enabled. Only the host can send messages and files.' : 'Admin Only Chat disabled. Everyone can send messages and files.',
      timestamp: Date.now()
    };

    await redis.rpush(`${roomKey}:messages`, JSON.stringify(systemMessage));

    await triggerEvent(`presence-room-${formattedCode}`, 'mute-status-changed', { isMuted: muted });
    await triggerEvent(`presence-room-${formattedCode}`, 'message-received', systemMessage);

    res.status(200).json({ success: true, isMuted: muted });
  } catch (error) {
    console.error('Toggle mute error:', error);
    res.status(500).json({ error: 'Failed to toggle mute state.' });
  }
});
app.post('/api/rooms/kick-user', async (req, res) => {
  try {
    const { roomCode, socketId, targetSocketId } = req.body;
    const formattedCode = roomCode.toUpperCase().trim();
    const roomKey = `room:${formattedCode}`;

    const host = await redis.hget(roomKey, 'host');
    if (socketId !== host) {
      return res.status(403).json({ error: 'Unauthorized.' });
    }

    const targetNickname = await redis.hget(`${roomKey}:users`, targetSocketId);
    if (!targetNickname) {
      return res.status(400).json({ error: 'User is not in the room.' });
    }

    await redis.hdel(`${roomKey}:users`, targetSocketId);
    await redis.hset(`${roomKey}:kicked`, { [targetSocketId]: 'true' });
    await redis.expire(`${roomKey}:kicked`, 3600);

    const usersMap = await redis.hgetall(`${roomKey}:users`) || {};
    const userList = Object.entries(usersMap).map(([id, name]) => ({
      socketId: id,
      nickname: name
    }));

    // Trigger kicked event for target user
    await triggerEvent(`private-host-${targetSocketId}`, 'kicked', {});

    // Broadcast to room
    await triggerEvent(`presence-room-${formattedCode}`, 'user-left', {
      nickname: targetNickname,
      users: userList,
      systemMessage: {
        id: 'msg-sys-kick-' + Date.now(),
        sender: 'System',
        text: `${targetNickname} was removed by the host.`,
        timestamp: Date.now()
      }
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Kick user error:', error);
    res.status(500).json({ error: 'Failed to kick user.' });
  }
});

// 8. User Heartbeat & Leave logic
app.post('/api/rooms/heartbeat', async (req, res) => {
  try {
    const { roomCode, socketId, nickname } = req.body;
    const formattedCode = roomCode.toUpperCase().trim();
    const roomKey = `room:${formattedCode}`;

    const isKicked = await redis.hget(`${roomKey}:kicked`, socketId);
    if (isKicked === 'true') {
      await redis.hdel(`${roomKey}:users`, socketId);
      return res.status(403).json({ success: false, kicked: true });
    }

    if (await redis.exists(roomKey)) {
      await redis.hset(`${roomKey}:users`, { [socketId]: nickname });
    }
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/rooms/leave', async (req, res) => {
  try {
    const { roomCode, socketId, nickname } = req.body;
    const formattedCode = roomCode.toUpperCase().trim();
    const roomKey = `room:${formattedCode}`;

    if (!(await redis.exists(roomKey))) {
      return res.status(200).json({ success: true });
    }

    await redis.hdel(`${roomKey}:users`, socketId);
    await redis.hdel(`${roomKey}:lobby`, socketId);

    const usersMap = await redis.hgetall(`${roomKey}:users`) || {};
    const remainingUsers = Object.entries(usersMap);

    const userList = remainingUsers.map(([id, name]) => ({
      socketId: id,
      nickname: name
    }));

    let host = await redis.hget(roomKey, 'host');
    let hostTransferred = false;
    let newHostName = '';

    if (socketId === host) {
      if (remainingUsers.length > 0) {
        const nextHostId = remainingUsers[0][0];
        newHostName = remainingUsers[0][1];
        await redis.hset(roomKey, { host: nextHostId });
        host = nextHostId;
        hostTransferred = true;
      } else {
        await redis.hdel(roomKey, 'host');
        host = null;
      }
    }

    // Broadcast user left
    await triggerEvent(`presence-room-${formattedCode}`, 'user-left', {
      nickname: nickname,
      users: userList,
      systemMessage: {
        id: 'msg-sys-left-' + Date.now(),
        sender: 'System',
        text: `${nickname} left the room.`,
        timestamp: Date.now()
      }
    });

    if (hostTransferred && host) {
      await triggerEvent(`presence-room-${formattedCode}`, 'host-transferred', {
        hostSocketId: host,
        nickname: newHostName,
        systemMessage: {
          id: 'msg-sys-host-' + Date.now(),
          sender: 'System',
          text: `${newHostName} is now the room host.`,
          timestamp: Date.now()
        }
      });
    }

    // Delete room if completely empty
    const messagesCount = await redis.lrange(`${roomKey}:messages`, 0, -1);
    const filesCount = await redis.lrange(`${roomKey}:files`, 0, -1);
    if (remainingUsers.length === 0 && messagesCount.length === 0 && filesCount.length === 0) {
      await redis.del(roomKey);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Leave room error:', error);
    res.status(500).json({ error: 'Failed to process leave room.' });
  }
});



// 10. File Download Redirect
app.get('/api/download/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    
    // Find file across all active rooms
    // We can scan keys with Redis, or search the current active room list
    // In MockRedis/Redis, we list keys with pattern `room:*:files`
    // Since Upstash Redis doesn't easily support scan without keys count, we can read rooms
    // An alternative is a global files index, or we look up room codes
    // For simplicity, search through known active room files in Redis.
    // However, since Redis is distributed, we can search by keeping a list of files or scanning
    // Let's do a search on all active room keys
    // In serverless, since we want this fast, let's keep a global index of files: `files:index` (Hash fileId -> roomCode)
    // Or we scan. Let's do file lookup by reading from Redis directly.
    // To make it easy: let's scan all keys starting with `room:`
    // On Upstash, let's just get the file index or find the roomCode from fileId
    // Let's add a key `file:${fileId}` when files are created!
    // That makes lookup O(1) and extremely fast!
    // Yes! Let's update `file-shared` above to write `await redis.hset("file:" + fileId, fileData)` and set a 1 hour TTL!
    // That is brilliant!
    
    const fileDataRaw = await redis.hgetall(`file:${fileId}`);
    if (!fileDataRaw) {
      return res.status(404).send('File not found or has expired.');
    }

    const now = Date.now();
    if (now - parseInt(fileDataRaw.timestamp) >= EXPIRATION_TIME) {
      // Delete from Vercel Blob if URL matches and it's Vercel Blob
      if (fileDataRaw.path.includes('public.blob.vercel-storage.com')) {
        try {
          await del(fileDataRaw.path);
        } catch (e) {
          console.error('Failed to delete blob from Vercel storage:', e);
        }
      }
      await redis.del(`file:${fileId}`);
      return res.status(404).send('File has expired.');
    }

    // Serve the file depending on where it was stored
    if (fileDataRaw.path.startsWith('http://') || fileDataRaw.path.startsWith('https://')) {
      // Vercel Blob or any remote URL — redirect directly
      res.redirect(fileDataRaw.path);
    } else if (fileDataRaw.path.startsWith('redis:')) {
      // Base64 content stored in a separate Redis string key (Vercel fallback)
      const contentKey = fileDataRaw.path.replace('redis:', '');
      const dataUrl = await redis.get(contentKey);
      if (!dataUrl) {
        return res.status(404).send('File content has expired or was not found.');
      }
      const commaIdx = dataUrl.indexOf(',');
      const header = dataUrl.substring(0, commaIdx);
      const base64Data = dataUrl.substring(commaIdx + 1);
      const mimeType = header.replace('data:', '').replace(';base64', '');
      const buffer = Buffer.from(base64Data, 'base64');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileDataRaw.originalName)}"`);
      res.setHeader('Content-Type', mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', buffer.length);
      res.end(buffer);
    } else if (fileDataRaw.path.startsWith('data:')) {
      // Legacy: base64 data URL stored inline in hset (may exist for older uploads)
      const commaIdx = fileDataRaw.path.indexOf(',');
      const header = fileDataRaw.path.substring(0, commaIdx);
      const base64Data = fileDataRaw.path.substring(commaIdx + 1);
      const mimeType = header.replace('data:', '').replace(';base64', '');
      const buffer = Buffer.from(base64Data, 'base64');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileDataRaw.originalName)}"`);
      res.setHeader('Content-Type', mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', buffer.length);
      res.end(buffer);
    } else {
      // Local dev disk file
      const localPath = path.join(__dirname, 'public', fileDataRaw.path);
      if (fs.existsSync(localPath)) {
        res.download(localPath, fileDataRaw.originalName);
      } else {
        res.status(404).send('Local file missing from server.');
      }
    }
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).send('Download error occurred.');
  }
});

// Update `/api/rooms/file-shared` implementation to write the quick lookup index
app.post('/api/rooms/file-shared', async (req, res) => {
  try {
    const { roomCode, sender, originalName, mimeType, size, url, socketId } = req.body;
    const formattedCode = roomCode.toUpperCase().trim();
    const roomKey = `room:${formattedCode}`;

    const exists = await redis.exists(roomKey);
    if (!exists) {
      return res.status(400).json({ error: 'Invalid room code.' });
    }

    const room = await redis.hgetall(roomKey);
    if (room.isMuted === 'true' && socketId !== room.host) {
      return res.status(403).json({ error: 'Host only messaging is enabled.' });
    }

    const fileId = 'file-' + Date.now() + '-' + Math.round(Math.random() * 1e9);

    // For base64 data URLs (Vercel fallback): store the raw content in a SEPARATE Redis string
    // key to avoid hset field-value size limits (Upstash free caps individual field values).
    // For normal URLs we just store the URL string inline — it's tiny.
    let storedPath = url;
    if (url.startsWith('data:')) {
      const contentKey = `filecontent:${fileId}`;
      await redis.set(contentKey, url);
      await redis.expire(contentKey, 3600);
      storedPath = `redis:${contentKey}`; // marker so download knows to look up from Redis string
    }

    const fileData = {
      id: fileId,
      originalName,
      mimeType,
      size: size.toString(),
      path: storedPath,
      sender: sender || 'Anonymous',
      timestamp: Date.now().toString()
    };

    // Store in room list
    await redis.rpush(`${roomKey}:files`, JSON.stringify(fileData));
    
    // Store in global fast-lookup index — hset fields are safe here since path is no longer base64
    await redis.hset(`file:${fileId}`, fileData);
    await redis.expire(`file:${fileId}`, 3600);

    // File message shows as a proper chat bubble from the sender, not a bland system strip
    const fileMessage = {
      id: 'msg-file-' + Date.now(),
      sender: sender || 'Someone',
      text: '',
      timestamp: Date.now(),
      file: {
        id: fileData.id,
        originalName: fileData.originalName,
        size: parseInt(fileData.size),
        mimeType: fileData.mimeType
      }
    };
    await redis.rpush(`${roomKey}:messages`, JSON.stringify(fileMessage));

    // Broadcast file-shared event
    await triggerEvent(`presence-room-${formattedCode}`, 'file-shared', {
      file: { ...fileData, size: parseInt(fileData.size), timestamp: parseInt(fileData.timestamp) },
      message: fileMessage
    });

    res.status(200).json({ success: true, file: fileData, message: fileMessage });
  } catch (error) {
    console.error('Register shared file error:', error);
    res.status(500).json({ error: 'Failed to share file.' });
  }
});

// 11. Local Upload Endpoint (works on local dev AND Vercel without Blob configured)
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
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

      if (isVercel) {
        // On Vercel without Blob: store file content as base64 data URL.
        // Redis has a ~1MB per-value soft limit and a hard cap on plan size,
        // so we reject files over 5 MB here to keep Redis healthy.
        const MAX_REDIS_BYTES = 50 * 1024 * 1024; // 50 MB
        if (req.file.size > MAX_REDIS_BYTES) {
          return res.status(400).json({
            error: 'File is too large. Capped at 50MB.'
          });
        }
        const mimeType = req.file.mimetype || 'application/octet-stream';
        const base64 = req.file.buffer.toString('base64');
        const dataUrl = `data:${mimeType};base64,${base64}`;
        return res.status(200).json({ success: true, url: dataUrl });
      } else {
        // Local dev: file is on disk, serve via static /uploads/ route
        const fileUrl = `/uploads/${req.file.filename}`;
        return res.status(200).json({ success: true, url: fileUrl });
      }
    } catch (error) {
      console.error('Local upload API error:', error);
      res.status(500).json({ error: 'File upload failed.' });
    }
  });
});

// 12. Vercel Blob Token Generation
app.post('/api/upload-token', async (req, res) => {
  const body = req.body;
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(400).json({ error: 'Vercel Blob token is missing.' });
    }

    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        return {
          allowedContentTypes: undefined, // Allow all file types
          tokenPayload: JSON.stringify({
            // Put metadata here if needed
          }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log('Blob upload finished successfully:', blob.url);
      },
    });

    res.json(jsonResponse);
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(400).json({ error: error.message });
  }
});

// 13. Pusher Auth Endpoint
app.post('/api/pusher/auth', (req, res) => {
  if (!pusher) {
    return res.status(400).send('Pusher is not configured.');
  }

  const socketId = req.body.socket_id;
  const channel = req.body.channel_name;
  const nickname = req.body.nickname;
  const userId = req.body.userId || socketId;

  const presenceData = {
    user_id: userId,
    user_info: { nickname },
  };

  try {
    const auth = pusher.authorizeChannel(socketId, channel, presenceData);
    res.send(auth);
  } catch (error) {
    console.error('Pusher auth error:', error);
    res.status(500).send(error.toString());
  }
});

// 14. Polling Fallback updates for local development without Pusher
app.get('/api/rooms/:roomCode/updates', async (req, res) => {
  try {
    const { roomCode } = req.params;
    const formattedCode = roomCode.toUpperCase().trim();
    const roomKey = `room:${formattedCode}`;

    const exists = await redis.exists(roomKey);
    if (!exists) {
      return res.status(404).json({ error: 'Room expired or deleted.' });
    }

    // Refresh TTL
    await redis.expire(roomKey, 3600);
    await redis.expire(`${roomKey}:messages`, 3600);
    await redis.expire(`${roomKey}:files`, 3600);
    await redis.expire(`${roomKey}:users`, 3600);
    await redis.expire(`${roomKey}:lobby`, 3600);

    const room = await redis.hgetall(roomKey);
    const host = room.host;
    const isLocked = room.isLocked === 'true';

    const messagesRaw = await redis.lrange(`${roomKey}:messages`, 0, -1);
    const filesRaw = await redis.lrange(`${roomKey}:files`, 0, -1);

    const now = Date.now();
    const messages = messagesRaw.map(m => typeof m === 'string' ? JSON.parse(m) : m)
                                .filter(m => now - m.timestamp < EXPIRATION_TIME);
    const files = filesRaw.map(f => typeof f === 'string' ? JSON.parse(f) : f)
                          .filter(f => now - f.timestamp < EXPIRATION_TIME);

    const usersMap = await redis.hgetall(`${roomKey}:users`) || {};
    const userList = Object.entries(usersMap).map(([id, name]) => ({
      socketId: id,
      nickname: name
    }));

    res.status(200).json({
      success: true,
      messages,
      files,
      users: userList,
      host,
      isMuted: room.isMuted === 'true'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Conditionally start local server (Vercel manages execution in production)
const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running locally on port ${PORT}`);
  });
}

export default app;
