// statusline-push.js — draw the status line from the frames cc-candybar's daemon pushes, instead of
// only the output of the command Claude Code reruns.
//
// WHY. Claude Code reruns the status line command once a second at best (`refreshInterval` is
// clamped to a whole second, and every tick passes a 300 ms debounce that restarts itself), so an
// animated bar moves at one frame a second. cc-candybar's daemon can push a session's frames as it
// draws them — up to thirty a second while the bar moves, and the moment a click changes it — over a
// `subscribe` request on its socket (cc-candybar candybar-animation-wbxz.jmm.usl). This module holds
// one such subscription per status line controller and hands each frame to the controller's own
// emitter, the one the command's output goes through, so the bar is drawn by the code that always
// drew it.
//
// THE COMMAND KEEPS RUNNING. The daemon draws a session's frames from the latest statusline JSON it
// was sent, and the command is what sends it: Claude Code builds that JSON and runs the command on
// its own schedule, as it always has, so the data stays exactly as fresh as a stock session's. What
// changes is what the command's own answer is used for. While frames arrive, the answer handed back
// to the controller is the newest pushed frame, not the command's output — that output is the bar
// as it stood when the command ran, an instant older than the frame already on screen, and showing
// it would step the animation backwards once a tick. While no frames arrive (no daemon listening,
// one too old to know `subscribe`, a session it has no data for yet), the command's output is the
// answer, exactly as in a stock session: both come from the same daemon's one renderer, so this is
// not a fallback to a different source. [LAW:one-source-of-truth]
//
// [LAW:effects-at-boundaries] the socket is passed in (`connect`), so the suite drives this with no
// daemon. The one thing this module knows of cc-candybar's internals is its wire contract, below.

'use strict';

// cc-candybar's wire contract (its src/daemon/protocol.ts): every frame a 4-byte big-endian length
// and a UTF-8 JSON body; a request names the protocol version it speaks; the daemon listens on the
// socket `CC_CANDYBAR_SOCKET` names, else the one derived from the user's uid. A daemon on another
// version answers VERSION_MISMATCH, which this module reports and stops on — never guesses past.
const PROTOCOL_VERSION = 3;
const HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const daemonSocketPath = (env, uid) => env.CC_CANDYBAR_SOCKET || `/tmp/cc-candybar-${uid}/socket`;

const encodeFrame = (value) => {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
};

// Calls `onFrame` with each complete frame's parsed body; `onError` once, on a frame that cannot be
// one (too large, not JSON), after which it reads nothing more.
function frameReader(onFrame, onError) {
  let buf = Buffer.alloc(0);
  let broken = false;
  return (chunk) => {
    if (broken) return;
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= HEADER_BYTES) {
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) { broken = true; onError(new Error(`frame too large: ${len}`)); return; }
      if (buf.length < HEADER_BYTES + len) return;
      const body = buf.subarray(HEADER_BYTES, HEADER_BYTES + len).toString('utf8');
      buf = buf.subarray(HEADER_BYTES + len);
      let frame;
      try { frame = JSON.parse(body); } catch (e) { broken = true; onError(e); return; }
      onFrame(frame);
    }
  };
}

// What Claude Code does to a status line command's stdout before it draws it (MEASURED in 2.1.299's
// command runner: trim, trim each line, drop the empty ones; nothing left is no status line). A
// pushed frame goes through the same, so it draws exactly as the command's output would.
const asStatusText = (output) =>
  output.trim().split('\n').flatMap((line) => line.trim() || []).join('\n') || undefined;

// The animation lane this subscription is (cc-candybar candybar-animation-wbxz.81o.azo): the daemon
// streams it only while the session's settings switch it on (`🧪 statusline (B)` in the settings
// menu, `globals.experimentalStatusline`), and refuses it SWITCHED_OFF otherwise.
const LANE = 'statusline';

// How long a subscription the daemon refused SWITCHED_OFF waits before it asks again: a toggle turned
// on is picked up within this, and a lane left off costs the daemon one refusal per wait, not one per
// run of the command.
const SWITCHED_OFF_RETRY_MS = 5000;

// [LAW:types-are-the-program] One controller's subscription, as state: none open; one open and not
// yet carrying frames; one carrying frames, with the newest; switched off in the session's settings
// as of `at` (ms), asked again once SWITCHED_OFF_RETRY_MS has passed; or refused for good by the
// daemon (a version it does not speak, a request it does not know), which is not retried for that
// session.
//   { kind: 'closed' } | { kind: 'open', socket } | { kind: 'live', socket, text } |
//   { kind: 'off', at } | { kind: 'refused', reason }

function createStatusLinePush({ connect, socketPath, report, now = Date.now }) {
  // WEAK, so a controller the app drops takes its subscription's bookkeeping with it. The socket
  // itself is closed by the stream ending or by the session moving; a controller that stops running
  // its command and is collected leaves its socket to close when the daemon or the process does.
  const feeds = new WeakMap();

  const open = (feed, sessionId) => {
    const socket = connect(socketPath);
    feed.sessionId = sessionId;
    feed.state = { kind: 'open', socket };
    const mine = () => feed.state.socket === socket;
    const end = (why) => {
      if (!mine()) return;
      feed.state = { kind: 'closed' };
      socket.destroy();
      report(`statusline-push sid=${JSON.stringify(sessionId)} ended: ${why}`);
    };
    socket.on('connect', () => {
      socket.write(encodeFrame({ v: PROTOCOL_VERSION, kind: 'subscribe', sessionId, lane: LANE }));
      if (!feed.off) report(`statusline-push sid=${JSON.stringify(sessionId)} subscribed`);
    });
    socket.on('data', frameReader(
      (resp) => {
        if (!mine()) return;
        if (resp && resp.ok === true && typeof resp.output === 'string') {
          const text = asStatusText(resp.output);
          feed.state = { kind: 'live', socket, text };
          feed.off = false;
          feed.emit(text);
          return;
        }
        const code = resp && resp.code;
        // A daemon that does not know the request, or speaks another version, will refuse it the
        // same way next tick: stop asking for this session, and say why once.
        if (code === 'BAD_REQUEST' || code === 'VERSION_MISMATCH') {
          feed.state = { kind: 'refused', reason: `${code}: ${resp.error}` };
          socket.destroy();
          report(`statusline-push sid=${JSON.stringify(sessionId)} refused: ${code}: ${resp.error}`);
          return;
        }
        // The lane is switched off in the session's settings: the command's own answer shows, and
        // the subscription is asked again after a wait. Said once, until a frame streams again.
        if (code === 'SWITCHED_OFF') {
          feed.state = { kind: 'off', at: now() };
          socket.destroy();
          if (!feed.off) report(`statusline-push sid=${JSON.stringify(sessionId)} switched off: ${resp.error}`);
          feed.off = true;
          return;
        }
        // A frame the daemon could not draw: the command's own answer shows how it failed, as in a
        // stock session, until a frame draws again.
        feed.state = { kind: 'open', socket };
        report(`statusline-push sid=${JSON.stringify(sessionId)} frame failed: ${code}: ${resp && resp.error}`);
      },
      (e) => end(`unreadable frame: ${e.message}`),
    ));
    socket.on('error', (e) => end(e.message));
    socket.on('close', () => end('closed by the daemon'));
  };

  // What the spliced statement calls each time the controller runs its command: the controller, the
  // statusline JSON it built, its own emitter, and the run itself. Always a promise, so the splice's
  // `||` never reaches the original call it leaves in place.
  async function statusLine(controller, payload, emit, run) {
    // `off`: the last refusal said the lane is switched off, so the retries it causes are not news.
    const feed = feeds.get(controller) || { sessionId: null, state: { kind: 'closed' }, emit, off: false };
    feeds.set(controller, feed);
    feed.emit = emit;
    // [LAW:dataflow-not-control-flow] the session the subscription is for is read off every payload,
    // so a new session id (after /clear) moves it, and a closed one reopens on the next run.
    const sessionId = payload.session_id;
    const moved = feed.sessionId !== sessionId;
    if (moved && feed.state.socket) {
      const old = feed.state.socket;
      feed.state = { kind: 'closed' };
      old.destroy();
    }
    if (moved) feed.off = false;
    const due = feed.state.kind === 'closed' ||
      (feed.state.kind === 'off' && now() - feed.state.at >= SWITCHED_OFF_RETRY_MS);
    if (moved || due) open(feed, sessionId);
    const ran = await run();
    return feed.state.kind === 'live' ? feed.state.text : ran;
  }

  return { statusLine };
}

module.exports = { LANE, PROTOCOL_VERSION, SWITCHED_OFF_RETRY_MS, asStatusText, createStatusLinePush, daemonSocketPath, encodeFrame, frameReader };
