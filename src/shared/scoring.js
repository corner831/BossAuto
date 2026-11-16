// 大模型打分逻辑：只放"纯函数"——构建提示词、解析模型返回、算缓存键。
//
// 真正的网络请求放在 background service worker 里做（MV3 下内容脚本不能跨域请求），
// 这里保持无副作用，方便在 node 里直接单测。

const SCORE_DEFAULTS = {
  // DeepSeek 的接口与 OpenAI 兼容，默认走它的官方地址：
  // 文档明确 base_url = https://api.deepseek.com，聊天端点为 /chat/completions
  endpoint: 'https://api.deepseek.com/chat/completions',
  // 官方当前可用模型名为 deepseek-flash / deepseek-v4-pro（deepseek-chat 已不在列表）
  model: 'deepseek-flash',
  threshold: 70,
  maxJdChars: 3000,
  timeoutMs: 30000
};

/**
 * 把用户填的接口地址补全成完整的 chat/completions 端点。
 *
 * 设计原则：**只补路径，不擅自加版本号**。DeepSeek 文档给的是
 * `https://api.deepseek.com/chat/completions`，而 `/v1/chat/completions`
 * 只是 OpenAI SDK 的兼容写法；早期实现无脑加 `/v1` 会在严格按文档的后端上 404。
 *
 * @param {string} input 用户输入（可只填域名）
 * @returns {string} 完整端点
 */
function normalizeEndpoint(input) {
  let s = String(input || '').trim();
  if (!s) return SCORE_DEFAULTS.endpoint;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(s)) return s;
  // 用户自己写了 /v1 这种版本段就尊重它，只补后半段
  if (/\/v\d+$/i.test(s)) return `${s}/chat/completions`;
  // 带其他自定义路径（如网关 /openai）时也只在后面追加
  return `${s}/chat/completions`;
}

// 默认的"判断标准"：只提供最低限度的通用口径，不针对任何具体画像写死规则。
// 用户可以在弹窗里填「自定义提示词」整段替换掉它（画像字段怎么解读，由用户自己决定）。
const DEFAULT_CRITERIA = [
  '你是一名严谨的求职顾问，任务是判断某个招聘岗位是否值得求职者投递简历。',
  '请依据下方给出的求职者画像与岗位信息作判断；画像可能以任意格式书写，按你自己的理解解读即可。'
].join('\n');

// 输出契约：这一段不允许被用户替换。
// 因为插件的解析器（parseScoreResponse）依赖它，缺了就无法读取分数。
const OUTPUT_CONTRACT = [
  '只输出一个 JSON 对象，不要输出解释文字，也不要用 Markdown 代码块包裹。',
  'JSON 结构必须是：{"score": <0-100 的整数>, "reason": "<不超过 40 字的中文理由>", "risks": ["<风险点，可空数组>"]}',
  'score 含义：85 以上=非常合适，70-84=值得投，50-69=可投可不投，30-49=不太合适，30 以下=明显不合适。',
  '信息不足时不要编造，给出 50-60 之间的保守分，并在 reason 里说明缺什么信息。'
].join('\n');

/**
 * 组装最终的系统提示词。
 * @param {string} [customCriteria] 用户自定义的判断标准（留空则用默认的）
 */
function buildSystemPrompt(customCriteria) {
  const criteria = String(customCriteria || '').trim() || DEFAULT_CRITERIA;
  return `${criteria}\n\n【输出格式，必须遵守】\n${OUTPUT_CONTRACT}`;
}

/** 兼容旧引用：默认系统提示词 */
const SCORE_SYSTEM_PROMPT = buildSystemPrompt('');

/**
 * 构建发给模型的 messages。
 * @param {{profile: string, job: object, jd?: string, systemPrompt?: string}} input
 *   systemPrompt：用户在弹窗里填的自定义判断标准（留空用默认）
 */
function buildScoreMessages({ profile, job, jd, systemPrompt }) {
  const truncateMiddle = getUtil('truncateMiddle');
  const jdText = truncateMiddle(jd || '', SCORE_DEFAULTS.maxJdChars);

  const jobLines = [
    `职位名称：${(job && job.title) || '未知'}`,
    `公司：${(job && job.company) || '未知'}`,
    `薪资：${(job && job.salary) || '未标注'}`,
    `标签：${(job && job.tagsText) || '无'}`
  ];
  if (jdText) jobLines.push(`岗位描述：${jdText}`);
  else jobLines.push('岗位描述：（未获取到，请仅根据上面几行判断，并在 reason 里注明信息有限）');

  const profileText = (profile || '').trim();

  // 画像原样传入，不做任何格式推断/再加解读提示——怎么解读由调用方（用户的提示词）决定。
  const userContent = [
    '【求职者画像】',
    profileText || '（未填写）',
    '',
    '【待评估岗位】',
    jobLines.join('\n')
  ].join('\n');

  return [
    { role: 'system', content: buildSystemPrompt(systemPrompt) },
    { role: 'user', content: userContent }
  ];
}

// utils.js 里的函数在两种环境来源不同：
// - 浏览器（content script / service worker）：utils.js 先加载，函数挂在全局；
// - node（单测）：走 require。
// 曾经这里写成"只要 truncateMiddle 存在就只返回它"，结果 service worker 里
// 取 stableHash 得到 undefined，报 `stableHash is not a function`。
// 现在按名字逐个解析，哪个环境有就用哪个，缺了才回退 require。
function getUtil(name) {
  if (typeof globalThis !== 'undefined' && typeof globalThis[name] === 'function') {
    return globalThis[name];
  }
  // eslint-disable-next-line global-require
  const mod = require('./utils.js');
  if (typeof mod[name] !== 'function') {
    throw new Error(`utils.js 缺少函数 ${name}（浏览器未加载 utils.js，或导出名不一致）`);
  }
  return mod[name];
}

/**
 * 解析模型返回的文本，得到 {score, reason, risks}。
 * 解析失败返回 null（调用方据此记一次异常，不要当成 0 分，否则会误跳过岗位）。
 * @param {string} text
 */
function parseScoreResponse(text) {
  if (!text || typeof text !== 'string') return null;

  // 去掉可能的 ```json 包裹
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  // 取第一个 { 到最后一个 } 之间的内容，容忍模型多说一句废话
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  let obj;
  try {
    obj = JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const rawScore = Number(obj.score);
  if (!Number.isFinite(rawScore)) return null;

  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const reason = typeof obj.reason === 'string' ? obj.reason.trim().slice(0, 120) : '';
  const risks = Array.isArray(obj.risks)
    ? obj.risks.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim().slice(0, 60)).slice(0, 5)
    : [];

  return { score, reason, risks };
}

/**
 * 分数缓存键：同一份画像 + 同一个岗位 + 同一份 JD 只花一次 token。
 * 画像或 JD 变了会得到新键，保证不会拿到过期结论。
 */
function scoreCacheKey(profile, job, jd) {
  const stableHash = getUtil('stableHash');
  return [
    's',
    stableHash(profile || ''),
    stableHash(`${(job && job.jobId) || ''}|${(job && job.title) || ''}|${(job && job.company) || ''}`),
    stableHash(jd || '')
  ].join(':');
}

/**
 * 是否达到投递门槛。
 * @param {{score:number}|null} result
 * @param {number} threshold
 */
function shouldApply(result, threshold) {
  if (!result || !Number.isFinite(result.score)) return { ok: false, why: '打分失败' };
  const th = Number.isFinite(threshold) ? threshold : SCORE_DEFAULTS.threshold;
  if (result.score < th) {
    return { ok: false, why: `AI 评分 ${result.score} 低于阈值 ${th}${result.reason ? `（${result.reason}）` : ''}` };
  }
  return { ok: true, why: `AI 评分 ${result.score}${result.reason ? `（${result.reason}）` : ''}` };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SCORE_DEFAULTS,
    DEFAULT_CRITERIA,
    OUTPUT_CONTRACT,
    SCORE_SYSTEM_PROMPT,
    buildSystemPrompt,
    buildScoreMessages,
    parseScoreResponse,
    scoreCacheKey,
    shouldApply,
    normalizeEndpoint
  };
}
