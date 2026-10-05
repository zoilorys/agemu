import WebSocket from 'ws';
import type { WebSocketLike } from './js-console.js';

export type WebSocketOptions = { headers: Record<string, string>; closeTimeoutMs?: number };

/** ws owns framing, validation and upgrade handling; its close timer forcibly terminates silent peers. */
export function connectWebSocket(url: string, options: WebSocketOptions): WebSocketLike {
  // closeTimeout is supported by ws 8.22; DefinitelyTyped's latest declaration predates it.
  const init: WebSocket.ClientOptions & { closeTimeout: number } = {
    headers: options.headers, closeTimeout: options.closeTimeoutMs ?? 1_000,
    perMessageDeflate: false,
  };
  const socket = new WebSocket(url, init);
  // Consume errors even if a caller closes before attaching a listener.
  socket.on('error', () => {});
  return {
    addEventListener(type, listener) {
      switch (type) {
        case 'open': socket.on('open', () => listener({})); break;
        case 'message': socket.on('message', (data, binary) => listener({ data: binary ? data : data.toString() })); break;
        case 'error': socket.on('error', error => listener({ message: error.message })); break;
        case 'close': socket.on('close', (code, reason) => listener({ code, reason: reason.toString() })); break;
      }
    },
    send(data) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');
      socket.send(data);
    },
    close(code = 1000, reason = '') { socket.close(code, reason); },
  };
}
