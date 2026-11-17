// detail-guard.js
// 职责：当"整页跳转"是我们点「打招呼」误触发时，落地页通常正是该岗位的详情页。
// 与其空手弹回列表，不如**就地完成这次投递**，再返回列表继续后面的岗位。
//
// 流程：
//   1) 判断这次跳转是不是我们造成的（30 秒内、动作标签匹配）；
//   2) 在详情页尝试点「立即沟通/打招呼」，处理「已向BOSS发送消息」确认框或聊天输入框；
//   3) 把结果写进 storage（ba_detail_delivery），主脚本回到列表后会认领这次投递；
//   4) 跳回**跳转前的地址**（保留分页/筛选），主脚本自动续跑。
//
// 不做永久黑名单：失败的岗位不会被标记为已处理，下次运行仍会重试。

(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MAX_WAIT_MS = 30000;

  function visible(el) {
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

  function findButton(texts) {
    const els = Array.from(document.querySelectorAll('button, a, span, div'));
    return els.find((el) => visible(el) && texts.includes((el.textContent || '').trim())) || null;
  }

  function setNativeValue(el, value) {
    try {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) {
      // 忽略
    }
  }

  async function waitFor(fn, timeout = 6000, step = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  function guessTitle() {
    const sels = ['.job-banner .name', '.job-primary .name', '.job-title', 'h1', '.name'];
    for (const s of sels) {
      const el = document.querySelector(s);
      const t = el && (el.textContent || '').trim();
      if (t && t.length < 60) return t;
    }
    return document.title.replace(/[-|].*$/, '').trim().slice(0, 40);
  }

  /** 在详情页试着完成这次投递，返回 {ok, already, reason} */
  async function tryDeliver(greeting) {
    // 已经在沟通中 → 视为已投递（之前打过招呼）
    const chatBtn = findButton(['立即沟通', '打招呼']);
    const againBtn = findButton(['继续沟通', '继续聊']);

    if (!chatBtn) {
      if (againBtn) return { ok: true, already: true, reason: '详情页显示"继续沟通"，说明此前已联系过' };
      return { ok: false, reason: '详情页上没有找到「立即沟通/打招呼」按钮' };
    }

    chatBtn.click();

    const outcome = await waitFor(() => {
      const input = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).find(visible);
      if (input) return { type: 'input', input };
      const stay = findButton(['留在此页']);
      const cont = findButton(['继续沟通']);
      if (stay || cont) return { type: 'dialog', btn: stay || cont };
      return null;
    }, 6000);

    if (!outcome) return { ok: false, reason: '点击后既没出现输入框，也没出现确认框' };

    if (outcome.type === 'dialog') {
      outcome.btn.click();
      await sleep(900);
      return { ok: true, already: false, reason: 'BOSS 已用默认招呼语发出（确认框已处理）' };
    }

    const input = outcome.input;
    input.focus();
    setNativeValue(input, greeting || '');
    await sleep(400);
    const send = findButton(['发送']);
    if (send) send.click();
    else {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }
    await sleep(900);
    return { ok: true, already: false, reason: '已填入话术并点击发送' };
  }

  try {
    const data = await chrome.storage.local.get(['ba_last_unload', 'ba_run_state']);
    const unload = data.ba_last_unload;
    const run = data.ba_run_state;

    if (!unload || !run || !run.config) return;
    if (!unload.running) return;
    if (Date.now() - (unload.at || 0) > MAX_WAIT_MS) return;

    // 只处理我们自己点出来的跳转
    const action = unload.lastAction || '';
    if (!/点击打招呼|点击职位|打开详情/.test(action)) return;

    const jobId = location.pathname;
    const title = guessTitle();
    const back = unload.href || run.searchUrl || '';
    const onDetailPage = /^\/job_detail\//.test(location.pathname);

    // 本轮任务内的跳转计数（任务结束即失效，不做永久黑名单）
    const counts = run.bounceCounts && typeof run.bounceCounts === 'object' ? { ...run.bounceCounts } : {};
    if (jobId) counts[jobId] = (counts[jobId] || 0) + 1;

    let result;
    if (onDetailPage) {
      // 落在职位详情页：就地补投
      result = await tryDeliver(run.config.greeting);
    } else {
      // 落在沟通页这类页面：没法补投，只回跳（不是当前岗位的问题，也不要误记成功）
      result = { ok: false, reason: `跳转到了非详情页（${location.pathname}），未发送新消息` };
    }

    await chrome.storage.local
      .set({
        ba_detail_delivery: {
          jobId,
          title,
          at: Date.now(),
          ok: !!result.ok,
          already: !!result.already,
          reason: result.reason || ''
        },
        ba_run_state: { ...run, bounceCounts: counts, updatedAt: Date.now() }
      })
      .catch(() => {});

    console.log('[BOSS自动投递] 整页跳转后在详情页补投：', result);

    // 回跳到跳转前的地址，主脚本会认领这次投递并继续
    if (back && /\/web\/geek\/job/.test(back) && back !== location.href) {
      location.replace(back);
    }
  } catch (e) {
    // 任何异常都不要影响页面本身
  }
})();
