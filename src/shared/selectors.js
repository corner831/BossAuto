// 集中管理页面选择器。
//
// BOSS 直聘的前端页面结构会不定期改版，如果自动化脚本"找不到职位卡片"
// 或"找不到打招呼输入框"，通常只需要更新本文件里的选择器即可，不用改动
// 其余逻辑。每一项都提供了若干候选选择器（数组），脚本会依次尝试，
// 建议保留多个候选以提高兼容性。
//
// 排查方法：在职位搜索页按 F12 打开开发者工具，用"选中元素"工具点击对应
// 区域，把新的 class / 结构补充进对应数组即可。
const BOSS_SELECTORS = {
  // 职位列表容器
  jobListContainer: ['.job-list-box', '.search-job-result', '.job-list-container', '#main'],

  // 单个职位卡片（.job-card-box 是 2026-11 实测命中的 class）
  jobCard: ['.job-card-box', '.job-card-wrapper', '.job-primary'],

  // 卡片内：职位名称
  jobTitle: ['.job-name', '.job-title'],

  // 卡片内：公司名称。
  // 实测结构：a.boss-info.is-anonymous > span.boss-name；
  // 老结构是 .company-name / .company-text .name，一并保留。
  companyName: ['.boss-name', '.company-name', '.company-text .name', '.company-info .company-name'],

  // 卡片内：薪资（实测 class 是 .job-salary，老的 .salary 一并保留）
  jobSalary: ['.job-salary', '.salary'],

  // 卡片内：标签（学历/经验/技能标签等），用于关键词匹配
  jobTags: ['.tag-list', '.job-labels', '.job-card-footer .info-desc'],

  // 卡片内：职位描述简介（如果列表页有展示）
  jobDesc: ['.info-desc', '.job-desc'],

  // 卡片内：工作地点（实测 span.company-location）
  companyLocation: ['.company-location', '.job-area', '.company-text .location'],

  // 卡片上直接可点击的"打招呼/立即沟通"按钮。
  // 重要：实测 2026-11 的列表页卡片默认**不含**任何招呼按钮，鼠标悬停后才会渲染出来，
  // 所以 content.js 会先派发 hover 事件再查找，这里多备几套候选。
  cardChatButton: [
    '.btn-startchat',
    '.start-chat-btn',
    '.op-btn',
    '.chat-btn',
    '.btn-chat',
    'a[ka*="job-chat"]',
    '.job-card-footer .btn'
  ],

  // 卡片里的职位详情链接。用于"同源 fetch 详情页正文"，这样不必真的点开卡片、
  // 不会触发页面跳转把脚本上下文销毁。
  cardLink: ['a[href*="/job_detail/"]', 'a.job-card-left', 'a'],

  // 详情页正文里的职位描述区域（fetch 回来的 HTML 里解析）
  jdDetail: [
    '.job-sec-text',
    '.job-detail-section .text',
    '.job-detail .text',
    '.detail-content .text',
    '.job-detail-content',
    '.job-sec'
  ],

  // 详情页返回"登录/验证/风控"页面时的特征词。
  // 注意：只放**页面级**的强特征，不要放 security-check / safe-check 这类
  // 会出现在正常页面 JS 里的通用字符串——否则会把正常页误判成被拦截。
  // 判定顺序也改成"先解析正文，拿不到正文才看这些词"。
  detailBlockedHints: ['安全验证', '请完成验证', '滑动验证', '滑块验证', '完成验证后继续', 'passport.bosszhipin.com', 'geek/login', '访问异常'],

  // 翻页：下一页按钮（多套候选，BOSS 改版时优先在这里补）
  nextPageButton: [
    '.options-pages a.ui-icon-arrow-right:not(.disabled)',
    '.options-pages a:last-child:not(.disabled)',
    '.next-page:not(.disabled)',
    'a[ka*="page-next"]',
    '.pagination .next:not(.disabled)',
    'button.next:not([disabled])'
  ],

  // 当按钮没有稳定 class 时，退化为按文字找"下一页"
  nextPageTextHints: ['下一页', '下页'],

  // 列表滚到底时页面会显示"没有更多"之类的文案；命中即表示真的到头了。
  // 2026-11 实测：BOSS 职位列表是滚动加载，没有"下一页"元素，全靠这组文案 + 滚动探测判断结束。
  noMoreTextHints: ['没有更多', '已加载全部', '到底了', '暂无更多'],

  // 聊天对话框（点击打招呼后弹出/跳转的会话面板）
  chatDialog: ['.dialog-container', '.chat-panel', '.im-chat-panel'],

  // 聊天输入框
  chatInput: ['.chat-input textarea', '.im-editor-input', 'textarea.input-area'],

  // 聊天发送按钮
  chatSendButton: ['.chat-input .send-btn', '.btn-send', '.send-message-btn'],

  // 一些"已沟通/继续沟通"之类的按钮文案，用来判断这个岗位是否已经打过招呼
  alreadyChattedTextHints: ['继续沟通', '已发送', '继续聊'],

  // 顶部搜索框：任务开始时会自动把关键词填进去并触发搜索，
  // 这样用户不用先手动在 BOSS 页面里搜好再打开插件
  searchInput: ['#new-search-keyword', 'input[placeholder*="搜索"]', '.search-input input', '.search-form-wrap input'],
  searchButton: ['.search-form-wrap .search-btn', 'button.search-btn', '.btn-search'],

  // 点击卡片上的"打招呼"快捷按钮后，BOSS 有时会直接用【消息通知-设置招呼语】里配置的
  // 默认话术发送，并弹出"已向BOSS发送消息"确认框，而不是给出一个可编辑的输入框——
  // 这种情况下我们的自定义话术不会生效，只能识别这个弹窗、确认已送达，然后关闭继续下一个。
  autoSentDialogHints: ['已向BOSS发送消息', '已发送消息'],
  autoSentDialogStayButtonTexts: ['留在此页'],
  autoSentDialogContinueButtonTexts: ['继续沟通'],

  // 其余可能挡住流程的通用弹窗（完善简历提示、活动弹窗等）的关闭方式
  genericDialogCloseTexts: ['我知道了', '知道了', '关闭', '暂不', '以后再说', '取消'],
  genericDialogCloseIconSelectors: ['.dialog-close', '.icon-close', '.close-btn', '.ui-icon-close'],

  // 顶部"薪资待遇"筛选下拉：点开后弹出一个选项面板，选项文案形如"15-25K"。
  // 我们会在这些选项里挑一个和用户设置的期望薪资区间重叠最多的档位并点击应用，
  // 这样搜索结果本身就是被平台筛过的，而不是等结果出来再靠脚本二次过滤。
  salaryFilterTriggerTexts: ['薪资待遇'],
  filterDropdownPanel: ['.filter-panel', '.condition-panel', '.dropdown-panel', '.popover-inner', '.filter-select-dropdown'],
  filterOptionItem: ['li', 'a', 'span.option', '.option-item'],
  filterConfirmButtonTexts: ['确定', '确认'],

  // 同样是顶部筛选下拉，用精确/包含文本匹配来选中对应选项（不像薪资那样需要按数值区间挑档位）
  jobTypeFilterTriggerTexts: ['求职类型'],
  experienceFilterTriggerTexts: ['工作经验'],
  degreeFilterTriggerTexts: ['学历要求']
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BOSS_SELECTORS;
}
