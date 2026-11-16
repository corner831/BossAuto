// background.js (MV3 service worker)
// 职责：
// 1) 缓存并广播投递进度（原职责）；
// 2) 代理大模型打分请求 —— MV3 里内容脚本不能跨域请求，所以 HTTP 调用必须在这里做；
// 3) 缓存打分结果，避免同一个岗位重复花 token；
// 4) 被内容脚本定时 ping 以保持 service worker 存活（MV3 默认 30 秒空闲即回收，
//    如果打分请求还没回来 worker 被杀，内容脚本就永远等不到回复）。

importScripts('/src/shared/utils.js', '/src/shared/scoring.js');

const STORAGE_KEY_CONFIG = 'ba_config';
const STORAGE_KEY_SCORE_CACHE = 'ba_score_cache';
const SCORE_CACHE_LIMIT = 2000;

let latestState = {
  running: false,
  appliedCount: 0,
  skippedCount: 0,
  errorCount: 0,
  log: []
};

// ---------- 进度广播 ----------
// 除了内存和 session 存储，再往 storage.local 落一份快照：
// MV3 的 service worker 随时可能被回收，而 popup 一关就会重新打开、重新拉状态，
// 只靠内存/session 会出现"关一下弹窗进度就没了"的观感问题。
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'BA_PROGRESS') {
    latestState = message.payload;
    chrome.storage.session.set({ ba_latest_state: latestState }).catch(() => {});
    chrome.storage.local
      .set({ ba_last_progress: { ...latestState, fromHistory: false, savedAt: Date.now() } })
      .catch(() => {});

    if (sender.tab && sender.tab.id) {
      const badgeText = latestState.running ? String(latestState.appliedCount) : '';
      chrome.action.setBadgeText({ text: badgeText, tabId: sender.tab.id }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#2563eb', tabId: sender.tab.id }).catch(() => {});
    }
  }
  return false;
});

// ---------- 打分代理 ----------
// 接口地址补全用 scoring.js 里的 normalizeEndpoint（纯函数，已在上面 importScripts 载入，
// 并且有单元测试覆盖），这里不再重复实现，避免两处逻辑漂移。

async function readConfig() {
  const data = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
  return data[STORAGE_KEY_CONFIG] || {};
}

async function readScoreCache() {
  const data = await chrome.storage.local.get(STORAGE_KEY_SCORE_CACHE);
  return data[STORAGE_KEY_SCORE_CACHE] || {};
}

async function writeScoreCache(cache) {
  const entries = Object.entries(cache);
  if (entries.length > SCORE_CACHE_LIMIT) {
    // 简单裁剪：按写入时间保留最新的 N 条
    entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    cache = Object.fromEntries(entries.slice(0, SCORE_CACHE_LIMIT));
  }
  await chrome.storage.local.set({ [STORAGE_KEY_SCORE_CACHE]: cache });
}

/**
 * 调一次兼容 OpenAI 的 chat/completions。
 * @returns {Promise<{ok:boolean, text?:string, error?:string, status?:number}>}
 */
async function callChatApi({ endpoint, apiKey, model, messages, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || SCORE_DEFAULTS.timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || SCORE_DEFAULTS.model,
        messages,
        temperature: 0.2,
        // 要求返回 JSON；不支持的接口会忽略这个字段，不影响兼容性
        response_format: { type: 'json_object' },
        stream: false
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      let hint = '';
      if (res.status === 401 || res.status === 403) hint = 'API Key 无效或无权限';
      else if (res.status === 429) hint = '请求过于频繁被限流';
      else if (res.status >= 500) hint = '模型服务端错误';
      return { ok: false, status: res.status, error: `HTTP ${res.status}${hint ? ` ${hint}` : ''}：${bodyText.slice(0, 200)}` };
    }

    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) return { ok: false, error: '接口返回里没有 message.content（可能不是兼容 OpenAI 的接口）' };
    return { ok: true, text };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? `请求超时（>${(timeoutMs || SCORE_DEFAULTS.timeoutMs) / 1000}s）` : e.message;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 给一个岗位打分（带缓存）。
 * @param {{job: object, jd: string}} payload
 */
async function scoreJob(payload) {
  const config = await readConfig();
  if (!config.apiKey) {
    return { ok: false, error: '未配置 API Key：请在插件弹窗的「AI 智能匹配」里填写并保存' };
  }

  const profile = config.profile || '';
  // 用户自定义的判断标准（留空则用默认）；改提示词会让缓存键变化，避免拿到旧结论
  const customPrompt = config.aiPrompt || '';
  const endpoint = normalizeEndpoint(config.apiEndpoint);
  const model = config.apiModel || SCORE_DEFAULTS.model;

  const key = scoreCacheKey(`${profile}\u0000${customPrompt}`, payload.job, payload.jd);
  const cache = await readScoreCache();
  if (cache[key]) {
    return { ok: true, cached: true, result: cache[key] };
  }

  const messages = buildScoreMessages({ profile, job: payload.job, jd: payload.jd, systemPrompt: customPrompt });

  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await callChatApi({
      endpoint,
      apiKey: config.apiKey,
      model,
      messages,
      timeoutMs: config.apiTimeoutMs || SCORE_DEFAULTS.timeoutMs
    });
    if (r.ok) {
      const parsed = parseScoreResponse(r.text);
      if (!parsed) {
        return { ok: false, error: `模型返回无法解析为 JSON：${String(r.text).slice(0, 160)}` };
      }
      cache[key] = { ...parsed, ts: Date.now() };
      await writeScoreCache(cache);
      return { ok: true, cached: false, result: parsed };
    }
    lastError = r.error || '未知错误';
    // 401/403 重试没有意义，直接返回
    if (r.status === 401 || r.status === 403) break;
    if (attempt === 0) await new Promise((res) => setTimeout(res, backoffDelay(0, 800, 4000)));
  }

  return { ok: false, error: lastError };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'BA_GET_LATEST_STATE') {
    // 依次尝试：session（本次浏览器会话）→ local（上次快照，带 fromHistory 标记）→ 内存
    (async () => {
      try {
        const s = await chrome.storage.session.get('ba_latest_state');
        if (s.ba_latest_state) return sendResponse(s.ba_latest_state);
      } catch (e) {
        // 某些版本没有 storage.session，忽略
      }
      try {
        const l = await chrome.storage.local.get('ba_last_progress');
        if (l.ba_last_progress) return sendResponse({ ...l.ba_last_progress, fromHistory: true });
      } catch (e) {
        // 忽略
      }
      sendResponse(latestState);
    })();
    return true;
  }

  // 内容脚本在运行期间定时 ping，防止 service worker 被打分请求中途回收
  if (message.type === 'BA_PING') {
    sendResponse({ ok: true, ts: Date.now() });
    return false;
  }

  if (message.type === 'BA_SCORE') {
    scoreJob({ job: message.job, jd: message.jd })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // 异步响应
  }

  if (message.type === 'BA_CLEAR_SCORE_CACHE') {
    chrome.storage.local.remove(STORAGE_KEY_SCORE_CACHE).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
