#!/usr/bin/env node
/*
 * share.js — self-hosted LAN clipboard & file bridge. One file, zero deps.
 *
 *   node share.js                start on port 8080, no auth
 *   node share.js --port 9090    use another port
 *   node share.js --pin 1234     require a PIN once per browser (cookie)
 *
 * Open the printed http://<lan-ip>:<port> URL on any device on the same
 * network. Text and files posted from one device appear on all the others
 * within a second (Server-Sent Events, no websockets).
 *
 * Everything lives in this file:
 *   1. config & CLI flags        4. route handlers
 *   2. state & housekeeping      5. server & routing
 *   3. small helpers             6. the page (HTML/CSS/JS template, at the end)
 *
 * State is in memory; uploaded files go to a temp dir that is wiped on exit.
 * Nothing survives a restart — that is the point.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 1. Config — tweak here
// ---------------------------------------------------------------------------

const MAX_FILE = 200 * 1024 * 1024;   // per uploaded file
const MAX_TOTAL = 1024 * 1024 * 1024; // all stored files together
const MAX_ITEMS = 200;                // feed length (text + files)
const MAX_TEXT = 2 * 1024 * 1024;     // largest accepted /text body
const ITEM_TTL = 60 * 60 * 1000;      // items expire after an hour
const HEARTBEAT = 25 * 1000;          // SSE keep-alive interval

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf('--' + name);
  if (i !== -1 && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) return args[i + 1];
  const pref = args.find(a => a.startsWith('--' + name + '='));
  return pref ? pref.slice(name.length + 3) : undefined;
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node share.js [--port 8080] [--pin 1234]');
  process.exit(0);
}
const PORT = Number(flag('port') || 8080);
const PIN = flag('pin') || null;
const AUTH_TOKEN = crypto.randomBytes(16).toString('hex'); // cookie value while --pin is on

// ---------------------------------------------------------------------------
// 2. State & housekeeping
// ---------------------------------------------------------------------------

const DIR = path.join(os.tmpdir(), 'lanshare-' + process.pid);
fs.mkdirSync(DIR, { recursive: true });

const items = [];          // newest first: {id, type:'text'|'file', text?, name?, size?, mime?, ts}
let totalBytes = 0;        // bytes on disk (file items only)
const clients = new Set(); // open SSE responses

let cleaned = false;
function wipe() {
  if (cleaned) return;
  cleaned = true;
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}
process.on('exit', wipe);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nShutting down — wiping ' + DIR);
    wipe();
    process.exit(0);
  });
}

// expire old items once a minute
setInterval(() => {
  const cutoff = Date.now() - ITEM_TTL;
  for (const it of items.filter(it => it.ts < cutoff)) removeItem(it.id);
}, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// 3. Small helpers
// ---------------------------------------------------------------------------

const newId = () => crypto.randomBytes(8).toString('hex');

// svg is technically an image but can contain script, so serve it as a download
const inlineImage = mime => mime.startsWith('image/') && mime !== 'image/svg+xml';

// percent-encoding for Content-Disposition filename* (RFC 5987)
const rfc5987 = s => encodeURIComponent(s).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16));

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function html(res, body) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

// collect a small body (JSON endpoints only — uploads stream to disk instead)
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { req.pause(); reject(new Error('too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new Error('read error')));
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const authed = req => !PIN || cookies(req).lanshare === AUTH_TOKEN;

function broadcast(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const c of clients) {
    try { c.write(msg); } catch (e) { clients.delete(c); }
  }
}

function addItem(item) {
  items.unshift(item);
  broadcast('add', item);
}

function removeItem(id) {
  const i = items.findIndex(it => it.id === id);
  if (i === -1) return false;
  const [it] = items.splice(i, 1);
  if (it.type === 'file') {
    totalBytes -= it.size;
    fs.unlink(path.join(DIR, it.id), () => {});
  }
  broadcast('remove', { id });
  return true;
}

// ---------------------------------------------------------------------------
// 4. Route handlers
// ---------------------------------------------------------------------------

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write('event: init\ndata: ' + JSON.stringify(items) + '\n\n'); // full state on connect
  res.on('error', () => clients.delete(res));
  req.on('close', () => clients.delete(res));
  clients.add(res);
}

// Heartbeat: the comment keeps the TCP stream alive through sleepy phones and
// proxies; the ping event lets the page detect a zombie connection (iOS Safari
// can leave an EventSource that looks open but is dead — see client watchdog).
setInterval(() => {
  broadcastRaw(': hb\n\nevent: ping\ndata: ' + Date.now() + '\n\n');
}, HEARTBEAT).unref();
function broadcastRaw(msg) {
  for (const c of clients) {
    try { c.write(msg); } catch (e) { clients.delete(c); }
  }
}

async function handleText(req, res) {
  if (items.length >= MAX_ITEMS) {
    return json(res, 413, { error: 'Item limit reached (' + MAX_ITEMS + ') — delete something first.' });
  }
  let text;
  try {
    text = JSON.parse((await readBody(req, MAX_TEXT)).toString('utf8')).text;
  } catch (e) {
    const tooBig = e.message === 'too large';
    json(res, tooBig ? 413 : 400, {
      error: tooBig ? 'Text is too large (2 MB max).' : 'Bad body — expected JSON {"text":"..."}.',
    });
    if (tooBig) res.once('close', () => req.destroy()); // stop the rest of the body
    return;
  }
  if (typeof text !== 'string' || !text.trim()) return json(res, 400, { error: 'Empty text.' });
  const item = { id: newId(), type: 'text', text, ts: Date.now() };
  addItem(item);
  json(res, 200, item);
}

// Raw-body upload: the file bytes ARE the request body, streamed straight to
// disk (never buffered in memory). Filename arrives URI-encoded in X-Filename,
// mime in Content-Type — no multipart parsing needed.
function handleUpload(req, res) {
  const bail = (code, msg) => {
    json(res, code, { error: msg });
    res.once('close', () => req.destroy()); // reply first, then stop the incoming body
  };

  if (items.length >= MAX_ITEMS) {
    return bail(413, 'Item limit reached (' + MAX_ITEMS + ') — delete something first.');
  }

  let name = 'file';
  try { name = decodeURIComponent(req.headers['x-filename'] || 'file'); } catch (e) { /* keep default */ }
  name = name.replace(/[/\\\u0000-\u001f]/g, '_').slice(0, 180).trim() || 'file';

  let mime = String(req.headers['x-mime'] || req.headers['content-type'] || '').split(';')[0].trim();
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) mime = 'application/octet-stream';

  const declared = Number(req.headers['content-length']) || 0;
  if (declared > MAX_FILE) return bail(413, 'File exceeds the ' + human(MAX_FILE) + ' per-file limit.');
  if (totalBytes + declared > MAX_TOTAL) return bail(413, 'Storage full (' + human(MAX_TOTAL) + ' cap) — delete some items.');

  const id = newId();
  const file = path.join(DIR, id);
  const out = fs.createWriteStream(file);
  let size = 0;
  let done = false;

  const fail = (code, msg) => {
    if (done) return;
    done = true;
    req.unpipe(out);
    out.destroy();
    fs.unlink(file, () => {});
    try { json(res, code, { error: msg }); } catch (e) { /* client already gone */ }
    res.once('close', () => req.destroy());
  };

  req.on('data', chunk => { // backstop for chunked uploads with no Content-Length
    if (done) return;
    size += chunk.length;
    if (size > MAX_FILE) fail(413, 'File exceeds the ' + human(MAX_FILE) + ' per-file limit.');
    else if (totalBytes + size > MAX_TOTAL) fail(413, 'Storage full (' + human(MAX_TOTAL) + ' cap) — delete some items.');
  });
  req.on('error', () => fail(500, 'Upload interrupted.'));
  req.on('close', () => { // client vanished mid-upload: clean up, nobody to answer
    if (!done && !req.complete) {
      done = true;
      out.destroy();
      fs.unlink(file, () => {});
    }
  });
  out.on('error', () => fail(500, 'Could not write the file to disk.'));
  out.on('finish', () => {
    if (done) return;
    done = true;
    totalBytes += size;
    const item = { id, type: 'file', name, size, mime, ts: Date.now() };
    addItem(item);
    json(res, 200, item);
  });
  req.pipe(out);
}

function handleFile(req, res, id, forceDownload) {
  const it = items.find(x => x.id === id && x.type === 'file');
  if (!it) return json(res, 404, { error: 'No such file — it may have expired.' });
  let stat;
  try { stat = fs.statSync(path.join(DIR, id)); } catch (e) {
    return json(res, 404, { error: 'File is gone from disk.' });
  }
  // inline for images so they open in a tab; everything else downloads
  const disposition = !forceDownload && inlineImage(it.mime) ? 'inline' : 'attachment';
  res.writeHead(200, {
    'Content-Type': it.mime,
    'Content-Length': stat.size,
    'Content-Disposition': disposition + "; filename*=UTF-8''" + rfc5987(it.name),
    'Cache-Control': 'private, max-age=3600, immutable', // an id's content never changes
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(path.join(DIR, id)).pipe(res);
}

async function handlePin(req, res) {
  let pin = '';
  try { pin = String(JSON.parse((await readBody(req, 1024)).toString('utf8')).pin || ''); } catch (e) {
    return json(res, 400, { error: 'Bad request.' });
  }
  if (PIN && pin === PIN) {
    const body = '{"ok":true}';
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'Set-Cookie': 'lanshare=' + AUTH_TOKEN + '; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax',
    });
    res.end(body);
  } else {
    setTimeout(() => json(res, 403, { error: 'Wrong PIN.' }), 700); // soft brake on guessing
  }
}

// ---------------------------------------------------------------------------
// 5. Server & routing
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  try {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    const route = req.method + ' ' + pathname;

    // public routes
    if (route === 'GET /') return html(res, authed(req) ? PAGE : PIN_PAGE);
    if (route === 'POST /pin') return handlePin(req, res);
    if (route === 'GET /me') return authed(req) ? json(res, 200, { ok: true }) : json(res, 401, { error: 'PIN required.' });
    if (route === 'GET /favicon.ico') { res.writeHead(204); return res.end(); }

    // everything below needs the PIN cookie when --pin is on
    if (!authed(req)) return json(res, 401, { error: 'PIN required — reload the page.' });

    if (route === 'GET /events') return handleEvents(req, res);
    if (route === 'POST /text') return handleText(req, res);
    if (route === 'POST /upload') return handleUpload(req, res);

    let m;
    if ((m = pathname.match(/^\/file\/([a-f0-9]{16})$/)) && (req.method === 'GET' || req.method === 'HEAD')) {
      return handleFile(req, res, m[1], searchParams.has('dl'));
    }
    if ((m = pathname.match(/^\/item\/([a-f0-9]{16})$/)) && req.method === 'DELETE') {
      return removeItem(m[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'No such item.' });
    }

    json(res, 404, { error: 'Not found.' });
  } catch (e) {
    try { json(res, 500, { error: 'Server error: ' + e.message }); } catch (e2) { /* socket gone */ }
  }
});

server.on('connection', sock => sock.setNoDelay(true)); // no Nagle — snappier SSE + small posts
server.requestTimeout = 0; // a 200 MB upload over slow wifi can outlive the 5-minute default

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' is already in use — try: node share.js --port ' + (PORT + 1));
    process.exit(1);
  }
  throw err;
});

function human(n) {
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)) + ' GB';
  if (n >= 1024 * 1024) return (n / (1024 * 1024)) + ' MB';
  return n + ' B';
}

server.listen(PORT, '0.0.0.0', () => {
  const urls = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) urls.push('http://' + i.address + ':' + PORT);
    }
  }
  console.log('\nLAN share is up. Open one of these on any device on this network:\n');
  if (urls.length) urls.forEach(u => console.log('   ' + u));
  else console.log('   (no LAN interface found — try http://localhost:' + PORT + ')');
  console.log('\n   files: ' + DIR);
  console.log('   caps:  ' + human(MAX_FILE) + '/file, ' + human(MAX_TOTAL) + ' total, ' +
    MAX_ITEMS + ' items, ' + Math.round(ITEM_TTL / 60000) + ' min lifetime');
  if (PIN) {
    console.log('   PIN:   required (--pin)');
  } else {
    console.log('\n   WARNING: no PIN set — ANYONE on this network can read and post to the feed.');
    console.log('   Start with `node share.js --pin 1234` to require one.');
  }
  console.log('\nCtrl-C to stop (all shared files are deleted on exit).\n');
});

// ---------------------------------------------------------------------------
// 6. The page — everything the browser gets is below this line
// ---------------------------------------------------------------------------
// Note for future hacking: this is a JS template literal, so backticks and
// ${ } inside the page's own <script> must be avoided (the client code below
// sticks to quotes and string concatenation for that reason).

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0e14">
<title>LAN Share</title>
<link rel="icon" href='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📋</text></svg>'>
<style>
  :root {
    --bg:#0b0e14; --panel:#141a23; --panel2:#1d2634; --line:#232d3d;
    --text:#e7ecf3; --dim:#8a95a6; --accent:#5aa7ff; --accent-ink:#06121f;
    --green:#3ddc84; --amber:#ffb454; --red:#ff7373; --radius:14px;
  }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html { color-scheme:dark; }
  body {
    margin:0; background:var(--bg); color:var(--text);
    font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding-bottom:env(safe-area-inset-bottom);
  }
  header {
    position:sticky; top:0; z-index:10;
    background:rgba(11,14,20,.9); -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px);
    border-bottom:1px solid var(--line);
    padding:calc(10px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 10px calc(16px + env(safe-area-inset-left));
  }
  .hwrap { max-width:720px; margin:0 auto; display:flex; align-items:center; gap:10px; }
  h1 { font-size:17px; margin:0; font-weight:700; letter-spacing:.2px; }
  #status { color:var(--dim); font-size:13px; margin-left:auto; }
  .dot { width:10px; height:10px; border-radius:50%; flex:none; }
  .dot.connected { background:var(--green); box-shadow:0 0 10px rgba(61,220,132,.7); }
  .dot.reconnecting { background:var(--amber); animation:pulse 1.1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity:.35; } }
  .wrap { max-width:720px; margin:0 auto; padding:16px calc(16px + env(safe-area-inset-right)) 48px calc(16px + env(safe-area-inset-left)); }
  textarea {
    width:100%; min-height:92px; padding:12px 14px; resize:vertical;
    background:var(--panel); color:var(--text); border:1px solid var(--line);
    border-radius:var(--radius); font:inherit; outline:none;
  }
  textarea:focus { border-color:var(--accent); }
  .btnrow { display:flex; gap:10px; margin-top:10px; flex-wrap:wrap; }
  .btn {
    display:inline-flex; align-items:center; justify-content:center;
    min-height:48px; padding:0 18px; border-radius:12px; border:1px solid var(--line);
    background:var(--panel2); color:var(--text); font:inherit; font-weight:600;
    cursor:pointer; user-select:none; -webkit-user-select:none;
  }
  .btn:active { transform:scale(.97); }
  .btn.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); flex:1; }
  .hint { color:var(--dim); font-size:13px; margin:10px 2px 0; }
  .item { position:relative; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:12px; margin-top:14px; }
  .meta { display:flex; align-items:center; gap:10px; margin-bottom:8px; color:var(--dim); font-size:13px; }
  .tag { font-size:11px; font-weight:700; letter-spacing:.6px; padding:3px 8px; border-radius:6px; background:var(--panel2); color:var(--accent); }
  .hinttap { font-size:12px; }
  .del {
    margin-left:auto; width:40px; height:40px; flex:none;
    border:0; border-radius:10px; background:transparent; color:var(--dim); font-size:16px; cursor:pointer;
  }
  .del:hover { background:var(--panel2); color:var(--red); }
  pre.txt {
    margin:0; padding:12px; background:#0d1118; border:1px solid var(--line); border-radius:10px;
    font:14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space:pre-wrap; word-break:break-word; overflow:auto; max-height:320px;
    cursor:pointer; -webkit-overflow-scrolling:touch;
  }
  .badge {
    position:absolute; top:12px; right:56px; z-index:2; background:var(--green); color:#052b16;
    font-size:12px; font-weight:700; padding:4px 10px; border-radius:999px;
    opacity:0; transform:translateY(4px); transition:all .18s; pointer-events:none;
  }
  .badge.on { opacity:1; transform:none; }
  .badge.err { background:var(--red); color:#2b0505; }
  a.thumb { display:block; }
  a.thumb img { display:block; max-width:100%; max-height:340px; border-radius:10px; background:#0d1118; }
  .nopreview { padding:18px; background:#0d1118; border:1px dashed var(--line); border-radius:10px; color:var(--dim); font-size:14px; }
  .fileline { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:8px; font-size:14px; }
  .fileline .icon { font-size:26px; }
  .fileline .fname { word-break:break-all; }
  .fileline .fsize { color:var(--dim); white-space:nowrap; }
  .dl { color:var(--accent); text-decoration:none; font-weight:600; padding:8px 4px; margin-left:auto; }
  .empty { display:none; color:var(--dim); text-align:center; margin-top:48px; }
  #feed:empty + .empty { display:block; }
  .uprow { background:var(--panel); border:1px dashed var(--line); border-radius:var(--radius); padding:10px 12px; margin-top:14px; font-size:14px; }
  .uphead { display:flex; gap:10px; align-items:center; }
  .upname { flex:1; word-break:break-all; }
  .uppct { color:var(--dim); }
  .upx { border:0; background:none; color:var(--dim); font-size:15px; cursor:pointer; width:36px; height:36px; flex:none; }
  .bar { height:6px; background:var(--panel2); border-radius:4px; overflow:hidden; margin-top:8px; }
  .bar i { display:block; height:100%; width:0; background:var(--accent); transition:width .15s; }
  .uprow.err { border-color:var(--red); }
  .uprow.err .upname { color:var(--red); }
  #dropzone {
    position:fixed; inset:0; z-index:50; display:none; align-items:center; justify-content:center;
    background:rgba(11,14,20,.85); font-size:22px; font-weight:700; color:var(--accent);
  }
  #dropzone > div { border:2px dashed var(--accent); border-radius:20px; padding:40px 60px; }
  body.dragging #dropzone { display:flex; }
  #toast {
    position:fixed; left:50%; bottom:calc(24px + env(safe-area-inset-bottom)); transform:translateX(-50%);
    background:var(--panel2); border:1px solid var(--line); color:var(--text);
    padding:12px 18px; border-radius:12px; font-size:14px; z-index:60; max-width:90vw;
  }
</style>
</head>
<body>
<header>
  <div class="hwrap">
    <span id="dot" class="dot reconnecting"></span>
    <h1>LAN Share</h1>
    <span id="status">connecting…</span>
  </div>
</header>
<main class="wrap">
  <section id="composer">
    <textarea id="txt" rows="3" placeholder="Type or paste here — pasting an image uploads it"
      autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
    <div class="btnrow">
      <button id="send" class="btn primary">Send</button>
      <label class="btn" for="pick">📎 File</label>
      <input id="pick" type="file" accept="image/*,*/*" multiple hidden>
      <label class="btn" for="photo">📷 Take photo</label>
      <input id="photo" type="file" accept="image/*" capture="environment" hidden>
    </div>
    <p class="hint">⌘/Ctrl+Enter sends · drop files anywhere · items vanish after ${Math.round(ITEM_TTL / 60000)} min</p>
  </section>
  <section id="uploads"></section>
  <div id="feed"></div><p class="empty">Nothing here yet — send some text or drop a file.</p>
</main>
<div id="dropzone"><div>Drop to share</div></div>
<div id="toast" hidden></div>
<script>
"use strict";
var CAPS = ${JSON.stringify({ maxFile: MAX_FILE })};
function $(s) { return document.querySelector(s); }
var feed = $('#feed'), txt = $('#txt'), dot = $('#dot'), statusEl = $('#status'),
    ups = $('#uploads'), toastEl = $('#toast');

// ---- little utils ---------------------------------------------------------

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function ago(ts) {
  var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm ago';
}
var toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.hidden = true; }, 3500);
}

// ---- clipboard ------------------------------------------------------------
// navigator.clipboard only works in secure contexts, and plain http on a LAN
// is not one (iOS Safari especially) — so keep the execCommand fallback.

function copyText(text, badge) {
  function done(ok) {
    badge.textContent = ok ? 'Copied ✓' : 'Copy failed';
    badge.classList.toggle('err', !ok);
    badge.classList.add('on');
    setTimeout(function () { badge.classList.remove('on'); }, 1300);
  }
  function legacy() {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', ''); // keeps the iOS keyboard closed
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;';
    document.body.appendChild(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    try { ta.setSelectionRange(0, ta.value.length); } catch (e) {} // iOS needs this after select()
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    done(ok);
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(function () { done(true); }, legacy);
  } else {
    legacy();
  }
}

// ---- feed rendering -------------------------------------------------------

function iconFor(mime) {
  mime = mime || '';
  if (mime.indexOf('image/') === 0) return '🖼️';
  if (mime.indexOf('video/') === 0) return '🎬';
  if (mime.indexOf('audio/') === 0) return '🎵';
  if (mime.indexOf('pdf') !== -1) return '📕';
  if (mime.indexOf('zip') !== -1 || mime.indexOf('compressed') !== -1) return '📦';
  return '📄';
}

function fileRow(it) {
  var row = el('div', 'fileline');
  row.appendChild(el('span', 'icon', iconFor(it.mime)));
  row.appendChild(el('span', 'fname', it.name));
  row.appendChild(el('span', 'fsize', fmtSize(it.size)));
  var a = el('a', 'dl', 'Download');
  a.href = '/file/' + it.id + '?dl=1';
  row.appendChild(a);
  return row;
}

function render(it) {
  var box = el('div', 'item');
  box.id = 'i-' + it.id;
  var isImg = it.type === 'file' && it.mime && it.mime.indexOf('image/') === 0;

  var meta = el('div', 'meta');
  meta.appendChild(el('span', 'tag', it.type === 'text' ? 'TEXT' : (isImg ? 'IMAGE' : 'FILE')));
  var t = el('span', 'time', ago(it.ts));
  t.setAttribute('data-ts', it.ts);
  meta.appendChild(t);
  if (it.type === 'text') meta.appendChild(el('span', 'hinttap', 'tap to copy'));
  var del = el('button', 'del', '✕');
  del.title = 'Delete for everyone';
  del.onclick = function () {
    fetch('/item/' + it.id, { method: 'DELETE' }).catch(function () { toast('Delete failed.'); });
  };
  meta.appendChild(del);
  box.appendChild(meta);

  var badge = el('span', 'badge', 'Copied ✓');
  box.appendChild(badge);

  if (it.type === 'text') {
    var pre = el('pre', 'txt', it.text);
    pre.onclick = function () {
      if (String(getSelection())) return; // user is selecting text, not tapping
      copyText(it.text, badge);
    };
    box.appendChild(pre);
  } else if (isImg) {
    var a = el('a', 'thumb');
    a.href = '/file/' + it.id;
    a.target = '_blank';
    a.rel = 'noopener';
    var img = el('img');
    img.alt = it.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onerror = function () { // HEIC & friends this browser can't decode: swap in a note
      a.replaceWith(el('div', 'nopreview', "🖼️ no preview — this browser can't decode this image format"));
    };
    img.src = '/file/' + it.id;
    a.appendChild(img);
    box.appendChild(a);
    box.appendChild(fileRow(it));
  } else {
    box.appendChild(fileRow(it));
  }
  return box;
}

function addNode(it, prepend) {
  if (document.getElementById('i-' + it.id)) return; // already have it (reconnect race)
  var node = render(it);
  if (prepend && feed.firstChild) feed.insertBefore(node, feed.firstChild);
  else feed.appendChild(node);
}
function setAll(list) { // server sends newest first
  feed.innerHTML = '';
  for (var i = 0; i < list.length; i++) addNode(list[i], false);
}
function removeNode(id) {
  var n = document.getElementById('i-' + id);
  if (n) n.remove();
}
setInterval(function () { // keep relative timestamps fresh
  var els = document.querySelectorAll('.time[data-ts]');
  for (var i = 0; i < els.length; i++) els[i].textContent = ago(Number(els[i].getAttribute('data-ts')));
}, 30000);

// ---- sending text ---------------------------------------------------------

function sendText() {
  var t = txt.value;
  if (!t.trim()) return;
  fetch('/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: t }),
  }).then(function (r) {
    if (r.ok) { txt.value = ''; return; } // the item itself arrives via SSE
    return r.json().then(
      function (j) { toast(j.error || ('Send failed (HTTP ' + r.status + ').')); },
      function () { toast('Send failed (HTTP ' + r.status + ').'); }
    );
  }).catch(function () { toast('Send failed — server unreachable?'); });
}
$('#send').onclick = sendText;
txt.addEventListener('keydown', function (e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendText(); }
});

// ---- uploads --------------------------------------------------------------
// XMLHttpRequest instead of fetch on purpose: fetch cannot report upload
// progress, xhr.upload.onprogress can.

function nameFor(f) {
  if (f.name) return f.name;
  var ext = ((f.type || '').split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
  return 'pasted-' + Date.now() + '.' + (ext || 'bin');
}

function uploadFile(f) {
  var name = nameFor(f);
  if (f.size > CAPS.maxFile) {
    toast('"' + name + '" is over the ' + fmtSize(CAPS.maxFile) + ' per-file limit.');
    return;
  }

  var row = el('div', 'uprow');
  var head = el('div', 'uphead');
  var nameEl = el('span', 'upname', name);
  head.appendChild(nameEl);
  var pct = el('span', 'uppct', '0%');
  head.appendChild(pct);
  var x = el('button', 'upx', '✕');
  head.appendChild(x);
  row.appendChild(head);
  var bar = el('div', 'bar');
  var fill = el('i');
  bar.appendChild(fill);
  row.appendChild(bar);
  ups.appendChild(row);

  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload');
  xhr.setRequestHeader('X-Filename', encodeURIComponent(name));
  xhr.setRequestHeader('Content-Type', f.type || 'application/octet-stream');
  xhr.upload.onprogress = function (e) {
    if (e.lengthComputable) {
      var p = Math.round((e.loaded / e.total) * 100);
      fill.style.width = p + '%';
      pct.textContent = p + '%';
    }
  };
  xhr.onload = function () {
    if (xhr.status === 200) { row.remove(); return; } // the item arrives via SSE
    var msg = 'Upload failed (HTTP ' + xhr.status + ').';
    try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {}
    failRow(msg);
  };
  xhr.onerror = function () { failRow('Upload failed — rejected by the server or connection lost.'); };
  xhr.onabort = function () { row.remove(); };
  x.onclick = function () { xhr.abort(); };
  function failRow(msg) {
    row.classList.add('err');
    pct.textContent = '';
    fill.style.width = '0';
    nameEl.textContent = name + ' — ' + msg;
    x.onclick = function () { row.remove(); };
  }
  xhr.send(f); // a Blob: the browser streams it, we never read it into memory
}
function uploadAll(list) {
  for (var i = 0; i < list.length; i++) uploadFile(list[i]);
}
$('#pick').addEventListener('change', function () { uploadAll(this.files); this.value = ''; });
$('#photo').addEventListener('change', function () { uploadAll(this.files); this.value = ''; });

// paste an image (or any file) anywhere on the page — including the textarea
document.addEventListener('paste', function (e) {
  var files = e.clipboardData && e.clipboardData.files;
  if (files && files.length) {
    e.preventDefault(); // don't dump a filename into the textarea
    uploadAll(files);
  }
});

// drag & drop anywhere (desktop)
var dragDepth = 0;
function hasFiles(e) {
  var t = e.dataTransfer && e.dataTransfer.types;
  if (!t) return false;
  for (var i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
  return false;
}
window.addEventListener('dragenter', function (e) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', function (e) {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove('dragging');
});
window.addEventListener('drop', function (e) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (e.dataTransfer.files.length) uploadAll(e.dataTransfer.files);
});

// ---- live feed (SSE) ------------------------------------------------------

var es = null, lastMsg = 0;
function setStatus(state) {
  dot.className = 'dot ' + state;
  statusEl.textContent = state === 'connected' ? 'connected' : 'reconnecting…';
}
function alive() { lastMsg = Date.now(); setStatus('connected'); }
function connect() {
  if (es) es.close();
  es = new EventSource('/events');
  lastMsg = Date.now();
  es.onopen = alive;
  es.onerror = function () {
    setStatus('reconnecting');
    if (es.readyState === 2) { // CLOSED = fatal, e.g. PIN cookie no longer valid after a restart
      fetch('/me').then(function (r) { if (r.status === 401) location.reload(); }, function () {});
    }
  };
  es.addEventListener('init', function (e) { alive(); setAll(JSON.parse(e.data)); });
  es.addEventListener('add', function (e) { alive(); addNode(JSON.parse(e.data), true); });
  es.addEventListener('remove', function (e) { alive(); removeNode(JSON.parse(e.data).id); });
  es.addEventListener('ping', alive);
}
connect();

// iOS Safari kills the stream while the tab is backgrounded and can leave a
// zombie EventSource that still claims to be open. Reconnect whenever the tab
// comes back, or when the server's ping (every 25s) has been missing too long.
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && (es.readyState === 2 || Date.now() - lastMsg > 45000)) connect();
});
window.addEventListener('pageshow', function () { if (es.readyState === 2) connect(); });
setInterval(function () {
  if (!document.hidden && (es.readyState === 2 || Date.now() - lastMsg > 70000)) connect();
}, 15000);
</script>
</body>
</html>
`;

const PIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0e14">
<title>LAN Share — PIN</title>
<style>
  body { margin:0; display:flex; min-height:100vh; align-items:center; justify-content:center;
         background:#0b0e14; color:#e7ecf3;
         font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  form { background:#141a23; border:1px solid #232d3d; border-radius:16px; padding:28px;
         width:min(90vw, 320px); text-align:center; }
  h1 { font-size:18px; margin:0 0 16px; }
  input { width:100%; padding:14px; font-size:22px; text-align:center; letter-spacing:6px;
          color:#e7ecf3; background:#0d1118; border:1px solid #232d3d; border-radius:12px; outline:none; }
  input:focus { border-color:#5aa7ff; }
  button { margin-top:14px; width:100%; padding:14px; font:inherit; font-weight:700;
           border:0; border-radius:12px; background:#5aa7ff; color:#06121f; cursor:pointer; }
  .err { color:#ff7373; font-size:14px; min-height:20px; margin:10px 0 0; }
</style>
</head>
<body>
<form id="f">
  <h1>🔒 Enter PIN</h1>
  <input id="pin" type="password"${/^\d+$/.test(PIN || '') ? ' inputmode="numeric"' : ''} autocomplete="one-time-code" enterkeyhint="go" autofocus>
  <button>Unlock</button>
  <p class="err" id="err"></p>
</form>
<script>
document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault();
  fetch('/pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: document.getElementById('pin').value }),
  }).then(function (r) {
    if (r.ok) { location.reload(); return; }
    document.getElementById('err').textContent = 'Wrong PIN, try again.';
    document.getElementById('pin').value = '';
  }).catch(function () {
    document.getElementById('err').textContent = 'Server unreachable.';
  });
});
</script>
</body>
</html>
`;
