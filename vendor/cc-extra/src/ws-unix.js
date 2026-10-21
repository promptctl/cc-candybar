// ws-unix.js — a WebSocket client over a unix socket, for the one peer this repo talks to that way:
// the inspector a Bun binary opens when `BUN_INSPECT=ws+unix://<path>` is set.
//
// WHY NOT node's WebSocket. Node's global WebSocket dials TCP only, and the inspector is deliberately
// NOT on TCP: anything that can reach it can run code in the user's session, and a unix socket in a
// 0700 directory is reachable by this user alone. So the client is the handshake (node's http client
// already speaks Upgrade over a socketPath) and RFC 6455 framing, which is all this file is.
//
// The framing is pure and exported, so the suite checks it against the RFC's own vectors without a
// server. [LAW:effects-at-boundaries]

'use strict';

const crypto = require('crypto');
const http = require('http');

const OPCODES = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

// One client-to-server frame: FIN set, MASKED (RFC 6455 5.3 requires a client to mask every frame).
// `mask` is a parameter so the suite can pin it to the RFC's example key.
function encodeFrame(opcode, payload, mask = crypto.randomBytes(4)) {
  const len = payload.length;
  const lengthBytes = len < 126 ? 0 : len < 0x10000 ? 2 : 8;
  const head = Buffer.alloc(2 + lengthBytes + 4);
  head[0] = 0x80 | opcode;
  head[1] = 0x80 | (lengthBytes === 0 ? len : lengthBytes === 2 ? 126 : 127);
  if (lengthBytes === 2) head.writeUInt16BE(len, 2);
  if (lengthBytes === 8) head.writeBigUInt64BE(BigInt(len), 2);
  mask.copy(head, 2 + lengthBytes);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([head, body]);
}

// Reads server-to-client frames from a byte stream: returns a function to feed chunks, and calls
// `onFrame({ fin, opcode, payload })` for each complete frame. A server must not mask (RFC 6455 5.1);
// a masked one is a protocol error, reported through `onError` once, after which nothing more is read.
function frameReader(onFrame, onError) {
  let buf = Buffer.alloc(0);
  let broken = false;
  return (chunk) => {
    if (broken) return;
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      if (buf[1] & 0x80) { broken = true; onError(new Error('server sent a masked frame')); return; }
      const short = buf[1] & 0x7f;
      const lengthBytes = short === 126 ? 2 : short === 127 ? 8 : 0;
      if (buf.length < 2 + lengthBytes) return;
      const len = lengthBytes === 2 ? buf.readUInt16BE(2) : lengthBytes === 8 ? Number(buf.readBigUInt64BE(2)) : short;
      const start = 2 + lengthBytes;
      if (buf.length < start + len) return;
      onFrame({ fin, opcode, payload: buf.subarray(start, start + len) });
      buf = buf.subarray(start + len);
    }
  };
}

// Joins fragmented text messages and answers the control frames, handing each whole message to
// `onMessage(text)`. `write` sends raw bytes; `onClose` is told once, with why.
function messageReader({ onMessage, write, onClose }) {
  let parts = [];
  return (frame) => {
    if (frame.opcode === OPCODES.ping) { write(encodeFrame(OPCODES.pong, frame.payload)); return; }
    if (frame.opcode === OPCODES.pong) return;
    if (frame.opcode === OPCODES.close) { onClose('closed by the peer'); return; }
    parts.push(frame.payload);
    if (!frame.fin) return;
    const text = Buffer.concat(parts).toString('utf8');
    parts = [];
    onMessage(text);
  };
}

// Open a WebSocket to `path` on the server listening at `socketPath`. Resolves once the handshake is
// accepted with { send(text), close(why?), listen({ onMessage, onClose }) }, or rejects naming why it was
// not.
function connect(socketPath, path = '/') {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      socketPath, path,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' },
    });
    req.on('error', reject);
    req.on('response', (res) => reject(new Error(`inspector refused the upgrade: HTTP ${res.statusCode}`)));
    req.on('upgrade', (res, socket, head) => {
      // The accept header proves the peer read OUR key, not a stale or proxied answer (RFC 6455 4.1).
      const expected = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) { socket.destroy(); reject(new Error('inspector answered the upgrade with the wrong accept key')); return; }
      let listener = null;
      let endedBecause = null;
      const close = (why) => {
        if (endedBecause !== null) return;
        endedBecause = why;
        socket.destroy();
        if (listener) listener.onClose(why);
      };
      const feed = frameReader(
        // An ended connection delivers nothing, a frame read after its close frame in the same chunk included.
        messageReader({ onMessage: (text) => endedBecause === null && listener.onMessage(text), write: (bytes) => socket.write(bytes), onClose: close }),
        (e) => close(e.message),
      );
      socket.on('error', (e) => close(e.message));
      socket.on('close', () => close('socket closed'));
      resolve({
        send: (text) => socket.write(encodeFrame(OPCODES.text, Buffer.from(text, 'utf8'))),
        close: (why = 'closed by this client') => close(why),
        // Both handlers at once, and only then is anything read — the bytes that came with the upgrade
        // first — so no message or close lands before there is someone to tell it to.
        // [LAW:no-ambient-temporal-coupling] delivery starts at the one moment a listener exists.
        listen: (handlers) => {
          listener = handlers;
          if (endedBecause !== null) { handlers.onClose(endedBecause); return; }
          if (head.length) feed(head);
          socket.on('data', feed);
        },
      });
    });
    req.end();
  });
}

module.exports = { OPCODES, encodeFrame, frameReader, messageReader, connect };
