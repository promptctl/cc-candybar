// A throwaway loopback server: real frames over Server-Sent Events, clicks over POST.
import fs from "node:fs";
import http from "node:http";
const frames = fs.readFileSync("/tmp/ccb-probe/frames.json", "utf8");
const list = JSON.parse(frames).map((f) => JSON.stringify(f));
const clicks = [];
const page = `<!doctype html><meta charset=utf-8><title>probe</title>
<style>body{margin:0;background:#111;font:14px ui-monospace,Menlo,monospace;white-space:pre}a{color:inherit;text-decoration:none}.r{height:1.3em}</style>
<div id=bar></div><script>
window.stats={n:0,draw:0,gaps:[],last:0,bytes:0,sent:[]};
const bar=document.getElementById('bar');
let pending=null;
const paint=()=>{ if(!pending){requestAnimationFrame(paint);return}
 const t0=performance.now();const f=pending;pending=null;
 const frag=document.createDocumentFragment();
 for(const row of f){const d=document.createElement('div');d.className='r';
  for(const r of row){const s=document.createElement(r.link?'a':'span');s.textContent=r.t;
   if(r.fg&&r.fg.startsWith('#'))s.style.color=r.fg; if(r.bg&&r.bg.startsWith('#'))s.style.background=r.bg;
   if(r.bold)s.style.fontWeight='bold'; if(r.link){s.href='#';s.dataset.link=r.link}
   d.appendChild(s)} frag.appendChild(d)}
 bar.replaceChildren(frag);
 const t1=performance.now();stats.draw+=t1-t0;stats.n++;if(stats.last)stats.gaps.push(t1-stats.last);stats.last=t1;
 requestAnimationFrame(paint)};
requestAnimationFrame(paint);
bar.addEventListener('click',e=>{const a=e.target.closest('a');if(!a)return;e.preventDefault();
 const t=performance.now();fetch('/click',{method:'POST',body:a.dataset.link}).then(()=>stats.sent.push(performance.now()-t))});
const es=new EventSource('/frames');es.onmessage=e=>{stats.bytes+=e.data.length;pending=JSON.parse(e.data)};
</script>`;
http.createServer((req, res) => {
  if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(page); return; }
  if (req.url === "/frames") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    let i = 0;
    const t = setInterval(() => res.write(`data: ${list[i++ % list.length]}\n\n`), 33);
    req.on("close", () => clearInterval(t));
    return;
  }
  if (req.url === "/click") {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { clicks.push(b.slice(0, 60)); res.end("ok"); });
    return;
  }
  if (req.url === "/clicks") { res.end(JSON.stringify(clicks)); return; }
  res.writeHead(404); res.end();
}).listen(8977, "127.0.0.1", () => console.log("listening"));
