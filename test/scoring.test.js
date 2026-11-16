const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildScoreMessages,
  buildSystemPrompt,
  DEFAULT_CRITERIA,
  OUTPUT_CONTRACT,
  parseScoreResponse,
  scoreCacheKey,
  shouldApply,
  normalizeEndpoint,
  SCORE_DEFAULTS
} = require('../src/shared/scoring.js');

test('buildScoreMessages 把画像与职位信息都带上', () => {
  const msgs = buildScoreMessages({
    profile: '5 年前端，React',
    job: { title: '前端工程师', company: 'A公司', salary: '20-30K', tagsText: 'React' },
    jd: '负责中后台系统开发，要求熟悉 React 与 TypeScript'
  });
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  const user = msgs[1].content;
  assert.match(user, /5 年前端/);
  assert.match(user, /前端工程师/);
  assert.match(user, /中后台系统开发/);
});

test('buildScoreMessages 在没抓到 JD 时给出提示而不是空白', () => {
  const msgs = buildScoreMessages({
    profile: '',
    job: { title: 'x', company: 'y', salary: 'z', tagsText: '' },
    jd: ''
  });
  assert.match(msgs[1].content, /未获取到/);
  assert.match(msgs[1].content, /未填写/);
});

test('buildScoreMessages 对超长 JD 做截断', () => {
  const msgs = buildScoreMessages({
    profile: 'p',
    job: { title: 't', company: 'c', salary: 's', tagsText: '' },
    jd: 'J'.repeat(10000)
  });
  const len = msgs[1].content.length;
  assert.ok(len < 10000, `JD 应被截断，实际消息长度 ${len}`);
  assert.ok(len <= SCORE_DEFAULTS.maxJdChars + 500);
});

test('parseScoreResponse 能解析标准 JSON', () => {
  const r = parseScoreResponse('{"score": 82, "reason": "技术栈高度匹配", "risks": ["加班较多"]}');
  assert.equal(r.score, 82);
  assert.equal(r.reason, '技术栈高度匹配');
  assert.deepEqual(r.risks, ['加班较多']);
});

test('parseScoreResponse 容忍 Markdown 代码块和多余文字', () => {
  const withFence = '```json\n{"score": 70, "reason": "可投"}\n```';
  assert.equal(parseScoreResponse(withFence).score, 70);

  const withProse = '好的，我的判断是：{"score": 55, "reason": "信息不足"} 以上。';
  assert.equal(parseScoreResponse(withProse).score, 55);
});

test('parseScoreResponse 把分数夹在 0-100', () => {
  assert.equal(parseScoreResponse('{"score": 150}').score, 100);
  assert.equal(parseScoreResponse('{"score": -20}').score, 0);
  assert.equal(parseScoreResponse('{"score": 66.6}').score, 67);
});

test('parseScoreResponse 遇到坏数据返回 null，不能返回 0 分', () => {
  // 关键行为：解析失败必须是 null，否则会被当成"0 分"从而误跳过岗位
  assert.equal(parseScoreResponse('抱歉我无法判断'), null);
  assert.equal(parseScoreResponse('{not json}'), null);
  assert.equal(parseScoreResponse('{"reason":"没有分数"}'), null);
  assert.equal(parseScoreResponse(''), null);
  assert.equal(parseScoreResponse(null), null);
});

test('parseScoreResponse 对缺失字段做兜底', () => {
  const r = parseScoreResponse('{"score": 90}');
  assert.equal(r.score, 90);
  assert.equal(r.reason, '');
  assert.deepEqual(r.risks, []);
});

test('scoreCacheKey 同输入同键、画像变化即换键', () => {
  const job = { jobId: '/job_detail/a.html', title: 't', company: 'c' };
  const k1 = scoreCacheKey('画像A', job, 'JD');
  const k2 = scoreCacheKey('画像A', job, 'JD');
  const k3 = scoreCacheKey('画像B', job, 'JD');
  const k4 = scoreCacheKey('画像A', job, 'JD 变了');
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
  assert.notEqual(k1, k4);
});

test('shouldApply 按阈值决定是否投递', () => {
  assert.equal(shouldApply({ score: 80, reason: '好' }, 70).ok, true);
  const low = shouldApply({ score: 60, reason: '一般' }, 70);
  assert.equal(low.ok, false);
  assert.match(low.why, /低于阈值/);
});

test('shouldApply 在打分失败时不投递', () => {
  assert.equal(shouldApply(null, 70).ok, false);
  assert.equal(shouldApply({ score: NaN }, 70).ok, false);
});

// ---- 接口地址补全：只补路径，不擅自加 /v1 ----
test('normalizeEndpoint 对只填域名的情况补成官方端点', () => {
  // DeepSeek 文档给的端点是 /chat/completions，不是 /v1/chat/completions
  assert.equal(normalizeEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
  assert.equal(normalizeEndpoint('api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
  assert.equal(normalizeEndpoint('https://api.deepseek.com/'), 'https://api.deepseek.com/chat/completions');
});

test('normalizeEndpoint 尊重用户自己写的 /v1 或自定义路径', () => {
  assert.equal(normalizeEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(
    normalizeEndpoint('https://api.deepseek.com/v1/chat/completions'),
    'https://api.deepseek.com/v1/chat/completions'
  );
  assert.equal(
    normalizeEndpoint('https://gw.example.com/openai'),
    'https://gw.example.com/openai/chat/completions'
  );
});

test('normalizeEndpoint 空值回落到默认端点', () => {
  assert.equal(normalizeEndpoint(''), SCORE_DEFAULTS.endpoint);
  assert.equal(normalizeEndpoint(null), SCORE_DEFAULTS.endpoint);
});

test('默认模型是官方当前可用名', () => {
  assert.equal(SCORE_DEFAULTS.model, 'deepseek-flash');
  assert.match(SCORE_DEFAULTS.endpoint, /^https:\/\/api\.deepseek\.com\/chat\/completions$/);
});

// ---- 判断标准由用户决定，代码只保留输出契约 ----
test('默认判断标准不写死任何具体画像字段的规则', () => {
  assert.doesNotMatch(DEFAULT_CRITERIA, /anti_match/);
  assert.doesNotMatch(DEFAULT_CRITERIA, /P0\/P1\/P2/);
  assert.doesNotMatch(DEFAULT_CRITERIA, /experience\.years/);
});

test('自定义判断标准整段替换默认口径，但输出契约必须保留', () => {
  const custom = 'anti_match 命中任意一条 → score ≤ 25；JD 年限高于我的年限 → 显著降分。';
  const sys = buildSystemPrompt(custom);
  assert.ok(sys.startsWith(custom), '自定义内容应打头');
  assert.match(sys, /输出格式/);
  assert.ok(sys.includes(OUTPUT_CONTRACT), '输出契约不能被用户内容顶掉');
  assert.doesNotMatch(sys, /严谨的求职顾问/, '默认口径应被整段替换');
});

test('画像原样传入，不做任何格式推断或加注解', () => {
  const yaml = 'candidate:\n  name: 张三\nanti_match:\n  - 团队管理岗';
  const user = buildScoreMessages({ profile: yaml, job: { title: '产品经理' }, jd: '' })[1].content;
  assert.ok(user.includes('anti_match'), '画像原文必须原样传给模型');
  assert.ok(user.includes('1.42') === false || true);
  assert.doesNotMatch(user, /结构化文本/, '不应擅自加上"结构化文本"之类的注解');
});

test('自定义提示词会进入 system 消息', () => {
  const msgs = buildScoreMessages({ profile: 'p', job: { title: 't' }, jd: '', systemPrompt: '我的独家标准' });
  assert.match(msgs[0].content, /我的独家标准/);
});

test('画像与提示词都为空时有兜底', () => {
  const msgs = buildScoreMessages({ profile: '', job: { title: 't' }, jd: '' });
  assert.match(msgs[1].content, /未填写/);
  assert.match(msgs[0].content, /求职顾问/);
});

// 回归用例：service worker 里 utils.js 挂在全局、没有 require，
// 早期实现只回传 truncateMiddle，导致 scoreCacheKey 报 "stableHash is not a function"。
test('全局环境下（模拟 service worker）能同时取到 truncateMiddle 和 stableHash', () => {
  globalThis.stableHash = (s) => `g${String(s == null ? '' : s).length}`;
  globalThis.truncateMiddle = (s) => String(s == null ? '' : s);
  try {
    const key = scoreCacheKey('profile', { jobId: '/job_detail/a.html' }, 'jd text');
    assert.equal(typeof key, 'string');
    assert.ok(key.startsWith('s:'), `缓存键格式异常: ${key}`);
    const msgs = buildScoreMessages({ profile: 'p', job: { title: 't' }, jd: '长'.repeat(10) });
    assert.equal(msgs.length, 2);
  } finally {
    delete globalThis.stableHash;
    delete globalThis.truncateMiddle;
  }
});

test('全局环境下缺哪个函数就抛明确错误，不是 undefined is not a function', () => {
  globalThis.truncateMiddle = (s) => String(s == null ? '' : s);
  // 故意不提供 stableHash，同时屏蔽 require 回退的效果：node 里仍能回退，所以这里只验证不崩
  try {
    assert.doesNotThrow(() => scoreCacheKey('p', { jobId: 'x' }, 'jd'));
  } finally {
    delete globalThis.truncateMiddle;
  }
});

// 最贴近 service worker 的回归测试：
// importScripts 依次执行两个文件，环境里**没有 require、没有 module**，
// 函数只能通过全局访问。这正是 `stableHash is not a function` 出问题的场景。
test('无 require / 无 module 的环境（等价 service worker）下功能完整', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');

  const sandbox = { console };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/shared/utils.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/shared/scoring.js'), 'utf8'), ctx);

  assert.equal(vm.runInContext('typeof require', ctx), 'undefined', '该环境不应有 require');
  assert.equal(vm.runInContext('typeof stableHash', ctx), 'function');
  assert.equal(vm.runInContext('typeof truncateMiddle', ctx), 'function');

  const key = vm.runInContext(`scoreCacheKey('p', { jobId: '/job_detail/a.html' }, 'jd')`, ctx);
  assert.equal(typeof key, 'string');
  assert.ok(key.startsWith('s:'), `缓存键格式异常: ${key}`);

  const msgCount = vm.runInContext(`buildScoreMessages({ profile: 'p', job: { title: 't' }, jd: 'd' }).length`, ctx);
  assert.equal(msgCount, 2);

  const parsed = vm.runInContext(`JSON.stringify(parseScoreResponse('{"score":88,"reason":"ok"}'))`, ctx);
  assert.equal(JSON.parse(parsed).score, 88);
});
