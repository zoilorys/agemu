import { createHash } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { SocketEvent } from '../../src/native/js-console.js';
import { connectWebSocket } from '../../src/native/websocket.js';

type Peer = { socket: Socket; request: string; closed: Promise<void> };

// A raw TCP peer that accepts the WebSocket upgrade and then does only what each test tells it to.
async function peer(respond = true): Promise<{ url: string; connection: Promise<Peer>; server: Server }> {
  let resolveConnection!: (value: Peer) => void;
  const connection = new Promise<Peer>((resolve) => { resolveConnection = resolve; });
  const server = createServer((socket) => {
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
    socket.once('data', (data) => {
      const request = String(data);
      if (!respond) { socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); socket.end(); }
      else {
        const key = /sec-websocket-key: (.+)\r\n/i.exec(request)![1].trim();
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      }
      resolveConnection({ socket, request, closed });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `ws://127.0.0.1:${port}/inspector/debug?page=1`, connection, server };
}

// Server frames are unmasked.
const serverFrame = (opcode: number, payload: Buffer, fin = true) => {
  const header = payload.length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, payload.length])
    : Buffer.from([(fin ? 0x80 : 0) | opcode, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
};
const readClientFrame = (data: Buffer) => {
  const length = data[1] & 0x7f;
  const mask = data.subarray(2, 6);
  return { opcode: data[0] & 0x0f, masked: (data[1] & 0x80) !== 0, payload: Buffer.from(data.subarray(6, 6 + length).map((byte, index) => byte ^ mask[index % 4])) };
};
const eventsOf = (socket: ReturnType<typeof connectWebSocket>) => {
  const events: Array<[string, SocketEvent]> = [];
  for (const type of ['open', 'message', 'error', 'close'] as const) socket.addEventListener(type, (event) => events.push([type, event]));
  return events;
};
const until = async (condition: () => boolean) => { while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5)); };

describe('connectWebSocket', () => {
  const servers: Server[] = [];
  afterEach(() => { for (const server of servers.splice(0)) server.close(); });

  it('sends the Origin header, masks client frames, and reassembles fragmented and 16-bit-length messages', async () => {
    const { url, connection, server } = await peer();
    servers.push(server);
    const socket = connectWebSocket(url, { headers: { Origin: 'http://127.0.0.1:8093' } });
    const events = eventsOf(socket);
    const { socket: remote, request } = await connection;
    expect(request).toMatch(/^GET \/inspector\/debug\?page=1 HTTP\/1\.1/);
    expect(request).toMatch(/origin: http:\/\/127\.0\.0\.1:8093/i);
    await until(() => events.some(([type]) => type === 'open'));
    const received = new Promise<Buffer>((resolve) => remote.once('data', resolve));
    socket.send('{"id":1,"method":"Runtime.enable"}');
    expect(readClientFrame(await received)).toEqual({ opcode: 1, masked: true, payload: Buffer.from('{"id":1,"method":"Runtime.enable"}') });
    const long = 'é'.repeat(200);
    remote.write(Buffer.concat([serverFrame(1, Buffer.from('hel'), false), serverFrame(0, Buffer.from('lo')), serverFrame(1, Buffer.from(long))]));
    await until(() => events.filter(([type]) => type === 'message').length === 2);
    expect(events.filter(([type]) => type === 'message').map(([, event]) => event.data)).toEqual(['hello', long]);
  });

  it('reports the peer close code and reason', async () => {
    const { url, connection, server } = await peer();
    servers.push(server);
    const events = eventsOf(connectWebSocket(url, { headers: {} }));
    const { socket: remote } = await connection;
    await until(() => events.some(([type]) => type === 'open'));
    const reason = Buffer.from('[CONNECTION_LOST] Connection lost to corresponding device');
    remote.write(serverFrame(8, Buffer.concat([Buffer.from([0x03, 0xe8]), reason])));
    await until(() => events.some(([type]) => type === 'close'));
    expect(events.find(([type]) => type === 'close')![1]).toEqual({ code: 1000, reason: String(reason) });
  });

  it('drops the connection when the peer never answers the close frame', async () => {
    const { url, connection, server } = await peer();
    servers.push(server);
    const socket = connectWebSocket(url, { headers: {}, closeTimeoutMs: 100 });
    const events = eventsOf(socket);
    const { closed } = await connection;
    await until(() => events.some(([type]) => type === 'open'));
    const started = Date.now();
    socket.close(1000);
    await closed;
    expect(Date.now() - started).toBeLessThan(1_000);
    await until(() => events.some(([type]) => type === 'close'));
  });

  it('fails before open when the upgrade is refused', async () => {
    const { url, server } = await peer(false);
    servers.push(server);
    const events = eventsOf(connectWebSocket(url, { headers: {} }));
    await until(() => events.some(([type]) => type === 'close'));
    expect(events.map(([type]) => type)).toEqual(['error', 'close']);
    expect(events[0][1]).toEqual({ message: 'HTTP 401' });
    expect(events[1][1]).toMatchObject({ code: 1006 });
  });
});
