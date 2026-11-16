// 开发辅助脚本：用 CDP 在 Edge 里加载未打包扩展，验证
//   1) 扩展能被加载；2) service worker 里的共享模块可用；3) popup 无 JS 报错；4) 截图。
//
// 用法: node tools/verify-extension.mjs <扩展路径> <临时配置目录> <截图路径> <日志路径>
// 依赖：Windows + Edge 默认安装路径（见下方 EDGE 常量），其他环境请自行修改。
// 注意：Edge/Chrome 不允许在默认用户配置目录上开远程调试，所以必须传一个临时目录。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const [extPath, profileDir, shotPath, logPath] = process.argv.slice(2);
const port = 9353;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  '--enable-unsafe-extension-debugging',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-crash-reporter',
  '--disable-gpu',
  '--headless=new',
  '--window-size=420,1000',
  'about:blank'
];

const fd = openSync(logPath, 'w');
const child = spawn(EDGE, args, { stdio: ['ignore', fd, fd], env });
child.on('error', (e) => console.log('SPAWN_ERROR ' + e.message));

let version = null;
for (let i = 0; i < 120; i++) {
  await sleep(200);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (r.ok) { version = await r.json(); break; }
  } catch { /* not ready */ }
  if (child.exitCode !== null) { console.log('BROWSER_EXITED code=' + child.exitCode); break; }
}
if (!version) {
  console.log('RESULT devtools_unavailable');
  try { child.kill(); } catch {}
  closeSync(fd);
  process.exit(2);
}

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
ws.onclose = () => {};

let seq = 0;
const pending = new Map();
const events = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method) {
    events.push(msg);
  }
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

let extId = null;
try {
  const r = await send('Extensions.loadUnpacked', { path: extPath });
  extId = r.id;
  console.log('LOAD_UNPACKED ok id=' + extId);
} catch (e) {
  console.log('LOAD_UNPACKED failed: ' + e.message);
  try { await send('Browser.close'); } catch {}
  await sleep(300);
  try { child.kill(); } catch {}
  closeSync(fd);
  process.exit(3);
}

// --- 1) 检查 service worker 是否活着、importScripts 是否成功 ---
await sleep(1500);
let swChecked = false;
for (let i = 0; i < 20 && !swChecked; i++) {
  const { targetInfos } = await send('Target.getTargets');
  const sw = targetInfos.find((t) => (t.url || '').includes('/src/background/background.js'));
  if (sw) {
    try {
      const { sessionId } = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
      const r = await send('Runtime.evaluate', {
        expression: `JSON.stringify({
          hasScoring: typeof SCORE_DEFAULTS !== 'undefined',
          hasUtils: typeof listSignatureOf !== 'undefined',
          hasParse: typeof parseScoreResponse !== 'undefined',
          hasNormalize: typeof normalizeEndpoint === 'function',
          defaultModel: typeof SCORE_DEFAULTS !== 'undefined' ? SCORE_DEFAULTS.model : null,
          normalizeSample: typeof normalizeEndpoint === 'function' ? normalizeEndpoint('https://api.deepseek.com') : null
        })`,
        returnByValue: true
      }, sessionId);
      console.log('SERVICE_WORKER ' + r.result.value);
      swChecked = true;
    } catch (e) {
      console.log('SW_ATTACH_FAIL ' + e.message);
    }
  }
  if (!swChecked) await sleep(400);
}
if (!swChecked) console.log('SERVICE_WORKER not_running（可能已休眠，不一定代表出错）');

// --- 2) 打开 popup，收集控制台报错 ---
const popupUrl = `chrome-extension://${extId}/src/popup/popup.html`;
const { targetId } = await send('Target.createTarget', { url: popupUrl });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Log.enable', {}, sessionId);
await sleep(2500);

const probe = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    version: chrome.runtime.getManifest().version,
    manifestVersion: chrome.runtime.getManifest().manifest_version,
    aiSection: !!document.getElementById('ai-section'),
    refreshSection: !!document.getElementById('refresh-section'),
    selfcheckBtn: !!document.getElementById('selfcheck-btn'),
    clearCacheBtn: !!document.getElementById('clear-cache-btn'),
    clearSeenBtn: !!document.getElementById('clear-seen-btn'),
    apiEndpointValue: (document.getElementById('apiEndpoint')||{}).value,
    aiThresholdValue: (document.getElementById('aiThreshold')||{}).value,
    refreshIntervalValue: (document.getElementById('refreshIntervalMin')||{}).value,
    greetingDefault: ((document.getElementById('greeting')||{}).value||'').slice(0,18),
    permissionApi: typeof chrome.permissions !== 'undefined',
    bodyHeight: document.body.scrollHeight
  })`,
  returnByValue: true
}, sessionId);
console.log('POPUP_PROBE ' + probe.result.value);

// --- 3) 触发一次自检按钮，确认不会抛异常（当前不是 zhipin 页面，应给出友好提示）---
await send('Runtime.evaluate', { expression: `document.getElementById('selfcheck-btn').click()` }, sessionId);
await sleep(1200);
const selfcheck = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    visible: !document.getElementById('selfcheck-out').classList.contains('hidden'),
    text: (document.getElementById('selfcheck-out').textContent||'').slice(0,120)
  })`,
  returnByValue: true
}, sessionId);
console.log('SELFCHECK_CLICK ' + selfcheck.result.value);

// --- 4) 用真实用户数据形状验证自检报告格式化（不依赖真实页面）---
const mockOk = await send('Runtime.evaluate', {
  expression: `formatSelfCheck({
    url: 'https://www.zhipin.com/web/geek/jobs?city=101010100&query=%E5%AE%89%E5%85%A8',
    isJobPage: true,
    cardCount: 15,
    selectors: {
      jobCard: { selector: '.job-card-wrapper', count: 15 },
      jobTitle: { selector: '.job-name', count: 15 },
      companyName: { selector: null, count: 0 },
      jobSalary: { selector: null, count: 0 },
      jobTags: { selector: '.tag-list', count: 15 },
      cardChatButton: { selector: null, count: 0 },
      nextPageButton: { selector: null, count: 0 },
      searchInput: { selector: '#new-search-keyword', count: 1 }
    },
    firstCard: { title: '机场产品经理', company: '', salary: '', jobId: '/job_detail/x.html', hasHref: true },
    cardShape: { cardClass: 'job-card-wrapper', children: ['a.job-card-left 「机场产品经理」', 'div.company-info 「某公司」'] },
    pagination: { hasNextPageText: false, candidates: [{ cls: 'options-pages', text: '1 2 3' }] },
    nextButtonText: null,
    jd: { length: 256, fetched: true, sample: '负责安全产品的规划与落地' }
  })`,
  returnByValue: true
}, sessionId);
console.log('---- 自检报告渲染预览 ----');
console.log(mockOk.result.value);

// --- 5) 报错汇总 ---
const errs = events
  .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => {
    if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      return 'EXCEPTION ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text);
    }
    return 'LOG_ERROR ' + e.params.entry.text;
  });
console.log('ERROR_COUNT ' + errs.length);
errs.slice(0, 10).forEach((e) => console.log('  ' + e));

// --- 5) 展开两个折叠面板后截图（便于人工确认配置项齐全）---
try {
  await send('Runtime.evaluate', { expression: `document.querySelectorAll('details').forEach(d => d.open = true)` }, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 2100, deviceScaleFactor: 1.5, mobile: false }, sessionId);
  await sleep(500);
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log('SCREENSHOT ' + shotPath);
} catch (e) {
  console.log('SHOT_FAIL ' + e.message);
}

try { await send('Browser.close'); } catch {}
await sleep(500);
try { child.kill(); } catch {}
closeSync(fd);
console.log('RESULT ok');
process.exit(0);
