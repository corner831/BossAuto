// 通用纯函数工具：不依赖 DOM，方便在 node 里单测。
//
// 这些函数被 content script / background / 单元测试共用，所以只放纯计算逻辑，
// 不要在这里碰 chrome.* 或 document。

/**
 * 把职位卡片上的链接列表压成一个"列表签名"。
 *
 * 用途：判断"翻页/重新搜索"后列表是否真的变了。
 * 原实现只在点击后固定 sleep 1500ms，不校验内容变化——如果 BOSS 是 SPA 局部更新、
 * 或者下一页请求还没回来，脚本会拿着旧的卡片继续跑，表现为"卡住不动 / 重复处理"。
 *
 * @param {string[]} hrefs 卡片链接（相对路径也可以）
 * @returns {string} 稳定的签名
 */
function listSignatureOf(hrefs) {
  return (hrefs || [])
    .map((h) => {
      if (!h) return '';
      // 详情链接通常带 lid / securityId 等每次搜索都会变的追踪参数，必须只取路径部分，
      // 否则同一个列表每次都会被判成"变了"。
      try {
        const u = new URL(h, 'https://www.zhipin.com/');
        return u.pathname;
      } catch (e) {
        return String(h).split('?')[0];
      }
    })
    .filter(Boolean)
    .join('|');
}

/**
 * 计算"重试等待时间"：第 n 次重试等多久（指数退避 + 抖动）。
 * @param {number} attempt 从 0 开始
 * @param {number} baseMs
 * @param {number} capMs
 */
function backoffDelay(attempt, baseMs = 1000, capMs = 20000) {
  const raw = baseMs * Math.pow(2, Math.max(0, attempt));
  const capped = Math.min(capMs, raw);
  // 加 0~25% 抖动，避免多个请求同时重试
  return Math.round(capped * (1 + Math.random() * 0.25));
}

/**
 * 简单字符串 hash（FNV-1a 32bit），用于做缓存键。
 * 不追求抗碰撞，只要求同一输入稳定、长度可控。
 */
function stableHash(str) {
  let h = 0x811c9dc5;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 截断长文本，避免把整篇 JD 塞给模型导致 token 爆炸。
 * 保留头尾各一半，因为 JD 的"岗位职责"通常在开头、"任职要求"在结尾。
 */
function truncateMiddle(text, maxLen = 3000) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  const half = Math.floor((maxLen - 10) / 2);
  return `${s.slice(0, half)}……${s.slice(-half)}`;
}

/**
 * 判断一次"抓职位详情"的结果属于哪种情况。
 *
 * 关键规则：**只要解析出了正文，就当成功**，此时哪怕 HTML 里出现"安全验证""security-check"
 * 之类的字样也不算被拦 —— BOSS 的正常页面 JS 里就带这些字符串。
 * 早期实现反过来先搜关键字，导致大量正常页面被误判成"被风控拦截"，JD 白白丢掉。
 *
 * @param {{jdText?: string, html?: string, finalUrl?: string, hints?: string[]}} input
 * @returns {'ok'|'blocked'|'empty'}
 */
function classifyDetailFetch({ jdText, html, finalUrl, hints } = {}) {
  const text = String(jdText || '').trim();
  if (text.length >= 20) return 'ok';

  // 被重定向到登录/验证页：这是最可信的信号
  if (finalUrl && /(login|passport|verify|safe-?check)/i.test(String(finalUrl))) return 'blocked';

  const h = String(html || '');
  if ((hints || []).some((needle) => needle && h.includes(needle))) return 'blocked';

  return 'empty';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { listSignatureOf, backoffDelay, stableHash, truncateMiddle, classifyDetailFetch };
}
