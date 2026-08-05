# PM-SMALL 紧凑 UI 参考方向

## 结论

推荐顺序如下：

1. **精密工具：Vercel 轻量骨架**（最推荐）
2. **紧凑交易终端：Binance 信息密度**
3. **安静金融界面：Coinbase 财务表达**

第一种最适合 PM-SMALL：它能让单列页面紧凑、安静且精致；第二种最擅长排列高密度市场信息，但必须主动降低“促成交易”的紧迫感；第三种对资金和手机资产列表的表达最成熟，但需要压缩原方案较大的圆角和留白。

## 研究范围与来源边界

- 本次只使用 VoltAgent 原仓库在提交 [`8147538b4226ae41e2487a9179e3bcc1f68e8554`](https://github.com/VoltAgent/awesome-design-md/tree/8147538b4226ae41e2487a9179e3bcc1f68e8554) 的一手文件，没有采用转载、截图合集或第三方解读。
- 已完整检查仓库 [README](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/README.md) 和 `design-md/` 目录；重点阅读了金融/交易类的 Binance、Coinbase、Kraken、Revolut、Wise，以及与紧凑数据界面有关的 Airtable、Cal、Cohere、Linear、Sentry、Superhuman、Vercel。
- README 写有每个站点包含 `preview.html` 和 `preview-dark.html`，但该提交的实际目录没有这两类文件；因此这次把它当作文字设计原则库，而不是可直接照抄的成品界面图库。
- 仓库自己把这些文件定义为从公开网站提取的设计分析，并注明为“as is”。因此下面引用的是该仓库记录的原则，不把它们表述为各品牌的官方设计规范，也不建议直接复制品牌标识、专有字体或整套配色。参见 [README 的用途、文件结构和许可说明](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/README.md#whats-inside-each-designmd)。

本项目仍以已经确认的产品边界为准：电脑版和手机版都是单列竖版；默认只展示 TEST/LIVE、配置入口、资金盈亏、当前持仓和扫描市场；结果方向必须醒目；扫描支持正序/倒序；手机至少支持 320px；LIVE 继续锁定。

## 方向一：精密工具（推荐）

### 参考文件与可用原则

- [Vercel DESIGN.md：Overview 与表面层级](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/design-md/vercel/DESIGN.md#overview)：用 `#fafafa` 页面、白色表面、`#ebebeb` 细边框和极轻叠加阴影建立清楚但克制的层级。
- [Vercel DESIGN.md：Typography](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/design-md/vercel/DESIGN.md#typography)：14px 正文、12px 标签和单独的等宽技术标签，适合紧凑工具界面。
- [Vercel DESIGN.md：Layout 与 Responsive Strategy](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/design-md/vercel/DESIGN.md#layout)：4px 基础间距、手机 16px 外边距、移动端单列和 44px 触控底线。
- [Vercel DESIGN.md：小圆角、输入框和轻量卡片](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/design-md/vercel/DESIGN.md#components)：基础控件 6px、内容卡片 8–12px，标准输入 40px 高，适合减少无效体积。
- [Vercel DESIGN.md：数据表示例](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/design-md/vercel/DESIGN.md#examples-illustrative)：示例使用 12px 等宽表头、14px 正文、`8px × 12px` 单元格和细行边框。该段由仓库标明为自动派生的 illustrative 示例，只能当作方向证据，不能当作已实测的 Vercel 产品组件。

### 如何适配 PM-SMALL

- 页面保持当前单列容器；桌面只放宽内容，不拆成左右栏。手机采用 16px 外边距，模块之间 12–16px，行内信息用 8–12px 间距。
- 用“浅灰页面底色 → 白色模块 → 更浅的行悬浮/选中表面”加 1px 细边框区分区域；只在配置浮层等真正抬升的元素上使用轻阴影。
- 总资金和盈亏数字使用 `font-variant-numeric: tabular-nums` 或等宽数字；标签 11–12px、关键数字 20–24px。桌面可以一行四项，手机变成 2×2，但页面整体仍是单列。
- 持仓中的 **YES / NO / 其他结果方向** 使用高对比小标签和 600–700 字重，紧邻市场名或买入价；方向是合约结果，不用涨跌红绿来表达，避免把 YES/NO 误读成盈利/亏损。
- 扫描市场沿用紧凑行：市场名最多两行，第二行集中显示结果、价格和生命周期进度；整行可点，单个复选框仍保留清晰的选中状态。
- 主强调色继续使用 PM-SMALL 自己的青绿色，不复制 Vercel 的黑白品牌组合；它只用于当前选中、可操作链接和焦点，盈亏另用语义色。

### 不应照搬

- 不照搬 Vercel 的 192px 营销分区、大面积彩色 mesh 渐变和营销胶囊按钮；它们不是工具页所需信息。
- 不把自动派生的数据表示例误当成真实产品规范；这里只采用它与正式颜色、字体、间距原则一致的紧凑表达。
- 不把红绿用于 YES/NO，不把未实现盈亏和已实现盈亏只靠颜色区分；颜色必须配合文字和正负号。

## 方向二：紧凑交易终端

### 参考文件与可用原则

- [Binance DESIGN.md：Overview](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/design-md/binance/DESIGN.md#overview)：深色画布、抬升卡片、细边线、小到中等圆角，以及独立的金融数字字体形成高密度交易界面。
- [Binance DESIGN.md：Typography](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/design-md/binance/DESIGN.md#typography)：默认正文 14px、辅助信息 12–13px、列表数字 14–16px，适合在不牺牲可读性的情况下压缩信息。
- [Binance DESIGN.md：Markets Row](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/design-md/binance/DESIGN.md#cards--containers)：市场行使用 12px 纵向内边距、细分隔线和表格数字，整行承担跳转。
- [Binance DESIGN.md：Responsive Behavior](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/design-md/binance/DESIGN.md#responsive-behavior)：固定小图标、整行 44px 以上有效触控区，并在移动端重排高密度市场信息。

### 如何适配 PM-SMALL

- 采用深色优先：近黑底、略亮卡片、1px 深灰分隔线；市场名称为主白，结果和买入价为次级高亮，辅助信息降低明度。
- 每个市场项目不做“大卡片套小卡片”，而是一个容器中的连续行；行高控制在约 68–84px，生命周期进度条压到 3–4px。
- 资金区使用粗体数字和紧凑标签；持仓结果用独立青绿或紫色标签，盈亏才用绿/红。
- 正序/倒序做成一个紧凑分段控件；“全选/清空”和“再显示 20 个”保持次级，不与模式切换抢层级。

### 不应照搬

- 不复制 Binance 黄黑配色、币种图标、品牌字体或“交易大厅”式视觉；PM-SMALL 目前是 TEST 工具，不应制造实盘紧迫感。
- 不使用绿色/红色实心买卖按钮，也不把市场结果方向映射成涨跌色。
- 不照搬横向滚动表格。项目已经确认手机是纵向列表，应直接重排字段，而不是让用户横向滑动。
- Binance 文档中的 28px 行内按钮低于本项目应采用的手机触控标准；即便视觉紧凑，实际点击区仍应至少约 44px。

## 方向三：安静金融界面

### 参考文件与可用原则

- [Coinbase DESIGN.md：Overview 与配色](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/design-md/coinbase/DESIGN.md#overview)：白色画布、克制的单一强调色和轻量灰色表面，整体比典型交易终端更安静。
- [Coinbase DESIGN.md：数字与交易语义](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/design-md/coinbase/DESIGN.md#typography)：所有财务数字采用统一的等宽/表格数字表达；涨跌颜色只作用于文字，不铺满背景。
- [Coinbase DESIGN.md：资产行](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/design-md/coinbase/DESIGN.md#trading-surfaces)：资产行使用细分隔线组织名称、价格和变化，不靠每行一张厚卡片。
- [Coinbase DESIGN.md：Responsive Behavior](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/design-md/coinbase/DESIGN.md#responsive-behavior)：手机上把资产行改为“名称一行，价格与变化一行”，并保持 44px 以上的有效触控区。

### 如何适配 PM-SMALL

- 保留浅灰页面底色、白色模块和近黑文字，让长列表在手机白天环境下更容易阅读；用青绿色作为项目自己的交互强调色。
- 资金区可以是一张轻量白卡，持仓和扫描市场则采用同一行式容器，避免每行都成为厚重大卡片。
- 所有资金、价格和盈亏数字使用表格数字；正负盈亏使用文字颜色和正负号，结果标签使用独立的浅色底加深色字。
- 手机市场项分成两到三条清楚的信息行：市场名；结果与价格；生命周期进度。不要压成桌面表格，也不要横向滚动。
- 配置展开层适合使用清晰的白底输入框、离散滑杆和 44–48px 触控项，默认收起后不占主界面空间。

### 不应照搬

- 不照搬 Coinbase 的 24px 大卡片圆角、32px 卡片内边距、96px 分区节奏和全胶囊按钮；这些会让本项目重新变松。
- 不复制 Coinbase 蓝色或资产币种图标；市场链接、选择状态和结果方向应继续保持 PM-SMALL 自己的视觉语义。
- Coinbase 文件明确说明登录后的订单簿、图表和下单表单未覆盖；不能据此臆造本项目不需要的复杂交易组件。

## 建议采用的最终组合

正式 UI 不需要在三个方向中机械地复制一个品牌。建议以方向一为主体：

- **结构和密度**：Vercel 的浅灰底、白色表面、细边框、6–12px 圆角和克制阴影；
- **财务数字与手机列表**：Coinbase 的表格数字、文字型盈亏语义和移动端两行资产结构；
- **市场列表细节**：少量采用 Binance 的 12px 行间距与整行可点击原则；
- **可选暗色模式**：只借用 [Linear 的分层表面和发丝线原则](https://github.com/VoltAgent/awesome-design-md/blob/8147538b4226ae41e2487a9179e3bcc1f68e8554/design-md/linear.app/DESIGN.md#elevation--depth)，不照搬其纯黑营销布局；
- **项目识别**：保留 PM-SMALL 自己的青绿色，不复制任何参考品牌的标识色组合。

这样能直接回应用户的四个目标：单列、紧凑、结果醒目、手机好用，同时不会把 TEST 界面做成鼓励实盘操作的交易所仿制品。
