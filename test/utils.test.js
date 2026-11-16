const test = require('node:test');
const assert = require('node:assert/strict');
const { listSignatureOf, stableHash, truncateMiddle, backoffDelay, classifyDetailFetch } = require('../src/shared/utils.js');

test('listSignatureOf 只保留路径，忽略会变化的追踪参数', () => {
  const a = listSignatureOf([
    '/job_detail/abc.html?lid=111&securityId=xxx',
    '/job_detail/def.html?lid=222&securityId=yyy'
  ]);
  const b = listSignatureOf([
    '/job_detail/abc.html?lid=999&securityId=zzz',
    '/job_detail/def.html?lid=888&securityId=www'
  ]);
  assert.equal(a, '/job_detail/abc.html|/job_detail/def.html');
  assert.equal(a, b, '同一批职位换了追踪参数后签名必须相同，否则每页都会被判定为"列表变了"');
});

test('listSignatureOf 对空值与非法输入不抛错', () => {
  assert.equal(listSignatureOf([]), '');
  assert.equal(listSignatureOf(null), '');
  assert.equal(listSignatureOf(['', null]), '');
});

test('listSignatureOf 能反映列表真实变化', () => {
  const a = listSignatureOf(['/job_detail/abc.html']);
  const b = listSignatureOf(['/job_detail/xyz.html']);
  assert.notEqual(a, b);
});

test('stableHash 对同一输入稳定、对不同输入不同', () => {
  assert.equal(stableHash('hello'), stableHash('hello'));
  assert.notEqual(stableHash('hello'), stableHash('hellp'));
  assert.equal(stableHash('').length, 8);
});

test('truncateMiddle 保留头尾并控制长度', () => {
  const long = 'A'.repeat(100) + 'B'.repeat(100);
  const out = truncateMiddle(long, 50);
  assert.ok(out.length <= 50, `长度应 <= 50，实际 ${out.length}`);
  assert.ok(out.startsWith('A'));
  assert.ok(out.endsWith('B'));
  assert.equal(truncateMiddle('short', 100), 'short');
  assert.equal(truncateMiddle('', 100), '');
});

test('backoffDelay 指数增长且不超过上限', () => {
  assert.ok(backoffDelay(0, 1000, 20000) >= 1000);
  assert.ok(backoffDelay(5, 1000, 20000) <= 25000);
  assert.ok(backoffDelay(0, 1000, 20000) < backoffDelay(3, 1000, 20000));
});

// 回归：正常页面 JS 里带有 security-check / 安全验证 等字样，
// 早期实现先搜关键字再解析，导致大量正常页被误判成"被风控拦截"。
test('只要解析出正文就判 ok，即使 HTML 里含安全字样', () => {
  const html = '<html><script>var x="security-check";</script><div class="job-sec-text">'
    + '负责安全平台建设，要求熟悉数据治理与B端产品规划，三年以上相关经验。</div></html>';
  const jdText = '负责安全平台建设，要求熟悉数据治理与B端产品规划，三年以上相关经验。';
  assert.equal(
    classifyDetailFetch({ jdText, html, finalUrl: 'https://www.zhipin.com/job_detail/abc.html', hints: ['安全验证', 'security-check'] }),
    'ok'
  );
});

test('重定向到登录/验证页判 blocked', () => {
  assert.equal(
    classifyDetailFetch({ jdText: '', html: '<html></html>', finalUrl: 'https://www.zhipin.com/web/user/?ka=header-login' }),
    'blocked'
  );
  assert.equal(
    classifyDetailFetch({ jdText: '', html: '', finalUrl: 'https://www.zhipin.com/verify-slider.html' }),
    'blocked'
  );
});

test('页面出现强特征词且没有正文判 blocked', () => {
  assert.equal(
    classifyDetailFetch({ jdText: '', html: '<div>请完成验证后继续</div>', finalUrl: 'https://www.zhipin.com/job_detail/x.html', hints: ['请完成验证后继续'] }),
    'blocked'
  );
});

test('既没有正文也没有特征词判 empty（不是被拦，是没解析到）', () => {
  assert.equal(
    classifyDetailFetch({ jdText: '', html: '<div>前端渲染的空壳</div>', finalUrl: 'https://www.zhipin.com/job_detail/x.html', hints: ['请完成验证后继续'] }),
    'empty'
  );
});

test('正文过短（少于 20 字）不算解析成功', () => {
  assert.equal(
    classifyDetailFetch({ jdText: '短文本', html: '<div></div>', finalUrl: 'https://www.zhipin.com/job_detail/x.html', hints: [] }),
    'empty'
  );
});
