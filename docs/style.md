# 视觉设计语言 — 项目刊物（Editorial Design）

> K66 起生效（推翻本文件旧版「女商玄黑/冷灰/冷漆红」语言）。完整规范见 prd-forge `templates/design-system.md`；参考实现（唯一真相源）：gb-pmo 仓库 `src/styles.css`、`src/components/editorial.tsx`、`src/components/ui.tsx`。gb-crm 侧落点：`apps/web/src/styles/tokens.css`（token 值）+ `base.css`（视觉层），**组件类名与交互结构不变**。

## 设计语言

| 角色 | HEX | 用法 |
| --- | --- | --- |
| 暖纸底 paper | `#F3F2ED` | 主底色（`--bg`），页面永远铺暖纸，右上角一层极淡钴蓝光晕（`.content`） |
| 纸卡 surface | `#FBFAF6` | 卡片/弹层/表格表面（`--surface`）；区块底用 `--panel #EEECE5` |
| 墨色 ink | `#20231F` | 主文字、重结构线、甘特条、主按钮底；`--on-ink` 为墨底亮字 |
| 钴蓝 accent | `#344FC4` | **唯一品牌强调色，面积 ≤5% 只点睛**：链接/选中态/进度条/Tab 下划线/大数字点睛/必填星号。永不铺底 |
| 语义色 | ok `#327158` / warn `#9A641E` / bad `#A8483C` | 业务状态专用，一律「浅底 + 深字」成对（`*-soft`）；**错误与危险一律 `--bad`，不得借用 accent** |

辅助灰阶：次级文字 `#6C7068`（`--text-2`）· 三级 `#989B93`（`--text-3`）· 发丝线 `#DCDED6`（`--hairline`）· 重线 `#BEC2B7`（`--line-strong`，输入框边）。玄黑底辅助 token（`--cream/--note/--line-dark/--on-ink`）保留但只作兼容别名。

## 排印

- **宋体管标题，黑体管数据**：`--font-display`（Songti SC → Noto Serif CJK SC → SimSun → Georgia）只用于页级 `h1`、登录封面标语、品牌名、统计大数字（`.stat-value` / `.circle-stat-value`）；导航、正文、表格、表单、按钮一律系统黑体。
- 页首 `h1` 26px 宋体；数字一律等宽（`tabular-nums`，分页总数/统计值/编号）。
- 结构注记（面包屑、侧栏分组、卡片题）走「小字距注记」风：小字号 + 字距 0.04–0.18em + 三级灰。

## 设计约束（编码代理评审后固化）

- **表面 token**：白卡/弹层一律 `--surface`，区块底 `--panel`；主底永远是暖纸 `--bg`。禁止散落 `rgb(255,255,255)` / `#1c1c1c` 等裸值（K63 素材库旧裸值已并入 token）。
- **唯一强调色**：`--accent`（钴蓝）只做点睛，面积 ≤5%，永不铺底。允许：badge-accent、侧栏选中指示、进度条填充、Tab 下划线、统计大数字点睛、必填星号、Action 链接。禁用作卡片/按钮/弹层底色。危险/失败一律 `--bad`（`btn-danger`、`badge-danger`、`form-error`、`gantt-todo-unscheduled`）；扮演徽标属「警示」语义，用 `--warn`。
- **圆角体系**：badge/chip/按钮全圆（999）；input/select/表格/卡片 4-6px；弹层（modal / login-card / command-palette）8px。同页保持一致，不混搭。
- **弹层顶边强调（3px）统一 `--ink`**：modal、command-palette 的顶边一律墨色结构线（accent 留给 ≤5% 点睛，不占用结构强调）。
- **控件形态**：按钮/徽章/chip 全圆胶囊；主按钮钴蓝底白字（hover 上浮 1px + 轻投影）；危险按钮浅红底红字（hover 变实底白字）；次要按钮纸面细边。
- **侧栏 = 刊物目录**：纸面底（不再是玄黑），右发丝线；分组标题为小字距注记 + CSS 计数器真实序号（01/02…，品牌蓝小号）；菜单项 hover panel 浅底，选中 `--brand-soft` 底 + 品牌深字 + 左缘 2px 钴蓝指示条（hover 半高预览）。
- **动效（160–200ms，进入用 `cubic-bezier(0, 0, 0.38, 0.9)`）**：路由切换 `.main` 淡入 + 7px 上移入场；弹层 pop-in；进度条宽度过渡；按钮/卡片 hover 轻反馈；骨架屏 shimmer 保留。**完整 `prefers-reduced-motion` 降级**（base.css 末尾全局块）。禁止视差/滚动劫持/弹簧回弹。
- **图标**：统一 `@phosphor-icons/react`，一处一个 family；小控件用 `weight="bold"` + `aria-hidden`，正文用默认 weight。禁用字符 glyph（`☰ ▾ × ✓ +`）充当控件图标。
- **键盘手感（K66 不动）**：DataGrid 保持单击选中 / 双击·Enter 编辑 / Enter 下移 / Tab 右移 / Shift+Tab 左移 / Esc 取消；列表页搜索框按 `/` 聚焦，全局按 `Ctrl/Cmd+K` 打开快速搜索；侧栏分组折叠、列选择器、行多选批量操作交互全部原样。

## 例子

example/example_page.html.mhtml（旧女商快照，仅存档参考，不再是实现依据）；现行参考实现见 gb-pmo 仓库。
