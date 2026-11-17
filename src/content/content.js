// content.js
// 运行在 BOSS 直聘职位搜索页 (https://www.zhipin.com/web/geek/job*) 上，
// 负责实际的"搜索匹配职位 -> 智能打分 -> 打招呼 -> 投递"自动化流程。
//
// 相比 v1 的关键改动（都是针对实际使用中暴露的问题）：
// 1) 匹配不再只看"标题+标签"：会去抓职位详情正文（同源 fetch，不跳页），JD 参与关键词匹配；
// 2) 新增大模型打分：把"你的求职画像 + 职位信息 + JD"交给模型判 0-100 分，
//    低于阈值就跳过，并记录理由（模型调用在 background 里做，这里只发消息）；
// 3) 翻页健壮化：点击后校验"卡片列表签名/地址"是否真的变了，不再固定盲等 1500ms；
// 4) 页面导航续跑：如果翻页导致整页刷新把脚本上下文销毁，下次注入时能自动接着上次进度；
// 5) 定时刷新捞新岗位：一轮翻完可以等 N 分钟重新搜索，靠历史记录只投没投过的。
//
// 设计要点：
// - 完全基于当前已登录的页面 DOM 操作，不读取、不上传任何账号 / Cookie 信息。
//   （唯一的外发请求是用户自己配置的大模型接口，内容只有职位信息 + 你填的画像）
// - 状态保存在模块级对象里，独立于 popup 是否打开；
//   进度上报给 background，popup 打开时拉取最新状态，中途关闭 popup 不会丢进度。

(function () {
  const SEL = window.__BOSS_SELECTORS__ || (typeof BOSS_SELECTORS !== 'undefined' ? BOSS_SELECTORS : null);
  const MATCH = typeof matchJob !== 'undefined' ? matchJob : null;
  const PARSE_SALARY = typeof parseSalaryRange !== 'undefined' ? parseSalaryRange : null;
  const SIG = typeof listSignatureOf === 'function' ? listSignatureOf : (hrefs) => (hrefs || []).join('|');
  const SHOULD_APPLY = typeof shouldApply === 'function' ? shouldApply : null;
  const CLASSIFY = typeof classifyDetailFetch === 'function' ? classifyDetailFetch : null;

  const STORAGE_KEY_SEEN = 'ba_seen_job_ids';
  const STORAGE_KEY_RUN = 'ba_run_state';
  const RUN_STATE_TTL_MS = 5 * 60 * 1000; // 超过 5 分钟的续跑状态视为过期
  const SCORE_TIMEOUT_MS = 45000;

  const state = {
    running: false,
    appliedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    scoredCount: 0,
    aiFailCount: 0,
    log: [],
    config: null,
    stopRequested: false,
    startedAt: 0,
    keepAliveTimer: null,
    jdCache: new Map(),
    salaryWarned: false,
    jdBlockedCount: 0,
    lastGreetingAt: 0,
    lastAction: '',
    searchUrl: '',
    // 本轮任务内"某个岗位导致整页跳转"的次数（任务结束即清空，不做永久黑名单）
    bounceCounts: {}
  };

  // ---------- 基础工具 ----------
  /** 记录"当前正在做什么"，页面被卸载时写盘，便于下次判断是谁触发了跳转/刷新 */
  function setAction(label) {
    state.lastAction = label;
  }

  // 阻止"点击职位链接导致整页跳转"——那会让内容脚本被销毁，任务看起来像"页面自己刷新了"。
  // 只在任务运行期间生效，且只拦 job_detail 链接的默认导航；
  // BOSS 自己的 SPA 处理（history.pushState）不受影响。
  document.addEventListener('click', (event) => {
    if (!state.running) return;
    try {
      const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (!/\/job_detail\//.test(href)) return;
      // 如果点击目标本身就是要打开聊天/沟通按钮，不要拦
      const text = (anchor.textContent || '').trim();
      if (/打招呼|立即沟通|继续沟通/.test(text)) return;
      event.preventDefault();
      // eslint-disable-next-line no-console
      console.log('[BOSS自动投递] 已阻止职位详情链接的整页跳转：', href);
    } catch (e) {
      // 忽略
    }
  }, true);

  // 页面被卸载/跳转时留个记录，下次注入时能说清"上一次为什么没了"
  window.addEventListener('pagehide', () => {
    try {
      chrome.storage.local.set({
        ba_last_unload: {
          at: Date.now(),
          running: !!state.running,
          lastAction: state.lastAction || '',
          href: location.href,
          applied: state.appliedCount || 0
        }
      }).catch(() => {});
    } catch (e) {
      // 忽略
    }
  });

  function log(message, level = 'info') {
    const entry = { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), message, level };
    state.log.push(entry);
    if (state.log.length > 300) state.log.shift();
    reportProgress();
    // eslint-disable-next-line no-console
    console.log(`[BOSS自动投递] ${entry.time} ${message}`);
  }

  function reportProgress() {
    chrome.runtime.sendMessage({
      type: 'BA_PROGRESS',
      payload: {
        running: state.running,
        appliedCount: state.appliedCount,
        skippedCount: state.skippedCount,
        errorCount: state.errorCount,
        scoredCount: state.scoredCount,
        aiFailCount: state.aiFailCount,
        log: state.log.slice(-50)
      }
    }).catch(() => {});
  }

  function snapshotState() {
    return {
      running: state.running,
      appliedCount: state.appliedCount,
      skippedCount: state.skippedCount,
      errorCount: state.errorCount,
      scoredCount: state.scoredCount,
      aiFailCount: state.aiFailCount,
      log: state.log.slice(-50)
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 等待期间可被「停止」立即唤醒的等待者集合
  const stopWaiters = new Set();

  /**
   * 可被「停止」立即打断的等待。
   *
   * 早期实现是 `while (...) await sleep(500)` 的**链式短定时器**：
   * 等 1 分钟要串 120 个 timer。浏览器对后台标签页的定时器会节流
   * （隐藏页最小 1 秒，长时间隐藏后更是每分钟才跑一次），
   * 结果 1 分钟的等待变成十几分钟甚至更久——用户看到的就是「等待不结束」。
   *
   * 现在改成**单个长定时器**（不节流的整数倍不会被链式节流放大），
   * 「停止」通过 stopWaiters 直接唤醒，不需要轮询。
   */
  function interruptibleSleep(ms) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, ms));
      stopWaiters.add(finish);
      if (state.stopRequested) finish();
    });
  }

  function randomDelay(minMs, maxMs) {
    const lo = Math.max(300, minMs || 3000);
    const hi = Math.max(lo, maxMs || 8000);
    return lo + Math.random() * (hi - lo);
  }

  async function waitFor(conditionFn, { timeout = 8000, interval = 200 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (state.stopRequested) return null;
      const result = conditionFn();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  function queryFirst(root, selectors) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function queryAllFirst(root, selectors) {
    for (const sel of selectors) {
      const els = root.querySelectorAll(sel);
      if (els && els.length > 0) return Array.from(els);
    }
    return [];
  }

  function findByText(root, tagSelector, textIncludesList) {
    const candidates = Array.from(root.querySelectorAll(tagSelector));
    return candidates.find((el) => {
      const t = (el.textContent || '').trim();
      return textIncludesList.some((needle) => t.includes(needle));
    }) || null;
  }

  // ---------- 续跑状态（跨页面导航） ----------
  async function persistRunState() {
    if (!state.config || !state.startedAt) return;
    await chrome.storage.local.set({
      [STORAGE_KEY_RUN]: {
        config: state.config,
        appliedCount: state.appliedCount,
        skippedCount: state.skippedCount,
        errorCount: state.errorCount,
        scoredCount: state.scoredCount,
        aiFailCount: state.aiFailCount,
        startedAt: state.startedAt,
        stopRequested: state.stopRequested,
        // 记下任务开始时的职位列表地址：万一点击导致整页跳转，
        // detail-guard.js 可以据此把页面弹回来，让任务续跑。
        searchUrl: state.searchUrl || '',
        bounceCounts: state.bounceCounts || {},
        updatedAt: Date.now()
      }
    }).catch(() => {});
  }

  async function clearRunState() {
    await chrome.storage.local.remove(STORAGE_KEY_RUN).catch(() => {});
  }

  async function readRunState() {
    const data = await chrome.storage.local.get(STORAGE_KEY_RUN);
    return data[STORAGE_KEY_RUN] || null;
  }

  // ---------- 职位卡片读取 ----------
  function getJobCards() {
    const container = queryFirst(document, SEL.jobListContainer) || document.body;
    return queryAllFirst(container, SEL.jobCard);
  }

  function getCardHref(card) {
    for (const sel of SEL.cardLink || ['a[href]']) {
      const a = card.querySelector(sel);
      const href = a && a.getAttribute('href');
      if (href) return href;
    }
    return '';
  }

  function currentListSignature() {
    return SIG(getJobCards().map(getCardHref));
  }

  /**
   * 计算岗位去重 ID。
   *
   * 主键用详情页路径（稳定、唯一）。只有在拿不到链接时才走兜底，
   * 而兜底不能只看标题——同名岗位（比如一堆"产品经理"）会撞成一个 ID，
   * 后面的真岗位就被当成"已处理"静默跳过了。所以兜底要把
   * 标题 + 公司 + 薪资 + 地点 + 标签 全部拼进去。
   */
  function buildJobId(href, title, company, salary, location, tagsText) {
    // 职位详情链接通常带有 lid / securityId 等每次搜索都会变化的追踪参数，
    // 必须只取路径部分作为稳定 ID，否则同一个职位每次搜索都会被当成"新职位"，
    // 导致重复打招呼。
    if (href) {
      try {
        const url = new URL(href, window.location.href);
        if (url.pathname && url.pathname !== '/') return url.pathname;
      } catch (e) {
        // 不是合法 URL，走兜底方案
      }
    }
    const parts = [title, company, salary, location, tagsText]
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    return `sig:${parts.join('__')}`;
  }

  function extractJobInfo(card) {
    const titleEl = queryFirst(card, SEL.jobTitle);
    const companyEl = queryFirst(card, SEL.companyName);
    const salaryEl = queryFirst(card, SEL.jobSalary);
    const locationEl = queryFirst(card, SEL.companyLocation || []);
    const tagsEls = queryAllFirst(card, SEL.jobTags);
    const href = getCardHref(card);

    const title = titleEl ? titleEl.textContent.trim() : '';
    const company = companyEl ? companyEl.textContent.trim() : '';
    const salary = salaryEl ? salaryEl.textContent.trim() : '';
    const location = locationEl ? locationEl.textContent.trim() : '';
    const tagsText = tagsEls.map((el) => el.textContent.trim()).join(' ');
    const jobId = buildJobId(href, title, company, salary, location, tagsText);

    return { jobId, title, company, salary, location, tagsText, href };
  }

  async function loadSeenIds() {
    const data = await chrome.storage.local.get(STORAGE_KEY_SEEN);
    return new Set(data[STORAGE_KEY_SEEN] || []);
  }

  async function markSeen(jobId) {
    const data = await chrome.storage.local.get(STORAGE_KEY_SEEN);
    const list = data[STORAGE_KEY_SEEN] || [];
    if (!list.includes(jobId)) {
      list.push(jobId);
      if (list.length > 5000) list.splice(0, list.length - 5000);
      await chrome.storage.local.set({ [STORAGE_KEY_SEEN]: list });
    }
  }

  // ---------- 拟人化输入 / 点击 ----------
  function setNativeValue(element, value) {
    const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 逐字符"打字"，而不是一次性把整段文字塞进输入框，这样在页面上能看到文字
  // 一个字一个字冒出来，也顺带让单次操作耗时更接近真人手速。
  async function typeLikeHuman(element, text) {
    setNativeValue(element, '');
    await sleep(randomDelay(200, 400));
    let current = '';
    for (const ch of text) {
      if (state.stopRequested) return;
      current += ch;
      setNativeValue(element, current);
      await sleep(30 + Math.random() * 70);
    }
    await sleep(randomDelay(300, 600));
  }

  // 给即将点击的元素画一圈短暂的高亮框，方便肉眼看到插件正在点哪个按钮。
  function highlightElement(el, duration = 900) {
    if (!el || !el.style) return;
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = '2px solid #ff4757';
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }, duration);
  }

  // 统一的"人类式点击"：平滑滚动到元素可见位置，停顿一下，高亮，再停顿一下，
  // 最后才点击——让每一步操作在页面上都清晰可辨，而不是瞬间完成看不出发生了什么。
  async function humanClick(el) {
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(randomDelay(400, 900));
    if (state.stopRequested) return false;
    highlightElement(el);
    await sleep(randomDelay(250, 600));
    if (state.stopRequested) return false;
    el.click();
    await sleep(randomDelay(200, 500));
    return true;
  }

  /**
   * 卡片是否"已经沟通过"。
   *
   * 不能用 `card.textContent.includes(hint)` —— 那是整张卡片的文本，
   * 标题/描述里出现"继续沟通"这类词就会被误判成已沟通，从而静默跳过岗位。
   * 现在要求：必须是**可见的**按钮/链接/文本节点，且文本完全等于提示词。
   */
  function isCardAlreadyChatted(card) {
    const hints = SEL.alreadyChattedTextHints || [];
    if (!hints.length) return false;
    return Array.from(card.querySelectorAll('button, a, span, div')).some((el) => {
      if (!isVisible(el)) return false;
      return hints.includes((el.textContent || '').trim());
    });
  }

  // ---------- 职位详情（JD）抓取 ----------
  /**
   * 用同源 fetch 拿详情页 HTML 并解析出职位描述。
   *
   * 为什么不直接点开卡片：点开往往会触发整页跳转，content script 当场被销毁，
   * 任务静默死掉（v1 就是这样丢任务的）。fetch 不会影响当前页面，也不打断节奏。
   */
  async function fetchJdInfo(info) {
    if (!info || !info.href) return { jd: '', salaryHint: '', blocked: false };
    if (state.jdCache.has(info.jobId)) return state.jdCache.get(info.jobId);

    let text = '';
    let salaryHint = '';
    let blocked = false;
    let note = '';
    let alreadyChattedHint = false;

    try {
      const abs = new URL(info.href, location.href);
      if (!/(^|\.)zhipin\.com$/.test(abs.hostname)) return { jd: '', salaryHint: '', blocked: false };
      if (!/\/job_detail\//.test(abs.pathname)) return { jd: '', salaryHint: '', blocked: false };

      // 保留链接上的 securityId / lid 等参数。
      // 之前为了"jobId 稳定"把 query 全删了（jobId 本来就只取 pathname，不需要删），
      // 结果详情页少了这些参数，更容易被服务端判成异常访问。
      abs.hash = '';

      await sleep(randomDelay(300, 900));

      const res = await fetch(abs.href, {
        credentials: 'include',
        headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        referrer: location.href,
        referrerPolicy: 'strict-origin-when-cross-origin'
      });

      const finalUrl = res.url || abs.href;
      const redirectToLogin = /(login|passport|verify|safe-?check)/i.test(finalUrl);

      if (!res.ok) {
        note = `HTTP ${res.status}${redirectToLogin ? '，且被重定向到登录/验证页' : ''}`;
        blocked = redirectToLogin || res.status === 403 || res.status === 429;
      } else {
        const html = await res.text();

        // 先解析正文：只要拿到正文就不算被拦。
        // 之前是先搜"安全/验证"等字样，而 BOSS 的 JS 里本身就带 security-check 这类字符串，
        // 于是正常页面被误判成"被风控拦截"，白白丢弃了本可以拿到的 JD。
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const parts = [];
        for (const sel of SEL.jdDetail || []) {
          const nodes = doc.querySelectorAll(sel);
          if (nodes.length) {
            nodes.forEach((n) => parts.push((n.textContent || '').trim()));
            break;
          }
        }
        text = parts.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

        const outcome = CLASSIFY
          ? CLASSIFY({ jdText: text, html, finalUrl, hints: SEL.detailBlockedHints })
          : (text.length >= 20 ? 'ok' : 'empty');

        if (outcome === 'ok') {
          state.jdBlockedCount = 0;
          const detailText = (doc.body ? doc.body.textContent : '').replace(/\s+/g, ' ');
          const rangeMatch = detailText.match(/(\d{1,3})\s*-\s*(\d{1,3})\s*K/i);
          if (rangeMatch) {
            salaryHint = `${rangeMatch[1]}-${rangeMatch[2]}K`;
          } else {
            const aboveMatch = detailText.match(/(\d{1,3})\s*K\s*以上/i);
            if (aboveMatch) salaryHint = `${aboveMatch[1]}K以上`;
          }

          // 用服务端返回的详情页判断"是否已沟通过"。
          // 列表页的按钮文案会被浏览器缓存（已沟通的岗位仍显示「立即沟通」），
          // 但详情页是**现拉**的，更能反映真实状态。
          const chatHints = (SEL.alreadyChattedTextHints || ['继续沟通', '已发送', '继续聊']);
          try {
            const exact = Array.from(doc.querySelectorAll('button, a, span')).some((el) => {
              const t = (el.textContent || '').trim();
              return chatHints.includes(t);
            });
            if (exact) alreadyChattedHint = true;
          } catch (e) {
            // 忽略
          }
        } else if (outcome === 'blocked') {
          blocked = true;
          note = `被重定向到登录/验证页或被验证页替换（最终地址 ${finalUrl.slice(0, 90)}）`;
        } else {
          note = `未解析到职位描述（HTML ${html.length} 字节，可能是前端渲染或选择器变化）`;
        }
      }
    } catch (e) {
      note = e.message;
    }

    if (blocked) {
      state.jdBlockedCount = (state.jdBlockedCount || 0) + 1;
      log(`抓取职位详情失败：${note}；本次降级为只用列表信息`, 'warn');
      if (state.jdBlockedCount >= 3) {
        const pause = Math.min(20000, 4000 * (state.jdBlockedCount - 2));
        log(`连续 ${state.jdBlockedCount} 次取详情失败，暂停约 ${Math.round(pause / 1000)} 秒再继续（避免加重风控）`, 'warn');
        await interruptibleSleep(pause);
      }
      // 被拦的结果不写缓存：这一轮后面或下次运行还有机会重新抓
      return { jd: '', salaryHint: '', blocked: true };
    }

    if (text.length > 6000) text = text.slice(0, 6000);
    const out = { jd: text, salaryHint, blocked: false, alreadyChatted: alreadyChattedHint };
    state.jdCache.set(info.jobId, out);
    return out;
  }

  // ---------- 大模型打分（经 background 代理） ----------
  function sendWithTimeout(message, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ ok: false, error: `等待后台响应超时（>${Math.round(timeoutMs / 1000)}s）` });
        }
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage(message).then((r) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(r || { ok: false, error: '后台没有返回内容' });
        }).catch((e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, error: e.message });
        });
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, error: e.message });
        }
      }
    });
  }

  async function scoreViaAi(info, jd) {
    const resp = await sendWithTimeout({ type: 'BA_SCORE', job: info, jd }, SCORE_TIMEOUT_MS);
    if (!resp || !resp.ok) return { ok: false, error: (resp && resp.error) || '未知错误' };
    return { ok: true, cached: !!resp.cached, result: resp.result };
  }

  function startKeepAlive() {
    if (state.keepAliveTimer) return;
    // 每 20 秒 ping 一次后台，避免打分请求进行到一半时 service worker 被回收
    state.keepAliveTimer = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'BA_PING' }).catch(() => {});
    }, 20000);
  }

  function stopKeepAlive() {
    if (state.keepAliveTimer) {
      clearInterval(state.keepAliveTimer);
      state.keepAliveTimer = null;
    }
  }

  // ---------- 搜索与原生筛选 ----------
  async function performSearch(keyword) {
    const input = await waitFor(() => queryFirst(document, SEL.searchInput), { timeout: 5000 });
    if (!input) {
      log('未找到页面搜索框，将直接使用当前页面已有的职位列表（如需按关键词搜索，请先手动在 BOSS 搜索框中搜索）', 'warn');
      return false;
    }

    await humanClick(input);
    input.focus();
    await typeLikeHuman(input, keyword);

    const searchBtn = queryFirst(document, SEL.searchButton);
    if (searchBtn) {
      await humanClick(searchBtn);
    } else {
      await sleep(randomDelay(200, 500));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }

    const ok = await waitFor(() => getJobCards().length > 0, { timeout: 10000 });
    if (!ok) {
      log(`搜索「${keyword}」后未加载出职位列表，请确认关键词是否有结果`, 'warn');
      return false;
    }
    await sleep(800);
    return true;
  }

  async function applySalaryFilter(minK, maxK) {
    if (!minK && !maxK) return; // 用户没设置薪资范围，保持"不限"
    if (!PARSE_SALARY) return;

    const trigger = findByText(document, 'div, span, button, a', SEL.salaryFilterTriggerTexts);
    if (!trigger) {
      log('未找到"薪资待遇"筛选按钮，跳过原生筛选设置（仍会按薪资对已加载的结果做二次过滤）', 'warn');
      return;
    }

    await humanClick(trigger);

    const panel = await waitFor(() => queryFirst(document, SEL.filterDropdownPanel), { timeout: 3000 }) || document;
    const optionEls = queryAllFirst(panel, SEL.filterOptionItem).filter((el) => (el.textContent || '').trim());

    const lo = minK || 0;
    const hi = maxK || Infinity;
    let bestEl = null;
    let bestOverlap = -Infinity;
    for (const el of optionEls) {
      const range = PARSE_SALARY(el.textContent.trim());
      if (!range) continue;
      const overlap = Math.min(range.max, hi) - Math.max(range.min, lo);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestEl = el;
      }
    }

    if (!bestEl) {
      log('未能在薪资筛选选项里找到可解析的档位，跳过原生筛选设置', 'warn');
      await humanClick(trigger); // 尝试收起面板
      return;
    }

    const chosenText = bestEl.textContent.trim();
    await humanClick(bestEl);

    const confirmBtn = findByText(document, 'button, span, a', SEL.filterConfirmButtonTexts);
    if (confirmBtn) await humanClick(confirmBtn);

    await waitFor(() => getJobCards().length > 0, { timeout: 6000 });
    log(`已应用薪资筛选：${chosenText}`);
  }

  async function selectDropdownFilterByText(triggerTexts, desiredText, filterLabel) {
    if (!desiredText) return; // "不限"，不调整

    const trigger = findByText(document, 'div, span, button, a', triggerTexts);
    if (!trigger) {
      log(`未找到"${filterLabel}"筛选按钮，跳过`, 'warn');
      return;
    }

    await humanClick(trigger);

    const panel = await waitFor(() => queryFirst(document, SEL.filterDropdownPanel), { timeout: 3000 }) || document;
    const optionEls = queryAllFirst(panel, SEL.filterOptionItem).filter((el) => (el.textContent || '').trim());

    const target =
      optionEls.find((el) => el.textContent.trim() === desiredText) ||
      optionEls.find((el) => el.textContent.trim().includes(desiredText));

    if (!target) {
      log(`"${filterLabel}"筛选选项里没有找到「${desiredText}」，跳过（可能选项文案与页面实际不一致，可在 selectors.js 里核对）`, 'warn');
      await humanClick(trigger);
      return;
    }

    await humanClick(target);

    const confirmBtn = findByText(document, 'button, span, a', SEL.filterConfirmButtonTexts);
    if (confirmBtn) await humanClick(confirmBtn);

    await waitFor(() => getJobCards().length > 0, { timeout: 6000 });
    log(`已应用"${filterLabel}"筛选：${desiredText}`);
  }

  // 清掉可能挡在流程中间的通用弹窗（完善简历提示、活动广告等）。
  // 专门处理"已向BOSS发送消息"确认框的逻辑在 sendGreeting 里，这里只处理其余的。
  async function dismissGenericDialog() {
    const closeBtn = findByText(document, 'button, span, a, i, div', SEL.genericDialogCloseTexts);
    if (closeBtn) {
      await humanClick(closeBtn);
      return true;
    }
    const closeIcon = queryFirst(document, SEL.genericDialogCloseIconSelectors);
    if (closeIcon) {
      await humanClick(closeIcon);
      return true;
    }
    return false;
  }

  /** 派发一组 hover 事件：BOSS 列表页的"打招呼"按钮是悬停后才渲染的 */
  function fireHover(el) {
    if (!el) return;
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
      try {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      } catch (e) {
        // 某些环境下 MouseEvent 构造器受限，忽略即可
      }
    }
  }

  /**
   * 打开某个岗位的打招呼入口。
   *
   * 返回 { ok, already, reason }：
   * - already=true 表示按钮文案是「继续沟通/已发送/继续聊」——该岗位此前已联系过，
   *   **绝不能再点**：点了会跳到沟通页，任务直接被带走。
   * - ok=false 表示没找到可用入口。
   */
  async function openChatForCard(card, info) {
    const alreadyHints = SEL.alreadyChattedTextHints || ['继续沟通', '已发送', '继续聊'];
    const isAlreadyText = (t) => alreadyHints.includes((t || '').trim());

    // 1) 少数卡片样式默认就带按钮
    let chatBtn = queryFirst(card, SEL.cardChatButton) || findByText(card, 'button, a, span', ['打招呼', '立即沟通', '继续沟通']);

    // 2) 绝大多数情况：先悬停，按钮才会出现
    if (!chatBtn) {
      try {
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (e) {
        // 忽略
      }
      await sleep(randomDelay(200, 400));
      fireHover(card);
      await sleep(450);
      chatBtn = queryFirst(card, SEL.cardChatButton) || findByText(card, 'button, a, span, div', ['打招呼', '立即沟通', '继续沟通']);
    }

    // 3) 有的实现把按钮挂到卡片外的浮层里：按纵向位置就近找，避免误点别的卡片
    if (!chatBtn) {
      try {
        const cardRect = card.getBoundingClientRect();
        const candidates = Array.from(document.querySelectorAll('button, a, span, div'))
          .filter((el) => el.offsetParent !== null && /^(打招呼|立即沟通|继续沟通|已发送|继续聊)$/.test((el.textContent || '').trim()));
        chatBtn = candidates.find((el) => {
          const r = el.getBoundingClientRect();
          return r.height > 0 && r.top >= cardRect.top - 60 && r.bottom <= cardRect.bottom + 60;
        }) || null;
      } catch (e) {
        chatBtn = null;
      }
    }

    if (chatBtn) {
      const text = (chatBtn.textContent || '').trim();
      if (isAlreadyText(text)) {
        return { ok: false, already: true, reason: text };
      }
      setAction(`点击打招呼按钮：《${(info && info.title) || ''}》`);
      await humanClick(chatBtn);
      return { ok: true, already: false };
    }

    // 4) 兜底：点卡片唤出详情面板。
    //    风险：BOSS 有时会在卡片上挂 JS 点击处理器并直接整页跳转，
    //    这种情况 <a> 的 preventDefault 拦不住，脚本会被销毁。
    //    真跳走了 detail-guard.js 会在落地的详情页补投并弹回。
    const hasDetailLink = !!card.querySelector('a[href*="/job_detail/"]');
    setAction(`点击职位卡片：《${(info && info.title) || ''}》${hasDetailLink ? '（含详情链接，可能跳转）' : ''}`);
    fireHover(card);
    await humanClick(card);
    await sleep(700);

    const afterCards = getJobCards();
    if (afterCards.length === 0) {
      return { ok: false, already: false, reason: '点开卡片后职位列表消失（疑似整页跳转）' };
    }

    chatBtn = findByText(document, 'button, a, span', ['打招呼', '立即沟通', '继续沟通']);
    if (!chatBtn) return { ok: false, already: false, reason: '未找到打招呼按钮' };

    const text2 = (chatBtn.textContent || '').trim();
    if (isAlreadyText(text2)) {
      return { ok: false, already: true, reason: text2 };
    }

    setAction(`点击详情面板里的打招呼：《${(info && info.title) || ''}》`);
    await humanClick(chatBtn);
    return { ok: true, already: false };
  }

  /** 元素是否真的可见（有占位、未被隐藏） */
  function isVisible(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return false;
      if (Number(st.opacity) === 0) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 找「已向BOSS发送消息」确认框。
   *
   * 必须要求**可见**，这是判断"真的发出去了"的前提。早期实现有三个缺陷：
   * 1) 用 `document.body.textContent` 匹配——隐藏节点、聊天记录里的旧文案也会命中；
   * 2) 按钮在**全文档**范围内找——可能点到别的卡片上的"继续沟通"；
   * 3) 点完立刻返回成功——上一个岗位的弹窗没关掉时，下一个岗位就会"秒成功"，
   *    于是日志显示已投递、BOSS 实际没收到。
   */
  function findAutoSentDialogButtons() {
    const hints = SEL.autoSentDialogHints || [];
    const stayTexts = SEL.autoSentDialogStayButtonTexts || [];
    const contTexts = SEL.autoSentDialogContinueButtonTexts || [];

    // innerText 只包含"可见"文本，隐藏节点里的旧文案不会误命中
    const visibleText = document.body.innerText || '';
    if (!hints.some((h) => visibleText.includes(h))) return null;

    const allBtns = Array.from(document.querySelectorAll('button, a, span'));
    const pick = (texts) =>
      allBtns.find((b) => {
        if (!isVisible(b)) return false;
        if (!texts.includes((b.textContent || '').trim())) return false;
        // 按钮必须位于一个"同时包含提示文字、且体量不大"的容器里，
        // 以此排除列表卡片上的同名按钮
        let el = b;
        for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
          const t = el.textContent || '';
          if (t.length < 600 && hints.some((h) => t.includes(h))) return true;
        }
        return false;
      });

    const stayBtn = pick(stayTexts) || null;
    const continueBtn = pick(contTexts) || null;
    if (!stayBtn && !continueBtn) return null;

    // 找到弹窗根节点：从按钮往上走，取"包含提示文案且体量不大"的那一层
    let root = null;
    let el = stayBtn || continueBtn;
    for (let depth = 0; el && depth < 10; depth++, el = el.parentElement) {
      const t = el.textContent || '';
      if (t.length < 600 && hints.some((h) => t.includes(h))) {
        root = el;
        break;
      }
    }

    return { stayBtn, continueBtn, root };
  }

  /** 在弹窗里（或整页）找右上角的关闭按钮 × */
  function findDialogCloseIcon(rootEl) {
    const SEL_CLOSE = ['.dialog-close', '.icon-close', '.close-btn', '.ui-icon-close', '[class*="close"]', '[aria-label="关闭"]', '[title="关闭"]'];
    const scope = rootEl && rootEl.querySelectorAll ? rootEl : document;
    for (const sel of SEL_CLOSE) {
      try {
        const el = scope.querySelector(sel);
        if (el && isVisible(el)) return el;
      } catch (e) {
        // 忽略非法选择器
      }
    }
    // 兜底：根节点本身可能是个 × 图标
    try {
      const alt = document.querySelectorAll(SEL_CLOSE.join(','));
      for (const el of alt) {
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 40 && r.height <= 40) return el; // 小的方形图标，多半是 ×
      }
    } catch (e) {
      // 忽略
    }
    return null;
  }

  /** 弹窗的可读描述，用于日志定位（出问题时把这段发回来就能判断） */
  function describeDialog(d) {
    if (!d) return '无';
    const parts = [];
    const btn = d.stayBtn || d.continueBtn;
    if (btn) {
      parts.push(`按钮="${(btn.textContent || '').trim()}"`);
      try {
        const r = btn.getBoundingClientRect();
        parts.push(`位置=${Math.round(r.x)},${Math.round(r.y)}`);
      } catch (e) { /* 忽略 */ }
    }
    let root = btn ? btn.parentElement : null;
    for (let i = 0; root && i < 6; i++, root = root.parentElement) {
      const t = (root.textContent || '').trim();
      if (t.length > 20) { parts.push(`文案="${t.slice(0, 40).replace(/\s+/g, ' ')}…"`); break; }
    }
    return parts.join(' | ') || '未知';
  }

  /**
   * 确认框是否仍然存在。
   *
   * 光看"有没有按钮"不够：关闭动画期间按钮可能先被判为不可见，
   * 于是误判成"已关闭"（这就是上一版成功日志与实际不符的原因）。
   * 这里额外要求标题文案也从可见文本里消失。
   */
  function isConfirmDialogPresent() {
    if (findAutoSentDialogButtons()) return true;
    const t = document.body.innerText || '';
    return t.includes('已向BOSS发送消息');
  }

  /**
   * 等待确认框消失，并且**连续 600ms 都判定为不存在**才算真的关了。
   * 单点采样会被动画/重渲染骗过去。
   */
  async function waitConfirmDialogGone(timeout = 3500) {
    const start = Date.now();
    let goneSince = 0;
    while (Date.now() - start < timeout) {
      if (state.stopRequested) return false;
      if (isConfirmDialogPresent()) {
        goneSince = 0;
      } else {
        if (!goneSince) goneSince = Date.now();
        else if (Date.now() - goneSince >= 600) return true;
      }
      await sleep(150);
    }
    return false;
  }

  /**
   * 清掉上一个岗位遗留的「已向BOSS发送消息」确认框。
   *
   * **必须在点击「打招呼」之前调用**（放在 sendGreeting 里会把本岗位刚弹出的框关掉）。
   * 另外加了时间保护：刚投递完 6 秒内出现的弹窗，很可能就是刚才那次产生的，
   * 不去动它，避免"把正常投递的弹窗当遗留关掉"。
   */
  /** 发送一次 Escape：模态框的通用关闭方式，比乱点按钮安全 */
  function pressEscape() {
    try {
      for (const type of ['keydown', 'keyup']) {
        document.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      }
    } catch (e) {
      // 忽略
    }
  }

  async function clearStaleSentDialog() {
    if (Date.now() - (state.lastGreetingAt || 0) < 6000) {
      const justNow = findAutoSentDialogButtons();
      if (justNow) return false; // 刚发完，先不动，交给下一轮判断
    }
    const stale = findAutoSentDialogButtons();
    if (!stale) return false;
    log(`检测到疑似遗留的确认框（${describeDialog(stale)}），先关闭它再继续`, 'warn');

    // 降级顺序：点「留在此页」→ 点弹窗右上角 × → 汇报错误
    await humanClick(stale.stayBtn || stale.continueBtn);
    let gone = await waitConfirmDialogGone(2500);

    if (!gone) {
      const cur = findAutoSentDialogButtons();
      const closeIcon = findDialogCloseIcon(cur && cur.root ? cur.root : document);
      if (closeIcon) {
        log('点击「留在此页」未生效，改点弹窗右上角的 ×', 'warn');
        await humanClick(closeIcon);
        gone = await waitConfirmDialogGone(2500);
      } else {
        log('「留在此页」未生效，且没找到右上角关闭按钮', 'warn');
      }
    }

    if (!gone) {
      log('确认框无法关闭，汇报错误（若页面跳转，detail-guard 会自动弹回列表）', 'error');
    }
    return gone;
  }

  async function sendGreeting(greetingText) {
    state.lastGreetingAt = Date.now();
    setAction('发送招呼语');
    // 点击"打招呼"后，BOSS 可能出现两种情况，谁先出现处理谁：
    // 1) 一个可编辑的聊天输入框 —— 我们填入自定义话术并发送；
    // 2) 一个"已向BOSS发送消息"确认框 —— 说明 BOSS 已经用你在官方设置里配置的
    //    默认招呼语直接发出去了，这里的自定义话术不会生效，只能确认并关闭继续下一个。
    //
    // 注意：这里**不能**再清理"遗留弹窗"——此刻页面上的弹窗是本次点击刚产生的。
    // 残留清理见 clearStaleSentDialog()，由调用方在点击前执行。
    const outcome = await waitFor(() => {
      const input = queryFirst(document, SEL.chatInput);
      if (input) return { type: 'input', input };
      const dialog = findAutoSentDialogButtons();
      if (dialog) return { type: 'auto-sent', dialog };
      return null;
    }, { timeout: 6000 });

    if (!outcome) {
      return { ok: false, reason: '未找到聊天输入框，也没有检测到发送确认弹窗（可能页面结构已变化，或该职位需要先完善简历）' };
    }

    if (outcome.type === 'auto-sent') {
      const btn = outcome.dialog.stayBtn || outcome.dialog.continueBtn;
      await humanClick(btn);

      // 关键：确认弹窗**持续消失**才算发出去了。
      // 单点采样会被关闭动画骗过去（按钮先不可见、但弹窗还在），
      // 那样会在没发出去的情况下记成功，下一轮再把真弹窗当遗留关掉。
      let closed = await waitConfirmDialogGone(3500);
      if (!closed) {
        const again = findAutoSentDialogButtons();
        if (again) await humanClick(again.stayBtn || again.continueBtn);
        closed = await waitConfirmDialogGone(3000);
      }
      state.lastGreetingAt = Date.now();
      if (!closed) {
        return { ok: false, reason: '「已向BOSS发送消息」确认框没有关闭，无法确认消息是否真的发出' };
      }
      return { ok: true, usedDefaultGreeting: true, verifiedBy: '确认框已关闭' };
    }

    const input = outcome.input;
    await humanClick(input);
    await typeLikeHuman(input, greetingText);

    const sendBtn = queryFirst(document, SEL.chatSendButton) || findByText(document, 'button, span, div', ['发送']);
    if (sendBtn) {
      await humanClick(sendBtn);
    } else {
      // 回退方案：模拟回车发送
      await sleep(randomDelay(200, 500));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }

    // 发送后校验：输入框被清空（常见行为）或出现了确认框，都算发出。
    // 两者都没有时不敢断言成功，标记为"未确认"——不计入成功、也不拉黑。
    const confirmed = await waitFor(() => {
      const el = queryFirst(document, SEL.chatInput) || input;
      const cleared = !el || !(el.value || '').trim();
      if (cleared) return 'cleared';
      if (findAutoSentDialogButtons()) return 'dialog';
      return null;
    }, { timeout: 3000 });

    if (confirmed === 'cleared') return { ok: true, verifiedBy: '输入框已清空' };
    if (confirmed === 'dialog') {
      const d = findAutoSentDialogButtons();
      if (d) await humanClick(d.stayBtn || d.continueBtn);
      return { ok: true, verifiedBy: '出现发送确认框' };
    }
    return { ok: true, unverified: true, verifiedBy: '未确认（输入框未清空、也无确认框）' };
  }

  // ---------- 翻页 ----------
  /** 找到真正滚动职位列表的那个容器（可能是某个 overflow 的 div，而不是 window） */
  function findScrollContainer() {
    const cards = getJobCards();
    let el = cards[0] ? cards[0].parentElement : null;
    while (el && el !== document.documentElement) {
      try {
        const style = getComputedStyle(el);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 20) {
          return el;
        }
      } catch (e) {
        // 忽略
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * 滚动到底部触发"加载更多"，并确认列表真的变长了。
   *
   * 2026-11 实测：BOSS 的职位列表已经是**滚动加载**，页面上根本没有"下一页"元素。
   * 原来只找按钮，于是每次都在第一屏就判定"已到最后一页"，只能吃到 15 个岗位。
   *
   * 这里做 3 次滚动重试：有的实现需要连续滚动/滚动后停顿才发请求。
   */
  async function tryScrollLoadMore() {
    const before = currentListSignature();
    const beforeCount = getJobCards().length;

    for (let attempt = 0; attempt < 3; attempt++) {
      const scroller = findScrollContainer();
      try {
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
      } catch (e) {
        // 忽略
      }

      const changed = await waitFor(
        () => currentListSignature() !== before || getJobCards().length > beforeCount,
        { timeout: 4000, interval: 300 }
      );
      if (changed) {
        await waitFor(() => getJobCards().length > 0, { timeout: 5000 });
        await sleep(600);
        return true;
      }
      // 没反应就再滚一次，给懒加载一点时间
      await sleep(700);
    }
    return false;
  }

  /** 页面是否明确显示"没有更多了" */
  function hasNoMoreHint() {
    const hints = SEL.noMoreTextHints || ['没有更多', '已加载全部', '到底了'];
    return hints.some((h) => document.body.innerText.includes(h));
  }

  /** 自检用：除了滚动探测，还把"加载更多/查看更多"这类按钮文案收集回来 */
  async function probeMoreResults() {
    const before = getJobCards().length;
    const changed = await tryScrollLoadMore();
    const after = getJobCards().length;
    const texts = new Set();
    Array.from(document.querySelectorAll('button, a, div, span')).forEach((el) => {
      const t = (el.textContent || '').trim();
      if (t && t.length <= 8 && /加载更多|查看更多|下一页|换一换|更多职位|没有更多/.test(t)) texts.add(t);
    });
    return {
      scrollerFound: !!findScrollContainer(),
      before,
      after,
      loadedMore: changed || after > before,
      actionTexts: Array.from(texts).slice(0, 6)
    };
  }

  async function findNextButton() {
    const btn = queryFirst(document, SEL.nextPageButton);
    if (btn) return btn;
    return findByText(document, 'a, button, span, div', SEL.nextPageTextHints || ['下一页']);
  }

  /**
   * 翻到下一页，并且**验证列表真的变了**。
   * 返回 {moved:boolean, reachedEnd:boolean, reason?:string}
   */
  async function goToNextPage() {
    const btn = await findNextButton();

    if (!btn) {
      // 没有"下一页"按钮时不要直接判"结束"：BOSS 现在是滚动加载
      const loaded = await tryScrollLoadMore();
      if (loaded) {
        log('滚动到底部，加载了更多职位');
        return { moved: true, reachedEnd: false, reason: '滚动加载了更多职位' };
      }
      return {
        moved: false,
        reachedEnd: true,
        reason: hasNoMoreHint() ? '页面提示"没有更多"，列表已到底' : '滚动到底部也没有加载新职位'
      };
    }

    const disabled =
      btn.classList.contains('disabled') ||
      btn.hasAttribute('disabled') ||
      btn.getAttribute('aria-disabled') === 'true';
    if (disabled) {
      const loaded = await tryScrollLoadMore();
      if (loaded) return { moved: true, reachedEnd: false, reason: '按钮已禁用，但滚动加载出了更多职位' };
      return { moved: false, reachedEnd: true, reason: '"下一页"按钮已禁用（已到最后一页）' };
    }

    const before = currentListSignature();
    const urlBefore = location.href;

    // 关键：如果这次点击触发整页导航，本脚本会被销毁，
    // 先把进度落盘，等新页面注入时自动续跑。
    await persistRunState();

    await humanClick(btn);

    const changed = await waitFor(
      () => currentListSignature() !== before || location.href !== urlBefore,
      { timeout: 12000, interval: 300 }
    );
    if (!changed) {
      await sleep(1200);
      if (currentListSignature() !== before) {
        await waitFor(() => getJobCards().length > 0, { timeout: 6000 });
        return { moved: true, reachedEnd: false };
      }
      return { moved: false, reachedEnd: false, reason: '点击"下一页"后列表和地址都没有变化（可能选择器失效或页面未响应）' };
    }

    await waitFor(() => getJobCards().length > 0, { timeout: 8000 });
    await sleep(600);
    return { moved: true, reachedEnd: false };
  }

  // ---------- 主流程 ----------
  function resetCounters() {
    state.appliedCount = 0;
    state.skippedCount = 0;
    state.errorCount = 0;
    state.scoredCount = 0;
    state.aiFailCount = 0;
    state.log = [];
    state.jdCache = new Map();
    state.salaryWarned = false;
    state.jdBlockedCount = 0;
    state.lastGreetingAt = 0;
  }

  async function runAutomation(config, { resumeFrom = null } = {}) {
    if (!SEL || !MATCH) {
      log('脚本依赖未正确加载（selectors.js / matcher.js），请检查扩展是否完整安装', 'error');
      state.running = false;
      reportProgress();
      return;
    }

    const resuming = !!resumeFrom;
    state.running = true;
    state.stopRequested = false;
    state.config = config;

    if (resuming) {
      state.appliedCount = resumeFrom.appliedCount || 0;
      state.skippedCount = resumeFrom.skippedCount || 0;
      state.errorCount = resumeFrom.errorCount || 0;
      state.scoredCount = resumeFrom.scoredCount || 0;
      state.aiFailCount = resumeFrom.aiFailCount || 0;
      state.startedAt = resumeFrom.startedAt || Date.now();
      state.searchUrl = resumeFrom.searchUrl || location.href;
      state.bounceCounts = resumeFrom.bounceCounts && typeof resumeFrom.bounceCounts === 'object'
        ? { ...resumeFrom.bounceCounts }
        : {};
      state.log = [];
      log(`检测到页面刷新/跳转，自动继续上次任务（已投递 ${state.appliedCount} 个）`);

      // 上一跳落到了职位详情页，detail-guard 可能在那边已经补投成功——这里认领这次结果
      try {
        const d = await chrome.storage.local.get('ba_detail_delivery');
        const rec = d.ba_detail_delivery;
        if (rec && Date.now() - (rec.at || 0) < 120000) {
          const name = `《${rec.title || rec.jobId}》`;
          if (rec.ok) {
            state.appliedCount += 1;
            log(`整页跳转后已在详情页补投${name}${rec.already ? '（该岗位此前已联系过，不重复打扰）' : ''}`, 'success');
            if (rec.jobId) await markSeen(rec.jobId);
          } else {
            state.errorCount += 1;
            log(`整页跳转后未能在详情页补投${name}：${rec.reason || '未知原因'}（下次运行会重试）`, 'warn');
          }
          await chrome.storage.local.remove('ba_detail_delivery');
          await persistRunState();
        }
      } catch (e) {
        // 忽略
      }
    } else {
      resetCounters();
      state.startedAt = Date.now();
      state.searchUrl = location.href;
      log('开始自动投递任务');
    }

    startKeepAlive();
    try {
      await runMainLoop(config, resuming);
    } catch (e) {
      state.errorCount += 1;
      log(`任务异常终止：${e.message}`, 'error');
    } finally {
      state.running = false;
      stopKeepAlive();
      // 如果是"主动 reload 以刷新列表"，必须保留续跑状态，否则刚落盘就被自己清掉了
      if (!state.preserveRunState) await clearRunState();
      state.preserveRunState = false;
      log(`任务结束，共投递 ${state.appliedCount} 个职位，跳过 ${state.skippedCount} 个，${state.errorCount} 个异常`);
      reportProgress();
    }
  }

  async function runMainLoop(config, resuming) {
    const maxApplications = config.maxApplications || 20;
    const aiEnabled = !!config.aiEnabled;

    if (!resuming) {
      if (config.keywords && config.keywords.length > 0) {
        setAction('自动搜索关键词');
        log(`自动搜索关键词「${config.keywords[0]}」...`);
        await performSearch(config.keywords[0]);
        if (state.stopRequested) return;
      }

      if (config.salaryMin || config.salaryMax) {
        await applySalaryFilter(config.salaryMin, config.salaryMax);
        if (state.stopRequested) return;
      }

      await selectDropdownFilterByText(SEL.jobTypeFilterTriggerTexts, config.jobType, '求职类型');
      await selectDropdownFilterByText(SEL.experienceFilterTriggerTexts, config.experience, '工作经验');
      await selectDropdownFilterByText(SEL.degreeFilterTriggerTexts, config.degree, '学历要求');
      if (state.stopRequested) return;
    } else {
      log('续跑模式：跳过重复的搜索与筛选设置，直接接着处理当前列表');
    }

    const seen = await loadSeenIds();
    let page = 1;
    let round = 1;

    while (state.running && !state.stopRequested && state.appliedCount < maxApplications) {
      log(`===== 第 ${round} 轮 · 第 ${page} 页 =====`);

      const cards = getJobCards();
      if (cards.length === 0) {
        const found = await waitFor(() => getJobCards().length > 0, { timeout: 6000 });
        if (!found) {
          log('当前页面未找到职位卡片，任务结束', 'warn');
          return;
        }
      }

      const freshCards = getJobCards();
      log(`本页发现 ${freshCards.length} 个职位卡片`);

      // 本轮统计：不加这个，"为什么 75 个卡片只处理了几个"永远说不清。
      // （每轮都会重新遍历全部卡片，但历史记录里有的会被静默跳过，所以日志稀疏是正常的）
      const stat = { total: freshCards.length, noTitle: 0, seen: 0, chatted: 0, ruleSkip: 0, evaluated: 0, applied: 0 };
      let lastDialogCheck = 0;

      for (const card of freshCards) {
        if (state.stopRequested || state.appliedCount >= maxApplications) break;

        // 弹窗检测很贵（要遍历整页元素），按时间节流，别每张卡片都跑一遍
        if (Date.now() - lastDialogCheck > 2500) {
          lastDialogCheck = Date.now();
          await dismissGenericDialog();
        }

        let info;
        try {
          info = extractJobInfo(card);
        } catch (e) {
          state.errorCount += 1;
          log(`解析职位卡片失败：${e.message}`, 'error');
          continue;
        }

        if (!info.title) {
          stat.noTitle += 1;
          continue;
        }
        if (seen.has(info.jobId)) {
          stat.seen += 1;
          continue;
        }

        if (isCardAlreadyChatted(card)) {
          stat.chatted += 1;
          seen.add(info.jobId);
          await markSeen(info.jobId);
          continue;
        }

        // 第一道：本地规则（排除词/公司黑名单/薪资/关键词）。
        // 放在 AI 之前是为了省 token——明显不合适的根本不用花钱问模型。
        const { matched, reason } = MATCH(info, config);
        if (!matched) {
          state.skippedCount += 1;
          stat.ruleSkip += 1;
          seen.add(info.jobId);
          await markSeen(info.jobId);
          log(`跳过《${info.title}》@${info.company}：${reason}`);
          continue;
        }

        // 第二道：薪资兜底 + 大模型打分
        // 注意：即使用户没开 AI，只要设了薪资范围且列表页薪资被字体混淆（没有数字），
        // 也要去详情页捞一次薪资，否则「薪资过滤」会静默失效。
        const needSalaryFallback = !!((config.salaryMin || config.salaryMax) && info.salary && !/\d/.test(info.salary));
        const needDetail = aiEnabled || needSalaryFallback;

        if (needDetail) {
          const detail = await fetchJdInfo(info);

          // 列表页按钮文案会被缓存（已沟通的岗位仍显示「立即沟通」），
          // 但详情页是现拉的 —— 以它为准判断"是否已沟通过"。
          if (detail.alreadyChatted) {
            state.skippedCount += 1;
            stat.chatted += 1;
            seen.add(info.jobId);
            await markSeen(info.jobId);
            log(`跳过《${info.title}》@${info.company}：详情页显示该岗位已沟通过（列表按钮仍是缓存的「立即沟通」）`);
            continue;
          }

          let effectiveSalary = info.salary;
          if (effectiveSalary && !/\d/.test(effectiveSalary) && detail.salaryHint) {
            effectiveSalary = detail.salaryHint;
            info.salary = detail.salaryHint;
          }

          if (config.salaryMin || config.salaryMax) {
            const salaryRange = PARSE_SALARY ? PARSE_SALARY(effectiveSalary) : null;
            if (!salaryRange && !state.salaryWarned) {
              state.salaryWarned = true;
              log('列表页与详情页都没取到可解析的薪资（BOSS 对数字做了字体混淆），本轮不按薪资过滤', 'warn');
            }
            if (salaryRange) {
              const lo = config.salaryMin || 0;
              const hi = config.salaryMax || Infinity;
              if (!(salaryRange.max >= lo && salaryRange.min <= hi)) {
                state.skippedCount += 1;
                seen.add(info.jobId);
                await markSeen(info.jobId);
                log(`跳过《${info.title}》@${info.company}：薪资 ${effectiveSalary} 不在期望范围内`);
                continue;
              }
            }
          }

          if (!aiEnabled) {
            // 没开 AI：只要拿到 JD 就把它挂上去，让关键词/排除词能命中职位描述里的技能词
            info.jdText = detail.jd;
          } else {
            stat.evaluated += 1;
            const scored = await scoreViaAi(info, detail.jd);

            if (!scored.ok) {
              state.aiFailCount += 1;
              state.errorCount += 1;
              // 打分失败不拉黑，下次运行会重试（也避免因为一次网络抖动永久漏掉岗位）
              log(`《${info.title}》@${info.company}：AI 打分失败（${scored.error}），本次跳过、下次重试`, 'error');
              continue;
            }

            state.scoredCount += 1;
            const decision = SHOULD_APPLY ? SHOULD_APPLY(scored.result, config.aiThreshold) : { ok: true, why: '' };
            const tag = scored.cached ? '（缓存）' : '';
            if (!decision.ok) {
              state.skippedCount += 1;
              seen.add(info.jobId);
              await markSeen(info.jobId);
              log(`跳过《${info.title}》@${info.company}：${decision.why}${tag}`);
              continue;
            }
            log(`《${info.title}》@${info.company}：${decision.why}${tag}，准备投递`, 'success');
          }
        }

        try {
          // 只对本轮做防死循环：同一岗位连续把页面带跑 ≥3 次就先放过，
          // 但**不做永久黑名单**（不写入已处理记录），下次运行照样会重新尝试。
          const bouncedTimes = (state.bounceCounts && state.bounceCounts[info.jobId]) || 0;
          if (bouncedTimes >= 3) {
            stat.ruleSkip += 1;
            log(`跳过《${info.title}》@${info.company}：本轮已连续 ${bouncedTimes} 次点击导致整页跳转，先放过它（下次运行会重新尝试）`, 'warn');
            continue;
          }

          // 点击「打招呼」之前先清掉上一个岗位可能遗留的确认框：
          // 它既会遮挡点击，也会污染本次的"是否发送成功"判定。
          setAction(`点击打招呼：《${info.title}》`);
          await clearStaleSentDialog();
          const chat = await openChatForCard(card, info);

          // 按钮显示「继续沟通/已发送」：此前已联系过。绝不能点——点了会跳到沟通页把任务带走。
          if (chat.already) {
            state.skippedCount += 1;
            stat.chatted += 1;
            seen.add(info.jobId);
            await markSeen(info.jobId);
            log(`跳过《${info.title}》@${info.company}：该岗位此前已联系过（按钮为「${chat.reason}」）`);
            continue;
          }

          if (!chat.ok) {
            state.errorCount += 1;
            log(`《${info.title}》@${info.company}：${chat.reason || '未找到打招呼按钮'}，跳过（下次会重试）`, 'warn');
            continue;
          }

          const result = await sendGreeting(config.greeting);          if (result.ok) {
            state.appliedCount += 1;
            stat.applied += 1;
            const notes = [];
            if (result.usedDefaultGreeting) {
              notes.push('BOSS 默认招呼语，未用自定义话术；可在 BOSS「消息通知-设置招呼语」里改默认文案');
            }
            if (result.unverified) notes.push('未确认送达，建议去 BOSS 消息里核对');
            const note = notes.length ? `（${notes.join('；')}）` : '';
            log(
              `${result.unverified ? '疑似已投递' : '已投递'}《${info.title}》@${info.company}（${info.salary}）${note}`,
              result.unverified ? 'warn' : 'success'
            );
            seen.add(info.jobId);
            await markSeen(info.jobId);
            await persistRunState();
          } else {
            state.errorCount += 1;
            log(`《${info.title}》@${info.company}：${result.reason}（下次会重试）`, 'error');
          }
        } catch (e) {
          state.errorCount += 1;
          log(`处理《${info.title}》@${info.company} 时出错：${e.message}（下次会重试）`, 'error');
        }

        if (state.appliedCount >= maxApplications) break;

        const delay = randomDelay(config.minDelayMs, config.maxDelayMs);
        await interruptibleSleep(delay);
      }

      // 每轮结束打一条可解释的小结：这是判断"有没有漏处理岗位"的唯一依据
      log(
        `本轮小结：卡片 ${stat.total} 条 → 历史已处理 ${stat.seen}｜已招呼过 ${stat.chatted}｜无标题 ${stat.noTitle}` +
        `｜规则/薪资跳过 ${stat.ruleSkip}｜送 AI 评估 ${stat.evaluated}｜本轮投递 ${stat.applied}`
      );
      if (stat.seen + stat.chatted > 0) {
        const n = stat.seen + stat.chatted;
        log(`（其中 ${n} 条来自历史记录，不会重复评估；想重新评估请点弹窗「清空已处理记录」）`);
      }

      if (state.stopRequested || state.appliedCount >= maxApplications) return;

      setAction('滚动加载/翻页');
      const nav = await goToNextPage();
      if (nav.moved) {
        page += 1;
        await sleep(1200);
        continue;
      }

      // 翻不动了：要么真的到最后一页，要么选择器失效
      log(nav.reachedEnd ? `翻页结束：${nav.reason}` : `翻页失败：${nav.reason}`, nav.reachedEnd ? 'info' : 'warn');

      // 「定时刷新捞新岗位」：一轮翻完后等待 N 分钟，重新搜索，靠历史记录只投新的
      if (!(config.refreshEnabled && config.refreshIntervalMin > 0)) return;

      if (state.appliedCount >= maxApplications) {
        log('已达「单次最多投递数」上限，本次不再等待新岗位', 'info');
        return;
      }

      const waitMinutes = Math.max(1, Number(config.refreshIntervalMin) || 10);
      const waitMs = waitMinutes * 60 * 1000;
      log(`等待 ${waitMinutes} 分钟后重新搜索新岗位（点"停止"可立即结束）...`);
      const waitStart = Date.now();
      await interruptibleSleep(waitMs);
      if (state.stopRequested) return;
      log(`等待结束（实际等待 ${Math.round((Date.now() - waitStart) / 1000)} 秒），开始重新搜索新岗位...`);

      round += 1;
      page = 1;
      log(`第 ${round} 轮：重新搜索「${(config.keywords && config.keywords[0]) || '当前列表'}」以获取新发布的岗位...`);
      if (config.keywords && config.keywords.length > 0) {
        await performSearch(config.keywords[0]);
      } else {
        // 没有关键词时只能靠刷新页面重新拉列表；先落盘，reload 后由注入逻辑续跑
        state.preserveRunState = true;
        await persistRunState();
        location.reload();
        return;
      }
      await sleep(1000);

      // 把"这一轮到底有没有捞到新岗位"说清楚，避免用户以为功能没生效
      const afterCards = getJobCards();
      let freshCount = 0;
      for (const c of afterCards) {
        try {
          const i = extractJobInfo(c);
          if (i.title && !seen.has(i.jobId)) freshCount += 1;
        } catch (e) {
          // 忽略
        }
      }
      log(
        `重新搜索完成：当前 ${afterCards.length} 个岗位，其中未处理过 ${freshCount} 个` +
        (freshCount === 0 ? '（暂无新岗位，继续等待下一轮）' : '')
      );
      continue;
    }
  }

  // ---------- 自检（把当前页面真实的选择器命中情况回报给弹窗） ----------
  /**
   * 按"第一组能命中的选择器"探测，返回 {selector, count}。
   *
   * 注意：早期版本这里返回的是 {选择器: 数量} 的映射对象，弹窗里被渲染成
   * "[object Object]"，等于自检结果全废。现在只回报真正生效的那一条选择器 + 数量。
   */
  function probeGroup(selectors) {
    for (const sel of selectors || []) {
      try {
        const n = document.querySelectorAll(sel).length;
        if (n > 0) return { selector: sel, count: n };
      } catch (e) {
        // 选择器语法错误，跳过
      }
    }
    return { selector: null, count: 0 };
  }

  /** 把首张卡片的结构压成可读摘要，便于在页面改版时定位新选择器 */
  function describeCard(card) {
    if (!card) return null;
    const parts = [];
    const nodes = Array.from(card.querySelectorAll('*')).slice(0, 80);
    for (const el of nodes) {
      const cls = Array.from(el.classList || []).join('.');
      if (!cls) continue;
      const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
      parts.push(`${el.tagName.toLowerCase()}.${cls}${txt ? ` 「${txt}」` : ''}`);
    }
    return {
      cardClass: Array.from(card.classList || []).join('.'),
      children: parts.slice(0, 18),
      htmlSnippet: (card.outerHTML || '').slice(0, 1200)
    };
  }

  /** 收集页面上"像分页"的元素，判断到底有没有下一页 */
  function describePagination() {
    const candidates = [];
    const all = Array.from(document.querySelectorAll('[class*="page"], [class*="pagination"], [class*="options"]'));
    for (const el of all) {
      const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (!txt || txt.length > 120) continue;
      const cls = Array.from(el.classList || []).join('.');
      if (!cls) continue;
      candidates.push({ cls, text: txt.slice(0, 60) });
      if (candidates.length >= 5) break;
    }
    return {
      hasNextPageText: document.body.innerText.includes('下一页'),
      candidates,
      footerSnippet: ''
    };
  }

  async function buildSelfCheckReport() {
    const cards = getJobCards();
    const first = cards[0] ? extractJobInfo(cards[0]) : null;
    let jdLen = 0;
    let jdBlocked = false;
    let jdSample = '';
    let salaryHint = '';
    if (first && first.href) {
      const detail = await fetchJdInfo(first);
      jdLen = detail.jd.length;
      // 只有确实被登录/验证页拦下才算 blocked；"拿不到正文"不等于被拦
      jdBlocked = !!detail.blocked;
      jdSample = detail.jd.slice(0, 160);
      salaryHint = detail.salaryHint || '';
    }

    const nextBtn = await findNextButton();
    // 先记录分页痕迹，再滚动探测（滚动会改变页面，探测必须在后面）
    const pagination = describePagination();
    const more = await probeMoreResults();

    return {
      url: location.href,
      isJobPage: /\/web\/geek\/job/.test(location.pathname),
      cardCount: cards.length,
      listSignatureLength: currentListSignature().length,
      selectors: {
        jobCard: probeGroup(SEL.jobCard),
        jobTitle: probeGroup(SEL.jobTitle),
        companyName: probeGroup(SEL.companyName),
        jobSalary: probeGroup(SEL.jobSalary),
        jobTags: probeGroup(SEL.jobTags),
        cardChatButton: probeGroup(SEL.cardChatButton),
        nextPageButton: probeGroup(SEL.nextPageButton),
        searchInput: probeGroup(SEL.searchInput)
      },
      firstCard: first ? {
        title: first.title,
        company: first.company,
        salary: first.salary,
        jobId: first.jobId,
        hasHref: !!first.href,
        // BOSS 对薪资数字做了字体混淆：textContent 里可能只有 "-K·薪"，没有数字。
        // 这不是选择器坏了，而是抓不到可解析的数字，薪资过滤因此无法生效。
        salaryHasDigits: /\d/.test(first.salary || ''),
        companyIsAnonymous: !!(cards[0] && cards[0].querySelector('.is-anonymous'))
      } : null,
      cardShape: describeCard(cards[0]),
      pagination,
      moreResults: more,
      nextButtonText: nextBtn ? (nextBtn.textContent || '').trim().slice(0, 20) : null,
      jd: { length: jdLen, fetched: jdLen > 0, blockedOrFailed: jdBlocked, sample: jdSample, salaryHint },
      ts: Date.now()
    };
  }

  // ---------- 消息入口 ----------
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'BA_START') {
      if (state.running) {
        sendResponse({ ok: false, reason: '任务已在运行中' });
        return true;
      }
      runAutomation(message.config);
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'BA_STOP') {
      state.stopRequested = true;
      state.running = false;
      stopKeepAlive();
      clearRunState();
      // 立刻唤醒正在等待的 interruptibleSleep（否则长等待要等定时器自然到期）
      stopWaiters.forEach((fn) => {
        try { fn(); } catch (e) { /* 忽略 */ }
      });
      stopWaiters.clear();
      log('收到停止指令，正在结束当前任务...', 'warn');
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'BA_GET_STATE') {
      sendResponse(snapshotState());
      return true;
    }

    if (message.type === 'BA_SELF_CHECK') {
      buildSelfCheckReport()
        .then(sendResponse)
        .catch((e) => sendResponse({ error: e.message }));
      return true; // 异步
    }

    return false;
  });

  // ---------- 页面加载时尝试续跑 ----------
  (async function tryResume() {
    if (!/\/web\/geek\/job/.test(location.pathname)) return;

    // 先看上次页面是怎么没的——这能解释"为什么任务跑到一半页面自己刷新了"
    try {
      const u = await chrome.storage.local.get('ba_last_unload');
      const rec = u.ba_last_unload;
      if (rec && rec.running && Date.now() - rec.at < 120000) {
        const ago = Math.round((Date.now() - rec.at) / 1000);
        const where = rec.lastAction ? `「${rec.lastAction}」` : '未知步骤';
        if (rec.href && rec.href !== location.href) {
          let samePath = false;
          try { samePath = new URL(rec.href).pathname === new URL(location.href).pathname; } catch (e) { /* 忽略 */ }
          log(`上次任务在${where}时页面发生了整页跳转（${ago} 秒前，已投递 ${rec.applied} 个）`, 'warn');
          log(`  跳转前：${String(rec.href).slice(0, 150)}`, 'warn');
          log(`  跳转后：${location.href.slice(0, 150)}${samePath ? '（同一页面，仅参数变化）' : '（页面已不同）'}`, 'warn');
        } else {
          log(`上次任务在${where}时页面被重新加载（${ago} 秒前，已投递 ${rec.applied} 个）`, 'warn');
        }
      }
    } catch (e) {
      // 忽略
    }

    const st = await readRunState();
    if (!st || st.stopRequested) return;
    if (Date.now() - (st.updatedAt || 0) > RUN_STATE_TTL_MS) {
      await clearRunState();
      return;
    }
    if (!st.config) return;
    // 等页面把职位列表渲染出来再接手
    const ready = await waitFor(() => getJobCards().length > 0, { timeout: 12000 });
    if (!ready || state.running) return;
    log('页面已重新加载，自动续跑上次未完成的任务');
    runAutomation(st.config, { resumeFrom: st });
  })();
})();
