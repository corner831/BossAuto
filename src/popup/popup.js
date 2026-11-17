// popup.js
// 负责：读写用户配置（chrome.storage.local）、控制 content script 的启停、
// 展示实时进度日志、页面自检、AI 打分配置。

const JOB_PAGE_PREFIX = 'https://www.zhipin.com/web/geek/job';
const STORAGE_KEY_CONFIG = 'ba_config';

const DEFAULT_GREETING = '您好，我对这个岗位很感兴趣，我的经历和岗位要求比较契合，期待能和您聊聊，谢谢！';

// 新字段的默认值，保证老配置（没有这些字段）也能正常跑
const AI_DEFAULTS = {
  aiEnabled: false,
  apiEndpoint: 'https://api.deepseek.com',
  apiModel: 'deepseek-flash',
  apiKey: '',
  profile: '',
  aiPrompt: '',
  aiThreshold: 70,
  refreshEnabled: false,
  refreshIntervalMin: 10
};

const els = {
  hint: document.getElementById('not-on-page-hint'),
  form: document.getElementById('config-form'),
  keywords: document.getElementById('keywords'),
  excludeKeywords: document.getElementById('excludeKeywords'),
  excludeCompanies: document.getElementById('excludeCompanies'),
  salaryMin: document.getElementById('salaryMin'),
  salaryMax: document.getElementById('salaryMax'),
  jobType: document.getElementById('jobType'),
  experience: document.getElementById('experience'),
  degree: document.getElementById('degree'),
  greeting: document.getElementById('greeting'),
  maxApplications: document.getElementById('maxApplications'),
  minDelay: document.getElementById('minDelay'),
  maxDelay: document.getElementById('maxDelay'),

  aiEnabled: document.getElementById('aiEnabled'),
  apiEndpoint: document.getElementById('apiEndpoint'),
  apiModel: document.getElementById('apiModel'),
  apiKey: document.getElementById('apiKey'),
  profile: document.getElementById('profile'),
  aiPrompt: document.getElementById('aiPrompt'),
  aiThreshold: document.getElementById('aiThreshold'),
  refreshEnabled: document.getElementById('refreshEnabled'),
  refreshIntervalMin: document.getElementById('refreshIntervalMin'),

  startBtn: document.getElementById('start-btn'),
  stopBtn: document.getElementById('stop-btn'),
  selfCheckBtn: document.getElementById('selfcheck-btn'),
  selfCheckOut: document.getElementById('selfcheck-out'),
  clearCacheBtn: document.getElementById('clear-cache-btn'),
  clearSeenBtn: document.getElementById('clear-seen-btn'),
  aiSection: document.getElementById('ai-section'),

  statusBadge: document.getElementById('status-badge'),
  appliedCount: document.getElementById('applied-count'),
  skippedCount: document.getElementById('skipped-count'),
  errorCount: document.getElementById('error-count'),
  logPanel: document.getElementById('log-panel')
};

function splitList(value) {
  return (value || '')
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function readConfigFromForm() {
  return {
    keywords: splitList(els.keywords.value),
    excludeKeywords: splitList(els.excludeKeywords.value),
    excludeCompanies: splitList(els.excludeCompanies.value),
    salaryMin: Number(els.salaryMin.value) || 0,
    salaryMax: Number(els.salaryMax.value) || 0,
    jobType: els.jobType.value,
    experience: els.experience.value,
    degree: els.degree.value,
    greeting: els.greeting.value.trim() || DEFAULT_GREETING,
    maxApplications: Math.min(200, Math.max(1, Number(els.maxApplications.value) || 20)),
    minDelayMs: Math.max(1000, (Number(els.minDelay.value) || 3) * 1000),
    maxDelayMs: Math.max(1000, (Number(els.maxDelay.value) || 8) * 1000),

    aiEnabled: !!els.aiEnabled.checked,
    apiEndpoint: els.apiEndpoint.value.trim() || AI_DEFAULTS.apiEndpoint,
    apiModel: els.apiModel.value.trim() || AI_DEFAULTS.apiModel,
    apiKey: els.apiKey.value.trim(),
    profile: els.profile.value,
    aiPrompt: els.aiPrompt.value,
    aiThreshold: Math.min(100, Math.max(0, Number(els.aiThreshold.value) || AI_DEFAULTS.aiThreshold)),
    refreshEnabled: !!els.refreshEnabled.checked,
    refreshIntervalMin: Math.min(240, Math.max(1, Number(els.refreshIntervalMin.value) || AI_DEFAULTS.refreshIntervalMin))
  };
}

function writeConfigToForm(config) {
  const c = { ...AI_DEFAULTS, ...(config || {}) };
  els.keywords.value = (c.keywords || []).join(', ');
  els.excludeKeywords.value = (c.excludeKeywords || []).join(', ');
  els.excludeCompanies.value = (c.excludeCompanies || []).join(', ');
  els.salaryMin.value = c.salaryMin || '';
  els.salaryMax.value = c.salaryMax || '';
  els.jobType.value = c.jobType || '';
  els.experience.value = c.experience || '';
  els.degree.value = c.degree || '';
  els.greeting.value = c.greeting || DEFAULT_GREETING;
  els.maxApplications.value = c.maxApplications || 20;
  els.minDelay.value = (c.minDelayMs || 3000) / 1000;
  els.maxDelay.value = (c.maxDelayMs || 8000) / 1000;

  els.aiEnabled.checked = !!c.aiEnabled;
  els.apiEndpoint.value = c.apiEndpoint || AI_DEFAULTS.apiEndpoint;
  els.apiModel.value = c.apiModel || AI_DEFAULTS.apiModel;
  els.apiKey.value = c.apiKey || '';
  els.profile.value = c.profile || '';
  els.aiPrompt.value = c.aiPrompt || '';
  els.aiThreshold.value = c.aiThreshold != null ? c.aiThreshold : AI_DEFAULTS.aiThreshold;
  els.refreshEnabled.checked = !!c.refreshEnabled;
  els.refreshIntervalMin.value = c.refreshIntervalMin || AI_DEFAULTS.refreshIntervalMin;

  // 配了 AI 就默认展开面板，省得用户找不到
  if (c.aiEnabled) els.aiSection.open = true;
}

async function loadSavedConfig() {
  const data = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
  writeConfigToForm(data[STORAGE_KEY_CONFIG] || { greeting: DEFAULT_GREETING });
}

async function saveConfig(config) {
  await chrome.storage.local.set({ [STORAGE_KEY_CONFIG]: config });
}

async function getActiveJobTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.startsWith(JOB_PAGE_PREFIX)) return tab;
  return null;
}

/**
 * 自定义接口域名需要在运行时申请主机权限（manifest 里只预置了默认的 DeepSeek 域名）。
 * 必须在用户手势（如 change / click）里调用，否则会被浏览器拒绝。
 */
async function ensureEndpointPermission(endpoint) {
  const raw = (endpoint || '').trim();
  if (!raw) return true;
  let origin;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    origin = `${u.origin}/*`;
  } catch (e) {
    return false;
  }
  try {
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (e) {
    return false;
  }
}

// ---------- 日志面板：增量渲染 + 智能跟随 ----------
// 说明：每次状态更新都把整个日志重建 + 强制滚到底，会让人没法回看。
// 现在改成：只追加新行；只有"用户 5 秒内没有手动滚动过"并且本来就在底部附近时才自动跟随。
const STORAGE_KEY_LOG_HEIGHT = 'ba_log_height';
const AUTO_FOLLOW_IDLE_MS = 5000;
let renderedLogTexts = [];
let lastUserScrollAt = 0;
let autoScrollAt = 0;

function logLineNode(entry) {
  const line = document.createElement('div');
  line.className = `log-line ${entry.level || 'info'}`;
  line.textContent = `[${entry.time}] ${entry.message}`;
  return line;
}

function maybeAutoScroll() {
  const panel = els.logPanel;
  // 需求：只有"最近 5 秒内没有手动滚动过"才跟随新日志，
  // 否则保持当前位置，方便回看。
  if (Date.now() - lastUserScrollAt >= AUTO_FOLLOW_IDLE_MS) {
    autoScrollAt = Date.now();
    panel.scrollTop = panel.scrollHeight;
  }
}

function renderLogs(logs) {
  const list = logs || [];
  const texts = list.map((e) => `[${e.time}] ${e.message}`);
  const panel = els.logPanel;

  // 用"上一批最后一行"在新列表里的下标做锚点：
  // 后台只回传最近 50 条，窗口会滑动，用前缀比较会误判成"全变了"，
  // 改成锚点后只追加真正新增的行，不会打断阅读。
  let anchorIdx = -1;
  if (renderedLogTexts.length > 0) {
    anchorIdx = texts.lastIndexOf(renderedLogTexts[renderedLogTexts.length - 1]);
  }

  const tooMany = panel.childElementCount > 400;
  if (anchorIdx < 0 || tooMany) {
    // 新一轮任务（日志被清空）或节点过多：整体重建
    panel.innerHTML = '';
    for (const entry of list) panel.appendChild(logLineNode(entry));
    renderedLogTexts = texts;
    if (Date.now() - lastUserScrollAt >= AUTO_FOLLOW_IDLE_MS) {
      autoScrollAt = Date.now();
      panel.scrollTop = panel.scrollHeight;
    }
    return;
  }

  for (let i = anchorIdx + 1; i < list.length; i++) {
    panel.appendChild(logLineNode(list[i]));
  }
  renderedLogTexts = texts;
  maybeAutoScroll();
}

function renderState(state) {
  if (!state) return;
  els.appliedCount.textContent = state.appliedCount || 0;
  els.skippedCount.textContent = state.skippedCount || 0;
  els.errorCount.textContent = state.errorCount || 0;

  els.startBtn.disabled = !!state.running;
  els.stopBtn.disabled = !state.running;

  els.statusBadge.textContent = state.running
    ? '运行中'
    : (state.fromHistory ? '上次记录' : '未运行');
  els.statusBadge.className = 'badge ' + (state.running ? 'running' : 'idle');

  renderLogs(state.log);
}

async function refreshStateFromBackground() {
  const state = await chrome.runtime.sendMessage({ type: 'BA_GET_LATEST_STATE' }).catch(() => null);
  renderState(state);
}

/** 把自检结果渲染成可读文本 */
function formatSelfCheck(report) {
  if (!report) return '自检无返回';
  if (report.error) return `自检失败：${report.error}`;

  const lines = [];
  lines.push(`页面：${report.url}`);
  lines.push(`是否职位搜索页：${report.isJobPage ? '是' : '否'}`);
  lines.push(`职位卡片数量：${report.cardCount}`);
  lines.push('');

  // 选择器命中情况：只显示真正生效的那一条
  const sel = report.selectors || {};
  const failed = [];
  lines.push('选择器命中：');
  Object.entries(sel).forEach(([k, v]) => {
    const count = v && typeof v === 'object' ? v.count : v;
    const hitSel = v && typeof v === 'object' ? v.selector : '';
    const ok = Number(count) > 0;
    if (!ok) failed.push(k);
    lines.push(`  ${k.padEnd(15)} = ${String(count).padStart(3)}  ${ok ? `✔ ${hitSel}` : '✘ 未命中'}`);
  });
  lines.push('');

  if (report.firstCard) {
    lines.push(`首张卡片：${report.firstCard.title || '(空)'} @ ${report.firstCard.company || '(空)'} / ${report.firstCard.salary || '(空)'}`);
    lines.push(`  详情链接：${report.firstCard.hasHref ? '有' : '无（抓不到 JD）'}`);
    if (report.firstCard.salary && !report.firstCard.salaryHasDigits) {
      lines.push('  薪资里没有数字：BOSS 对薪资做了字体混淆，薪资过滤无法生效（不影响 AI 打分）');
    }
    if (report.firstCard.companyIsAnonymous) {
      lines.push('  公司名为匿名（如"某中型计算机软件公司"），"排除公司"只能匹配到这种匿名文案');
    }
  } else {
    lines.push('首张卡片：未解析到（卡片选择器可能已失效）');
  }

  lines.push(`下一页按钮：${report.nextButtonText || '未找到'}`);
  const pg = report.pagination || {};
  lines.push(`页面含"下一页"文字：${pg.hasNextPageText ? '是' : '否'}`);
  if (pg.candidates && pg.candidates.length) {
    lines.push('分页相关元素：');
    pg.candidates.slice(0, 4).forEach((c) => lines.push(`  .${c.cls} 「${c.text}」`));
  }
  const more = report.moreResults;
  if (more) {
    lines.push(`滚动加载探测：滚动前 ${more.before} 个 → 滚动后 ${more.after} 个 ${more.loadedMore ? '（会加载更多）' : '（无新增）'}`);
    if (more.scrollerFound) lines.push('  列表在自己的滚动容器里（不是整页滚动）');
    if (more.actionTexts && more.actionTexts.length) lines.push(`  相关按钮文案：${more.actionTexts.join(' / ')}`);
  }

  lines.push(`JD 抓取：${report.jd && report.jd.fetched ? `成功（${report.jd.length} 字）` : '失败或被拦截'}`);
  if (report.jd && report.jd.salaryHint) {
    lines.push(`  详情页薪资：${report.jd.salaryHint}（列表页薪资被字体混淆时用它兜底）`);
  }
  if (report.jd && report.jd.sample) lines.push(`  JD 开头：${report.jd.sample}`);

  // 首张卡片的 DOM 结构，用于改选择器
  if (report.cardShape) {
    lines.push('');
    lines.push(`首张卡片结构（card class = ${report.cardShape.cardClass || '(空)'}）：`);
    (report.cardShape.children || []).slice(0, 14).forEach((c) => lines.push(`  ${c}`));
  }

  // 结论：逐项判定，不再"看着差不多就说正常"
  lines.push('');
  const problems = [];
  const notes = [];
  if (report.cardCount === 0) problems.push('一个职位卡片都没解析到');
  if (!sel.companyName || !sel.companyName.count) problems.push('公司名选择器失效（排除公司会失效）');
  if (!sel.jobSalary || !sel.jobSalary.count) problems.push('薪资选择器失效（薪资过滤会失效）');
  if (!sel.jobTags || !sel.jobTags.count) problems.push('标签选择器失效（关键词只能靠标题和 JD 命中）');
  if (!sel.cardChatButton || !sel.cardChatButton.count) {
    notes.push('卡片上没有打招呼按钮，属正常（BOSS 是悬停后才渲染，插件会先 hover 再找）');
  }
  if (!report.nextButtonText) {
    const hasPager = (pg.candidates || []).length > 0 || pg.hasNextPageText;
    if (more && more.loadedMore) {
      notes.push('没有"下一页"按钮，但滚动能加载更多职位 —— 插件已支持滚动加载');
    } else if (hasPager) {
      problems.push('页面有分页元素但没定位到"下一页"按钮（翻页会失效）');
    } else {
      notes.push('没有分页元素，滚动到底也没有新增 → 该查询确实只有这一屏结果');
    }
  }

  if (problems.length === 0) {
    lines.push('结论：核心选择器正常，可以开始投递。');
  } else {
    lines.push('结论：有 ' + problems.length + ' 项需要处理 ——');
    problems.forEach((p) => lines.push(`  · ${p}`));
    lines.push('把上面这份报告整段发我，我按「首张卡片结构」校准 selectors.js。');
  }
  if (notes.length) {
    lines.push('附注：');
    notes.forEach((n) => lines.push(`  · ${n}`));
  }
  return lines.join('\n');
}

async function init() {
  await loadSavedConfig();

  // 记录"用户手动滚动日志"的时间，用来决定是否自动跟随新日志
  els.logPanel.addEventListener('scroll', () => {
    if (Date.now() - autoScrollAt < 200) return; // 我们自己滚的，不算用户操作
    lastUserScrollAt = Date.now();
  }, { passive: true });

  // 日志面板高度可拖拽调整，并记住上次的高度
  try {
    const saved = await chrome.storage.local.get(STORAGE_KEY_LOG_HEIGHT);
    const h = saved[STORAGE_KEY_LOG_HEIGHT];
    if (h) els.logPanel.style.height = `${h}px`;
  } catch (e) {
    // 忽略
  }
  els.logPanel.addEventListener('mouseup', () => {
    const h = els.logPanel.offsetHeight;
    if (h > 80) chrome.storage.local.set({ [STORAGE_KEY_LOG_HEIGHT]: h }).catch(() => {});
  });

  const tab = await getActiveJobTab();
  els.hint.classList.toggle('hidden', !!tab);
  els.startBtn.disabled = !tab;

  await refreshStateFromBackground();

  if (tab) {
    const liveState = await chrome.tabs.sendMessage(tab.id, { type: 'BA_GET_STATE' }).catch(() => null);
    if (liveState) renderState(liveState);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'BA_PROGRESS') {
      renderState(message.payload);
    }
  });

  els.startBtn.addEventListener('click', async () => {
    const activeTab = await getActiveJobTab();
    if (!activeTab) {
      els.hint.classList.remove('hidden');
      return;
    }
    const config = readConfigFromForm();

    if (config.aiEnabled) {
      if (!config.apiKey) {
        els.aiSection.open = true;
        alert('已启用 AI 打分，但还没填 API Key。\n请在「AI 智能匹配」里填写并保存，或先取消勾选。');
        return;
      }
      const granted = await ensureEndpointPermission(config.apiEndpoint);
      if (!granted) {
        alert('未获得访问该接口地址的权限，AI 打分无法工作。\n请允许权限，或改用默认的 https://api.deepseek.com。');
        return;
      }
    }

    await saveConfig(config);

    const response = await chrome.tabs.sendMessage(activeTab.id, { type: 'BA_START', config }).catch((e) => ({
      ok: false,
      reason: e.message
    }));

    if (!response || !response.ok) {
      alert('启动失败：' + (response ? response.reason : '无法连接到页面，请刷新 BOSS 直聘页面后重试'));
      return;
    }
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.statusBadge.textContent = '运行中';
    els.statusBadge.className = 'badge running';
  });

  els.stopBtn.addEventListener('click', async () => {
    const activeTab = await getActiveJobTab();
    if (!activeTab) return;
    await chrome.tabs.sendMessage(activeTab.id, { type: 'BA_STOP' }).catch(() => {});
    els.stopBtn.disabled = true;
  });

  els.selfCheckBtn.addEventListener('click', async () => {
    const activeTab = await getActiveJobTab();
    els.selfCheckOut.classList.remove('hidden');
    if (!activeTab) {
      els.selfCheckOut.textContent = '请先打开 BOSS 直聘职位搜索页（地址需以 https://www.zhipin.com/web/geek/job 开头）并刷新一次。';
      return;
    }
    els.selfCheckOut.textContent = '正在自检，请稍候...';
    const report = await chrome.tabs.sendMessage(activeTab.id, { type: 'BA_SELF_CHECK' }).catch((e) => ({ error: e.message }));
    els.selfCheckOut.textContent = formatSelfCheck(report);
  });

  // 点一下自检结果就全选，方便 Ctrl+C 复制回来分析
  els.selfCheckOut.addEventListener('click', () => {
    const range = document.createRange();
    range.selectNodeContents(els.selfCheckOut);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  els.clearCacheBtn.addEventListener('click', async () => {
    const r = await chrome.runtime.sendMessage({ type: 'BA_CLEAR_SCORE_CACHE' }).catch(() => null);
    els.clearCacheBtn.textContent = r && r.ok ? '已清空' : '清空失败';
    setTimeout(() => {
      els.clearCacheBtn.textContent = '清空打分缓存';
    }, 1500);
  });

  els.clearSeenBtn.addEventListener('click', async () => {
    const ok = confirm('清空"已处理岗位"记录？\n\n清空后，之前投递过和被跳过的岗位都会被重新评估，' +
      '已经打过招呼的岗位不会被 BOSS 重复发送，但列表里会再出现一次。');
    if (!ok) return;
    await chrome.storage.local.remove('ba_seen_job_ids');
    els.clearSeenBtn.textContent = '已清空';
    setTimeout(() => {
      els.clearSeenBtn.textContent = '清空已处理记录';
    }, 1500);
  });

  // 填了自定义接口地址就顺手申请权限
  els.apiEndpoint.addEventListener('change', async () => {
    await ensureEndpointPermission(els.apiEndpoint.value);
  });

  els.form.addEventListener('change', async () => {
    await saveConfig(readConfigFromForm());
  });
}

init();
