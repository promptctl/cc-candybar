// inspector-session.js — the request/response and event halves of the WebKit inspector protocol, over
// any transport that carries text messages (ws-unix.js in use; a fake in the suite).
//
// Every request is answered or rejected: by its own response, by the protocol error that answers it,
// or — when the transport closes first — by the close, so no caller waits on a peer that has gone.
// A message that cannot be handled — not JSON, a response to nothing asked, a listener that throws —
// is a `fault`: told to the session's `fault` listeners, then the session closes naming it, the one
// way every caller already hears of an end. Thrown from the transport's handler instead, it would kill
// the launcher and leave the TUI on a terminal the shell has taken back. A fault is its own event
// because a close alone cannot say whether the peer ended or this side broke. [LAW:no-silent-failure]

'use strict';

function createInspectorSession(transport) {
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  let closedBecause = null;

  const dispatch = (text) => {
    const msg = JSON.parse(text);
    if (msg.id !== undefined) {
      const waiter = pending.get(msg.id);
      if (!waiter) throw new Error(`a response to request ${msg.id}, which nothing is waiting on`);
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${waiter.method}: ${msg.error.message}`));
      else waiter.resolve(msg.result);
      return;
    }
    for (const fn of listeners.get(msg.method) || []) fn(msg.params);
  };
  const onMessage = (text) => {
    try { dispatch(text); } catch (e) {
      const why = `unhandled inspector message: ${e.message}`;
      for (const fn of listeners.get('fault') || []) fn(why);
      transport.close(why);
    }
  };

  const onClose = (why) => {
    closedBecause = why;
    for (const waiter of pending.values()) waiter.reject(new Error(`${waiter.method}: inspector closed (${why})`));
    pending.clear();
    for (const fn of listeners.get('close') || []) fn(why);
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (closedBecause !== null) { reject(new Error(`${method}: inspector closed (${closedBecause})`)); return; }
    const id = nextId++;
    pending.set(id, { method, resolve, reject });
    transport.send(JSON.stringify({ id, method, params }));
  });

  // `close` and `fault` are events of this session too: the transport ending, and a message this side
  // could not handle, each with why.
  const on = (method, fn) => { listeners.set(method, [...(listeners.get(method) || []), fn]); };

  transport.listen({ onMessage, onClose });
  return { send, on, close: () => transport.close() };
}

module.exports = { createInspectorSession };
