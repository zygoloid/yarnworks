// Dev helper: load a page in headless Chrome via the DevTools protocol,
// print console output and exceptions, optionally run a script in the page,
// and save a screenshot.
//
// Usage: node tools/shot.mjs <url> <out.png> [--eval "js"] [--wait ms] [--width w] [--height h]
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const url = args[0];
const out = args[1];
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const evalJs = opt('--eval', null);
const wait = parseInt(opt('--wait', '3000'), 10);
const width = parseInt(opt('--width', '1400'), 10);
const height = parseInt(opt('--height', '900'), 10);
const chromePath = process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome';
const port = 9333;

const chrome = spawn(chromePath, [`--remote-debugging-port=${port}`, '--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox', `--window-size=${width},${height}`, '--user-data-dir=' + (process.env.TEMP || '/tmp') + '\\yarnworks-chrome', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let targets = null;
  for (let i = 0; i < 50 && !targets; i++) {
    await sleep(200);
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); targets = await r.json(); } catch (e) { /* retry */ }
  }
  if (!targets) throw new Error('Chrome did not start');
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value !== undefined ? String(a.value) : a.description || a.type).join(' ');
      console.log(`[console.${msg.params.type}] ${text}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      const desc = d.exception && d.exception.description || d.text;
      console.log(`[exception] ${desc} (${d.url || ''}:${d.lineNumber}:${d.columnNumber})`);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error' || e.level === 'warning') console.log(`[log.${e.level}] ${e.text} ${e.url || ''}`);
    }
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(wait);
  if (evalJs) {
    const r = await send('Runtime.evaluate', { expression: evalJs, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.log('[eval exception]', r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text);
    else console.log('[eval]', JSON.stringify(r.result.value));
    await sleep(500);
  }
  if (out) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('[shot]', out);
  }
  ws.close();
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => { chrome.kill(); });
