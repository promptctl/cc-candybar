// A throwaway loopback server: a dependency-free WebSocket on node:http's upgrade.
// Real frames at 30 fps with newest-wins backpressure; clicks and visibility on one connection.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
const list = JSON.parse(fs.readFileSync("/tmp/ccb-probe/frames.json", "utf8")).map((f) => JSON.stringify(f));
const seen = { clicks: [], visibility: [], dropped: 0, sent: 0, badOrigin: 0 };
const encode = (text) => {
  const body = Buffer.from(text);
  const n = body.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : null;
  if (head === null) throw new Error("frame too large for the probe");
  return Buffer.concat([head, body]);
};
const decoder = (onText) => {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15;
      let n = buf[1] & 127;
      let at = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); at = 4; }
      if (buf.length < at + 4 + n) return;
      const mask = buf.subarray(at, at + 4);
      const data = Buffer.from(buf.subarray(at + 4, at + 4 + n));
      for (let i = 0; i < n; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(at + 4 + n);
      if (op === 1) onText(data.toString());
    }
  };
};
const page = `<!doctype html><meta charset=utf-8><title>ws probe</title>
<style>body{margin:0;background:#111;font:14px ui-monospace,Menlo,monospace;white-space:pre}.r{height:1.3em}a{color:inherit}</style><div id=bar></div><script>
window.stats={n:0,draw:0,gaps:[],last:0,bytes:0,click:[]};const bar=document.getElementById('bar');let pending=null;
const paint=()=>{if(pending){const t0=performance.now(),f=pending;pending=null;const frag=document.createDocumentFragment();
 for(const row of f){const d=document.createElement('div');d.className='r';for(const r of row){const s=document.createElement('span');s.textContent=r.t;
  if(r.fg&&r.fg.startsWith('#'))s.style.color=r.fg;if(r.bg&&r.bg.startsWith('#'))s.style.background=r.bg;if(r.link)s.dataset.link=r.link;d.appendChild(s)}frag.appendChild(d)}
 bar.replaceChildren(frag);const t1=performance.now();stats.draw+=t1-t0;stats.n++;if(stats.last)stats.gaps.push(t1-stats.last);stats.last=t1}requestAnimationFrame(paint)};requestAnimationFrame(paint);
const ws=new WebSocket('ws://'+location.host+'/s');window.ws=ws;
ws.onmessage=e=>{if(e.data.startsWith('ack')){stats.click.push(performance.now()-stats.t);return}stats.bytes+=e.data.length;pending=JSON.parse(e.data)};
bar.addEventListener('pointerdown',e=>{const a=e.target.closest('[data-link]');if(!a)return;stats.t=performance.now();ws.send('click '+a.dataset.link.slice(0,40))});
document.addEventListener('visibilitychange',()=>ws.send('visible '+!document.hidden));
</script>`;
const server = http.createServer((req, res) => {
  if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(page); return; }
  if (req.url === "/seen") { res.end(JSON.stringify(seen)); return; }
  res.writeHead(404); res.end();
});
server.on("upgrade", (req, sock) => {
  if (req.headers.origin !== "http://127.0.0.1:8978") { seen.badOrigin++; sock.destroy(); return; }
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let i = 0, waiting = null, blocked = false;
  const send = (b) => { seen.sent++; blocked = !sock.write(b); };
  sock.on("drain", () => { blocked = false; if (waiting) { const w = waiting; waiting = null; send(w); } });
  const t = setInterval(() => {
    const b = encode(list[i++ % list.length]);
    if (blocked) { if (waiting) seen.dropped++; waiting = b; } else send(b);
  }, 33);
  sock.on("data", decoder((text) => {
    if (text.startsWith("click ")) { seen.clicks.push(text.slice(6)); sock.write(encode("ack")); }
    if (text.startsWith("visible ")) seen.visibility.push(text.slice(8));
  }));
  sock.on("close", () => clearInterval(t));
  sock.on("error", () => clearInterval(t));
});
server.listen(8978, "127.0.0.1", () => console.log("listening"));
