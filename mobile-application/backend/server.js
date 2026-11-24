import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import {
  closePairingSession, createPairingSession, database, getPairingByCodeHash, listActivityForCode,
  markPairingConnected, recordActivity, touchPairingSession,
} from './database/index.js';

const BACKEND_ROOT = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BACKEND_ROOT, '..', 'frontend', 'pwa');
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : '';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || Number.MAX_SAFE_INTEGER);
if (!Number.isSafeInteger(MAX_FILE_BYTES) || MAX_FILE_BYTES < 1) throw new Error('MAX_FILE_BYTES must be a positive integer.');
const sessions = new Map();
const connectedSockets = new Set();
const joinAttempts = new Map();
const activityAttempts = new Map();
const activeTransfers = new Map();
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

class RelaySocket extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.readyState = WS_OPEN;
    this.input = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.closeEmitted = false;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.consume(chunk));
    socket.on('error', () => this.finishClose());
    socket.on('close', () => this.finishClose());
  }

  get bufferedAmount() { return this.socket.writableLength || 0; }

  send(data, options = {}) {
    if (this.readyState !== WS_OPEN || this.socket.destroyed) return;
    const binary = options.binary ?? Buffer.isBuffer(data);
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.socket.write(encodeFrame(payload, binary ? 0x2 : 0x1));
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== WS_OPEN) return;
    this.readyState = WS_CLOSING;
    const reasonBytes = Buffer.from(String(reason));
    const payload = Buffer.alloc(Math.min(125, 2 + reasonBytes.length));
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2, 0, payload.length - 2);
    this.socket.end(encodeFrame(payload, 0x8));
  }

  consume(chunk) {
    if (this.readyState === WS_CLOSED) return;
    this.input = this.input.length ? Buffer.concat([this.input, chunk]) : chunk;
    while (this.input.length >= 2) {
      const first = this.input[0];
      const second = this.input[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      const marker = second & 0x7f;
      if ((first & 0x70) !== 0 || !masked) { this.protocolError(); return; }
      let length = marker;
      let headerLength = 2;
      if (marker === 126) {
        if (this.input.length < 4) return;
        length = this.input.readUInt16BE(2);
        headerLength = 4;
      } else if (marker === 127) {
        if (this.input.length < 10) return;
        const bigLength = this.input.readBigUInt64BE(2);
        if (bigLength > BigInt(this.maxPayload)) { this.close(1009, 'Message too large'); return; }
        length = Number(bigLength);
        headerLength = 10;
      }
      const controlFrame = opcode >= 0x8;
      if (length > this.maxPayload || (controlFrame && (!fin || length > 125))) { this.close(1009, 'Message too large'); return; }
      const frameLength = headerLength + 4 + length;
      if (this.input.length < frameLength) return;
      const mask = this.input.subarray(headerLength, headerLength + 4);
      const payload = Buffer.from(this.input.subarray(headerLength + 4, frameLength));
      this.input = this.input.subarray(frameLength);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index & 3];
      if (controlFrame) {
        if (opcode === 0x8) { this.handleClose(payload); return; }
        if (opcode === 0x9 && this.readyState === WS_OPEN) this.socket.write(encodeFrame(payload, 0x0a));
        continue;
      }
      if (opcode === 0x0) {
        if (this.fragmentOpcode === null) { this.close(1002, 'Unexpected continuation'); return; }
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > this.maxPayload) { this.close(1009, 'Message too large'); return; }
        if (fin) {
          const message = Buffer.concat(this.fragments, this.fragmentBytes);
          const isBinary = this.fragmentOpcode === 0x2;
          this.fragmentOpcode = null;
          this.fragments = [];
          this.fragmentBytes = 0;
          this.emit('message', message, isBinary);
        }
        continue;
      }
      if (opcode !== 0x1 && opcode !== 0x2) { this.close(1002, 'Unsupported frame'); return; }
      if (this.fragmentOpcode !== null) { this.close(1002, 'Interleaved message'); return; }
      if (fin) this.emit('message', payload, opcode === 0x2);
      else {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
      }
    }
  }

  handleClose(payload) {
    if (payload.length === 1) { this.close(1002, 'Invalid close frame'); return; }
    if (this.readyState === WS_OPEN) {
      this.readyState = WS_CLOSING;
      this.socket.end(encodeFrame(payload, 0x8));
    }
    this.finishClose();
  }

  protocolError() { this.close(1002, 'Invalid WebSocket frame'); }

  finishClose() {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.readyState = WS_CLOSED;
    this.emit('close');
  }
}

function encodeFrame(payload, opcode) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const server = createServer((request, response) => {
  let url;
  try { url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`); }
  catch { response.writeHead(400); response.end('Bad request'); return; }
  if (url.pathname === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ok: true, service: 'LinkDrop', database: 'sqlite', activePairs: sessions.size }));
    return;
  }
  if (url.pathname === '/api/connect-info') {
    const interfaces = networkInterfaces();
    const blockedInterface = /virtual|vmware|virtualbox|vEthernet|docker|wsl|loopback|bluetooth|vpn/i;
    const addresses = Object.entries(interfaces)
      .filter(([name]) => !blockedInterface.test(name))
      .flatMap(([, entries]) => (entries || []).filter((entry) => {
        if (entry.family !== 'IPv4' || entry.internal) return false;
        const octets = entry.address.split('.').map(Number);
        return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
      }).map((entry) => entry.address));
    const urls = [...new Set(addresses)].map((address) => `http://${address}:${PORT}`);
    const selectedUrl = PUBLIC_URL || urls[0] || '';
    const qrPromise = selectedUrl
      ? QRCode.toDataURL(selectedUrl, { margin: 2, width: 240, errorCorrectionLevel: 'M' })
      : Promise.resolve(null);
    qrPromise.then((qr) => {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ url: selectedUrl, urls, qr }));
      })
      .catch(() => {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: 'Could not create a phone QR code.' }));
      });
    return;
  }
  if (url.pathname === '/api/activity') {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    if (!allowActivityRequest(request)) {
      response.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60' });
      response.end(JSON.stringify({ error: 'Too many history requests. Try again in a minute.' }));
      return;
    }
    if (!String(request.headers['content-type'] || '').includes('application/json')) {
      response.writeHead(415, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: 'Send a JSON request body.' }));
      return;
    }
    readJsonBody(request, 1024).then(({ code: suppliedCode }) => {
      const code = String(suppliedCode || '');
      if (!/^\d{6}$/.test(code)) {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: 'A six-digit pairing code is required.' }));
        return;
      }
      const events = listActivityForCode(createHash('sha256').update(code).digest('hex'));
      if (!events) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: 'That pairing code has expired.' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ events }));
    }).catch((error) => {
      const status = error.code === 'ENTITY_TOO_LARGE' ? 413 : 400;
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: error.message || 'Invalid request body.' }));
    });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    response.end('Method not allowed');
    return;
  }

  let pathname;
  try { pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
  catch { response.writeHead(400); response.end('Bad request'); return; }
  const filePath = resolve(ROOT, `.${pathname}`);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream',
    'cache-control': filePath.endsWith('service-worker.js') ? 'no-cache' : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath).pipe(response);
});

function readJsonBody(request, maxBytes) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { tooLarge = true; chunks.length = 0; return; }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on('error', rejectBody);
    request.on('end', () => {
      if (tooLarge) { rejectBody(Object.assign(new Error('Request body is too large.'), { code: 'ENTITY_TOO_LARGE' })); return; }
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { rejectBody(new Error('Invalid JSON request body.')); }
    });
  });
}

function attachConnection(websocket, request) {
  connectedSockets.add(websocket);
  websocket.on('close', () => connectedSockets.delete(websocket));
  websocket.on('message', (raw, isBinary) => {
    if (isBinary) {
      const code = websocket.sessionCode;
      const session = sessions.get(code);
      if (!session || raw.length < 36) return;
      const transferId = raw.subarray(0, 36).toString('ascii');
      const transfer = activeTransfers.get(transferId);
      const peer = peerFor(session, websocket);
      if (!transfer || transfer.session !== session || transfer.sender !== websocket || !peer || peer.readyState !== WS_OPEN) return;
      const bodyBytes = raw.length - 36;
      if (transfer.bytes + bodyBytes > transfer.size || peer.bufferedAmount > 8 * 1024 * 1024) {
        activeTransfers.delete(transferId);
        send(peer, { type: 'file:cancelled', id: transferId, message: 'The transfer stopped. Check your connection and try again.' });
        send(websocket, { type: 'file:cancelled', id: transferId, message: 'The receiving device could not keep up. Try sending the file again.' });
        return;
      }
      transfer.bytes += bodyBytes;
      peer.send(raw, { binary: true });
      return;
    }

    let message;
    try { message = JSON.parse(raw.toString()); }
    catch { send(websocket, { type: 'room:error', message: 'That message could not be read.' }); return; }
    if (message.type === 'room:create') {
      if (message.role !== 'phone') { send(websocket, { type: 'room:error', message: 'A new code can only be created from the phone.' }); return; }
      if (!allowedJoin(websocket, request)) return;
      if (sessions.size >= 2000) { send(websocket, { type: 'room:error', message: 'LinkDrop is busy right now. Try again in a minute.' }); return; }
      const previous = sessions.get(websocket.sessionCode);
      if (previous?.phone === websocket) closeSession(previous.code, 'A fresh pairing code replaced the old one.', websocket);
      const code = issueCode();
      const createdAt = Date.now();
      const session = { id: randomUUID(), code, phone: websocket, laptop: null, createdAt, absoluteExpiresAt: createdAt + SESSION_TTL_MS, expiresAt: createdAt + SESSION_TTL_MS, lastActivity: createdAt };
      createPairingSession(session.id, createHash('sha256').update(code).digest('hex'), createdAt, session.expiresAt);
      sessions.set(code, session);
      websocket.sessionCode = code;
      websocket.role = 'phone';
      send(websocket, { type: 'room:created', code, expiresAt: session.expiresAt });
      return;
    }
    if (message.type === 'room:join') { joinRoom(websocket, request, message); return; }
    if (message.type === 'room:resume') { resumeRoom(websocket, request, message); return; }

    const session = sessions.get(websocket.sessionCode);
    const peer = session && peerFor(session, websocket);
    if (!session || !peer || peer.readyState !== WS_OPEN) {
      send(websocket, { type: 'room:error', message: 'Your other device is no longer connected.' });
      return;
    }
    session.lastActivity = Date.now();
    session.expiresAt = Math.min(session.absoluteExpiresAt, Date.now() + SESSION_TTL_MS);
    touchPairingSession(session.id, session.expiresAt);

    if (message.type === 'message:send') {
      const text = String(message.text || '').trim();
      if (!text || text.length > 5000) { send(websocket, { type: 'room:error', message: 'Messages can be up to 5,000 characters.' }); return; }
      const id = randomUUID();
      const item = { type: 'message:receive', id, text, sender: websocket.role, sentAt: Date.now() };
      recordActivity({ id: randomUUID(), sessionId: session.id, kind: 'note', senderRole: websocket.role, byteSize: Buffer.byteLength(text, 'utf8') });
      send(peer, item);
      send(websocket, { type: 'message:sent', ...item });
      return;
    }
    if (message.type === 'file:start') {
      const name = String(message.name || '').slice(0, 240);
      const size = Number(message.size);
      const id = String(message.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id) || !name || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
        send(websocket, { type: 'room:error', message: 'This file is too large or has invalid details.' });
        return;
      }
      activeTransfers.set(id, { id, session, sender: websocket, receiver: peer, size, bytes: 0, name, createdAt: Date.now() });
      send(peer, { type: 'file:offer', id, name, size, mime: String(message.mime || 'application/octet-stream').slice(0, 120), sender: websocket.role });
      return;
    }
    if (message.type === 'file:accept' || message.type === 'file:reject') {
      const transfer = activeTransfers.get(String(message.id || ''));
      if (!transfer || transfer.session !== session || transfer.receiver !== websocket) return;
      if (message.type === 'file:reject') {
        activeTransfers.delete(transfer.id);
        send(transfer.sender, { type: 'file:rejected', id: transfer.id });
      } else send(transfer.sender, { type: 'file:accepted', id: transfer.id });
      return;
    }
    if (message.type === 'file:end') {
      const transfer = activeTransfers.get(String(message.id || ''));
      if (!transfer || transfer.session !== session || transfer.sender !== websocket || transfer.bytes !== transfer.size) {
        if (transfer) activeTransfers.delete(transfer.id);
        send(websocket, { type: 'file:cancelled', id: String(message.id || ''), message: 'The file arrived incomplete. Try again.' });
        return;
      }
      send(transfer.receiver, { type: 'file:end', id: transfer.id });
      return;
    }
    if (message.type === 'file:completed' || message.type === 'file:cancel') {
      const transfer = activeTransfers.get(String(message.id || ''));
      if (!transfer || transfer.session !== session) return;
      if (message.type === 'file:completed' && transfer.receiver !== websocket) return;
      if (message.type === 'file:cancel' && websocket !== transfer.receiver && websocket !== transfer.sender) return;
      activeTransfers.delete(transfer.id);
      if (message.type === 'file:completed') {
        recordActivity({ id: randomUUID(), sessionId: session.id, kind: 'file', senderRole: transfer.sender.role, byteSize: transfer.size });
        send(transfer.sender, { type: 'file:completed', id: transfer.id });
      }
      else {
        const otherSide = websocket === transfer.sender ? transfer.receiver : transfer.sender;
        send(otherSide, { type: 'file:cancelled', id: transfer.id, message: 'The other device stopped the transfer.' });
      }
      return;
    }
    if (message.type === 'room:leave') {
      const code = session.code;
      closeSession(code, websocket.role === 'phone' ? 'The phone ended this pairing.' : 'The laptop ended this pairing.');
      websocket.close(1000, 'Pairing ended');
    }
  });

  websocket.on('close', () => {
    const session = sessions.get(websocket.sessionCode);
    if (!session) return;
    if (session.phone === websocket) {
      session.phone = null;
      send(session.laptop, { type: 'room:peer-offline', message: 'The phone went offline. This pairing will reconnect when it is back.' });
    }
    if (session.laptop === websocket) {
      session.laptop = null;
      send(session.phone, { type: 'room:peer-offline', message: 'The laptop went offline. This pairing will reconnect when it is back.' });
    }
    for (const [id, transfer] of activeTransfers) if (transfer.session === session) activeTransfers.delete(id);
  });
}

server.on('upgrade', (request, socket, head) => {
  let url;
  try { url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`); }
  catch { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
  const key = request.headers['sec-websocket-key'];
  if (url.pathname !== '/relay' || request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket' || request.headers['sec-websocket-version'] !== '13' || typeof key !== 'string') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const websocket = new RelaySocket(socket, 300 * 1024);
  attachConnection(websocket, request);
  if (head.length) websocket.consume(head);
});

function send(socket, payload) {
  if (socket?.readyState === WS_OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(session, payload) {
  send(session.phone, payload);
  send(session.laptop, payload);
}

function peerFor(session, socket) {
  return session.phone === socket ? session.laptop : session.phone;
}

function closeSession(code, note = 'This pairing code has expired.', keepSocket = null) {
  const session = sessions.get(code);
  if (!session) return;
  for (const [id, transfer] of activeTransfers) {
    if (transfer.session === session) activeTransfers.delete(id);
  }
  sessions.delete(code);
  closePairingSession(session.id);
  broadcast(session, { type: 'room:closed', message: note });
  for (const participant of [session.phone, session.laptop]) {
    if (participant && participant !== keepSocket) participant.close(1000, note);
  }
}

function issueCode() {
  let code;
  do code = String(randomInt(100000, 1000000)); while (sessions.has(code));
  return code;
}

function allowedJoin(socket, request) {
  const forwarded = request.headers['x-forwarded-for'];
  const useTrustedProxy = process.env.TRUST_PROXY === '1' && typeof forwarded === 'string';
  const address = (useTrustedProxy ? forwarded.split(',')[0].trim() : request.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  const recent = (joinAttempts.get(address) || []).filter((time) => now - time < 60_000);
  if (recent.length >= 12) {
    send(socket, { type: 'room:error', message: 'Too many tries. Wait a minute, then try again.' });
    return false;
  }
  recent.push(now);
  joinAttempts.set(address, recent);
  return true;
}

function allowActivityRequest(request) {
  const forwarded = request.headers['x-forwarded-for'];
  const useTrustedProxy = process.env.TRUST_PROXY === '1' && typeof forwarded === 'string';
  const address = (useTrustedProxy ? forwarded.split(',')[0].trim() : request.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  const recent = (activityAttempts.get(address) || []).filter((time) => now - time < 60_000);
  if (recent.length >= 30) return false;
  recent.push(now);
  activityAttempts.set(address, recent);
  return true;
}

function joinRoom(socket, request, message) {
  const code = String(message.code || '').replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(code) || !allowedJoin(socket, request)) {
    if (!/^\d{6}$/.test(code)) send(socket, { type: 'room:error', message: 'Enter the six-digit code shown on your phone.' });
    return;
  }
  const session = sessions.get(code);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) closeSession(code);
    send(socket, { type: 'room:error', message: 'That code expired. Create a fresh one on your phone.' });
    return;
  }
  const slot = message.role === 'laptop' ? 'laptop' : 'phone';
  if (slot !== 'laptop') {
    send(socket, { type: 'room:error', message: 'Use the phone to create a code, then enter it on your laptop.' });
    return;
  }
  if (session.laptop && session.laptop !== socket && session.laptop.readyState === WS_OPEN) {
    send(socket, { type: 'room:error', message: 'This code is already connected to a laptop.' });
    return;
  }
  session.laptop = socket;
  const connectedAt = Date.now();
  session.absoluteExpiresAt = connectedAt + SESSION_TTL_MS;
  session.expiresAt = session.absoluteExpiresAt;
  session.lastActivity = Date.now();
  markPairingConnected(session.id, session.lastActivity, session.expiresAt);
  socket.sessionCode = code;
  socket.role = slot;
  send(socket, { type: 'room:connected', role: slot, code, expiresAt: session.expiresAt, peer: 'phone' });
  send(session.phone, { type: 'room:connected', role: 'phone', code, expiresAt: session.expiresAt, peer: 'laptop' });
}

function resumeRoom(socket, request, message) {
  const code = String(message.code || '').replace(/\D/g, '').slice(0, 6);
  const role = message.role === 'phone' || message.role === 'laptop' ? message.role : '';
  if (!/^\d{6}$/.test(code) || !role || !allowedJoin(socket, request)) {
    send(socket, { type: 'room:error', message: 'The saved pairing could not be resumed. Create a new code if it expired.' });
    return;
  }
  const codeHash = createHash('sha256').update(code).digest('hex');
  const saved = getPairingByCodeHash(codeHash);
  if (!saved) {
    send(socket, { type: 'room:error', message: 'The saved pairing expired. Create a new code to connect again.' });
    return;
  }
  let session = sessions.get(code);
  if (!session) {
    session = {
      id: saved.id,
      code,
      phone: null,
      laptop: null,
      createdAt: saved.created_at,
      absoluteExpiresAt: saved.expires_at,
      expiresAt: saved.expires_at,
      lastActivity: Date.now(),
    };
    sessions.set(code, session);
  }
  const slot = role;
  if (session[slot] && session[slot] !== socket && session[slot].readyState === WS_OPEN) {
    send(socket, { type: 'room:error', message: 'That device role is already connected.' });
    return;
  }
  session[slot] = socket;
  socket.sessionCode = code;
  socket.role = slot;
  session.lastActivity = Date.now();
  touchPairingSession(session.id, session.expiresAt);
  if (session.phone && session.laptop) {
    session.expiresAt = Math.min(session.absoluteExpiresAt, Date.now() + SESSION_TTL_MS);
    markPairingConnected(session.id, session.lastActivity, session.expiresAt);
    send(session.phone, { type: 'room:connected', role: 'phone', code, expiresAt: session.expiresAt, peer: 'laptop' });
    send(session.laptop, { type: 'room:connected', role: 'laptop', code, expiresAt: session.expiresAt, peer: 'phone' });
  } else {
    send(socket, { type: 'room:waiting', role: slot, code, peer: slot === 'phone' ? 'laptop' : 'phone' });
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [code, session] of sessions) if (session.expiresAt <= now) closeSession(code);
  for (const [id, transfer] of activeTransfers) {
    if (now - transfer.createdAt > SESSION_TTL_MS) {
      activeTransfers.delete(id);
      send(transfer.sender, { type: 'file:cancelled', id, message: 'That transfer timed out. Start it again when both devices are ready.' });
      send(transfer.receiver, { type: 'file:cancelled', id, message: 'That transfer timed out. Ask the other device to send it again.' });
    }
  }
  for (const [address, times] of joinAttempts) {
    const recent = times.filter((time) => now - time < 60_000);
    if (recent.length) joinAttempts.set(address, recent);
    else joinAttempts.delete(address);
  }
  for (const [address, times] of activityAttempts) {
    const recent = times.filter((time) => now - time < 60_000);
    if (recent.length) activityAttempts.set(address, recent);
    else activityAttempts.delete(address);
  }
}, 30_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`LinkDrop is ready at http://localhost:${PORT}`);
});

function shutdown() {
  // Keep unexpired pairing rows in SQLite so the clients can resume after the
  // service starts again within the 24-hour pairing window.
  for (const socket of connectedSockets) socket.close(1001, 'Service shutting down');
  server.close(() => { database.close(); process.exit(0); });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
