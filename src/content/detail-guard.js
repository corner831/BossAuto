// detail-guard.js
// 只做一件事：如果这次整页跳转是我们点「打招呼」误触发的，
// 就把页面**弹回跳转前的那个地址**（不是任务开始时的搜索地址），让主脚本续跑。
//
// 背景：BOSS 有时在职位卡片上挂 JS 点击处理器直接跳转，这类导航不是 <a> 的默认行为，
// content.js 里的 preventDefault 拦不住，脚本会被销毁。
//
// 不在本地做永久黑名单：只在本轮任务的 run state 里累加一个计数，任务结束就没了。
// 因为无法判断是平台波动还是这个岗位本身的问题，不该永久排除任何岗位。

(async function () {
  try {
    const data = await chrome.storage.local.get(['ba_last_unload', 'ba_run_state']);
    const unload = data.ba_last_unload;
    const run = data.ba_run_state;

    if (!unload || !run || !run.config) return;
    if (!unload.running) return;
    if (Date.now() - (unload.at || 0) > 30000) return; // 太久以前的事故不处理

    // 只处理我们自己点出来的跳转
    const action = unload.lastAction || '';
    if (!/点击打招呼|点击职位|打开详情/.test(action)) return;

    // 本轮任务内计数（任务结束随 run state 一起清空，不构成永久黑名单）
    const jobId = location.pathname;
    const counts = run.bounceCounts && typeof run.bounceCounts === 'object' ? { ...run.bounceCounts } : {};
    if (jobId) counts[jobId] = (counts[jobId] || 0) + 1;
    await chrome.storage.local
      .set({ ba_run_state: { ...run, bounceCounts: counts, updatedAt: Date.now() } })
      .catch(() => {});

    // 回到"跳转前"的地址：unload.href 是页面卸载瞬间的地址，
    // 比任务开始时记录的 searchUrl 更贴近当时的状态（可能带了分页/筛选参数）。
    const back = unload.href || run.searchUrl || '';
    if (back && /\/web\/geek\/job/.test(back) && back !== location.href) {
      console.log('[BOSS自动投递] 检测到误触发的整页跳转，正在返回跳转前页面：', back);
      location.replace(back);
    }
  } catch (e) {
    // 任何异常都不要影响页面本身
  }
})();
