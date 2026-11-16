# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-11-16

基于上游 `FanzhiZeng/BossAutoApply` 0.1.0 改造。

### 新增

- **AI 智能打分**：兼容 OpenAI Chat Completions 的接口（默认 DeepSeek `deepseek-flash`），
  把「求职画像 + 岗位信息 + JD」交给模型给出 0-100 分与理由，低于阈值跳过
- **自定义判断标准**：可整段替换默认口径；插件只固定 JSON 输出契约与画像原样透传
- **滚动加载**：BOSS 列表已无"下一页"元素，改为滚动到底触发加载（3 次重试 + 列表签名校验）
- **定时刷新捞新岗位**：一轮翻完后等待 N 分钟重新搜索，只投历史记录中没有的岗位
- **页面自检**：输出选择器命中数、首张卡片 DOM 结构、分页线索、JD 抓取结果
- **页面跳转续跑**：导航前把进度落盘，新页面注入后自动继续
- **进度快照持久化**：popup 关闭再打开可恢复计数与日志（徽章显示「上次记录」）

### 修复

- **JD 未参与匹配**：`selectors.js` 里的 `jobDesc` 从未被使用，导致写在 JD 里的技能词永远匹配不到
- **翻页判死**：找不到"下一页"按钮就直接结束任务，只能吃到第一屏
- **风控误判**：原先先搜 `security-check` 等字样再解析正文，而 BOSS 正常页面 JS 里就带这些字符串，
  导致大量正常页面被判成"被拦截"、JD 白丢；改为先解析正文，拿不到正文才判定拦截
- **详情页参数被删**：fetch 详情页时把 query 全删了（`securityId`/`lid`），更容易被服务端判成异常访问；已保留
- **`stableHash is not a function`**：双环境兼容函数在浏览器分支只回传 `truncateMiddle`，
  而另一处解构 `stableHash` 得到 undefined，导致 service worker 里打分全部失败
- **招呼按钮找不到**：按钮是悬停后才渲染的，改为先派发 hover 事件再查找，
  并对"点卡片后列表消失（疑似整页跳转）"做了保护

### 工程

- 单元测试从 0 增加到 44 项，覆盖匹配、打分解析、接口地址补全、JD 抓取结果分类、
  以及用 `node:vm` 模拟"无 require/module"的 service worker 环境
- 新增 `tools/verify-extension.mjs`：通过 CDP 加载扩展并验证加载与渲染

## [0.1.0]

上游原始版本，见 [FanzhiZeng/BossAutoApply](https://github.com/FanzhiZeng/BossAutoApply)。
