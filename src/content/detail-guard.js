// detail-guard.js
// 只做一件事：如果上一次"整页跳转"是我们自己在点「打招呼」时误触发的，
// 就把页面弹回职位列表，让主脚本能续跑，而不是让任务死在详情页上。
//
// 背景：BOSS 的职位卡片有时点击会触发整页跳转（JS 导航，不是 <a> 的默认行为），
// 内容脚本会被销毁，从使用者角度看就是"页面自己刷新了、任务没了"。
// 捕获阶段只能拦 <a> 的默认导航，拦不住 JS 主动跳转，所以这里做"事故后自愈"。

(async function () {
  try {
    const data = await chrome.storage.local.get(['ba_last_unload', 'ba_run_state']);
    const unload = data.ba_last_unload;
    const run = data.ba_run_state;

    if (!unload || !run || !run.config) return;
    if (!unload.running) return;
    if (Date.now() - (unload.at || 0) > 30000) return; // 太久以前的事故不处理

    // 只处理"点击打招呼/点击职位"这类我们自己造成的跳转
    const action = unload.lastAction || '';
    if (!/点击打招呼|点击职位|打开详情/.test(action)) return;

    // 记录这个岗位会把页面带跑，避免主脚本再次踩坑（否则会来回弹）
    const jobId = location.pathname;
    const cur = await chrome.storage.local.get('ba_bounced_jobs');
    const list = Array.isArray(cur.ba_bounced_jobs) ? cur.ba_bounced_jobs : [];
    if (jobId && !list.includes(jobId)) {
      list.push(jobId);
      if (list.length > 200) list.splice(0, list.length - 200);
      await chrome.storage.local.set({ ba_bounced_jobs: list });
    }

    const back = run.searchUrl || '';
    if (back && /\/web\/geek\/job/.test(back) && back !== location.href) {
      console.log('[BOSS自动投递] 检测到误触发的整页跳转，正在返回职位列表：', back);
      location.replace(back);
    }
  } catch (e) {
    // 任何异常都不要影响页面本身
  }
})();
