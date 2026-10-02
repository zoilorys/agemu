import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { Socket } from 'node:net';
import type { SocketEvent, WebSocketLike } from './js-console.js';

// Minimal RFC 6455 client over node:http. Node's global WebSocket cannot drop its connection when the peer never
// answers a close frame, which keeps the CLI alive; this client destroys the socket after closeTimeoutMs.
export type WebSocketOptions = { headers: Record<string, string>; closeTimeoutMs?: number };

const acceptGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) header = Buffer.from([0x80 | opcode, 0x80 | length]);
  else if (length < 0x10000) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(length), 2); }
  // Client frames must be masked.
  const mask = randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

export function connectWebSocket(url: string, options: WebSocketOptions): WebSocketLike {
  const listeners: Record<string, Array<(event: SocketEvent) => void>> = { open: [], message: [], error: [], close: [] };
  const emit = (type: string, event: SocketEvent) => { for (const listener of listeners[type]) listener(event); };
  const target = new URL(url);
  const key = randomBytes(16).toString('base64');
  let state: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  let socket: Socket | undefined;
  let buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let closeTimer: NodeJS.Timeout | undefined;

  const finish = (code: number, reason = '') => {
    if (state === 'closed') return;
    state = 'closed';
    clearTimeout(closeTimer);
    socket?.destroy();
    req.destroy();
    queueMicrotask(() => emit('close', { code, reason }));
  };
  const write = (frame: Buffer) => { try { socket?.write(frame); } catch { /* the close path destroys the socket */ } };
  const parse = () => {
    while (buffer.length >= 2 && state !== 'closed') {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const maskKey = masked ? buffer.subarray(offset, offset + 4) : undefined;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (maskKey) for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index % 4];
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (state === 'open') write(encodeFrame(0x8, payload.subarray(0, 2)));
        finish(code, payload.subarray(2).toString('utf8'));
        return;
      }
      if (opcode === 0x9) { write(encodeFrame(0xa, payload)); continue; }
      if (opcode === 0xa) continue;
      fragments.push(payload);
      if (fin) {
        const data = Buffer.concat(fragments).toString('utf8');
        fragments = [];
        if (state === 'open') emit('message', { data });
      }
    }
  };

  const req = request({
    host: target.hostname, port: target.port || 80, path: `${target.pathname}${target.search}`,
    headers: { ...options.headers, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key },
  });
  req.on('upgrade', (response, upgraded, head) => {
    socket = upgraded;
    if (state === 'closed') { upgraded.destroy(); return; }
    const expected = createHash('sha1').update(key + acceptGuid).digest('base64');
    if (response.headers['sec-websocket-accept'] !== expected) {
      emit('error', { message: 'invalid Sec-WebSocket-Accept' });
      finish(1006);
      return;
    }
    upgraded.on('data', (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); parse(); });
    upgraded.on('error', (error) => emit('error', { message: error.message }));
    upgraded.on('close', () => finish(1006));
    state = 'open';
    emit('open', {});
    if (head.length > 0) { buffer = Buffer.concat([buffer, head]); parse(); }
  });
  req.on('response', (response) => {
    response.resume();
    emit('error', { message: `HTTP ${response.statusCode ?? 'error'}` });
    finish(1006, `HTTP ${response.statusCode ?? 'error'}`);
  });
  req.on('error', (error) => {
    if (state === 'closed') return;
    emit('error', { message: error.message });
    finish(1006);
  });
  req.end();

  return {
    addEventListener(type, listener) { listeners[type].push(listener); },
    send(data) {
      if (state !== 'open') throw new Error('WebSocket is not open');
      write(encodeFrame(0x1, Buffer.from(data, 'utf8')));
    },
    close(code = 1000, reason = '') {
      if (state === 'closed' || state === 'closing') return;
      if (state === 'connecting') { finish(1006); return; }
      state = 'closing';
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      write(encodeFrame(0x8, payload));
      // Bounded: a peer that never answers the close frame cannot keep the process alive.
      closeTimer = setTimeout(() => finish(code, reason), options.closeTimeoutMs ?? 1_000);
    },
  };
}
