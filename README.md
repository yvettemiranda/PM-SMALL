# PM-SMALL

基于 Polymarket 公开市场与订单簿数据的低价合约 TEST 自动交易程序。

> 当前版本：`v0.5.0` 开发版。只允许 `TEST + LIVE_DISABLED`；钱包、真实订单、签名和链上操作全部禁用。

## 交接入口

按以下顺序阅读：

1. [`HANDOFF.md`](HANDOFF.md)：当前进度、验证和下一步；
2. [`docs/DECISIONS.md`](docs/DECISIONS.md)：当前有效业务规则；
3. [`docs/PLAN.md`](docs/PLAN.md)：阶段与完成标准；
4. [`SECURITY.md`](SECURITY.md)：安全边界。

## 核心逻辑

- 流式遍历 Polymarket 全部开放事件分页，再筛选具体市场；不在内存堆积完整事件图，也不设本地市场或 Token 数量上限。
- 市场必须开放、未关闭/归档、允许下单、启用订单簿并具有 Condition ID。
- 具体市场总时长的最短、最长值都可按完整天数自由设置，范围各为 1–365 天；默认 `1 天 <= 总时长 <= 30 天`。生命周期进度是可配置硬门槛，默认 `<=20%`。
- 标准 Event 统一支持任意安全整数 `resultCount >= 2`：单 Market Event 视为二元，标准 Negative Risk Multi-Market Event 可为任意 N 元，`negRiskAugmented=true` 继续排除。配置分为二元、三元和多元（4+），升级与重置默认只启用二元/三元，多元须由用户主动勾选。
- Polymarket 首页栏目按官方 Tag ID 动态同步并默认全选。没有官方标签的市场仅在“全选”下参与，不制造伪类别，也没有历史成交量硬过滤。
- 先按结果数、首页栏目、自由时长区间、生命周期进度和体育开赛等静态条件预筛，再以有界并发拉取盘口；全部静态合格 Token 进入增量 WebSocket 监控，包括暂时价格过高或无盘口者。只有完整新鲜盘口的 Best Ask 在固定 1¢ 至用户 1–3¢ 上限之间、存在有效 Best Bid、Bid/Ask 比例达到配置（默认 50%）、tick 和最小下单量有效时，才允许按 FAK 买入。
- 普通重扫只在同一 WebSocket 上增量订阅/退订，不清空保留候选；真实断线时保留上次报价用于页面说明，但明确标记不可交易，完整盘口恢复前不会买入。CandidateService 同时维护 Token 和 Event 索引；单 Token 行情只局部重算所属 Event，不遍历全市场。
- 未锁定 Event 只有在全部静态合格兄弟 Token 都取得新鲜完整 Book 后才仲裁；完整 Book 但无有效 Bid/Ask 只淘汰该 Token。仲裁使用与真实执行共用的无副作用 FAK Preview；多个 SELL target 按顺序消费同一份 mutable Bid 深度，再按退出就绪度、真实共享深度覆盖、资金可成交比例、Bid/Ask、费后目标收益率、生命周期及稳定身份字段确定唯一 Winner。
- 买入可部分成交，剩余立即取消。每笔填充创建 `max(买价+1¢, 买价×1.5)`、按 tick 向上取整的目标卖出价。
- Best Bid 达标后立即按 FAK 卖出；买入完成时也会在同一盘口立即复查。部分卖出继续等待，首次卖出后本轮停止新买。
- 已消费深度按单侧完整盘口状态持久化，重复增量、等价快照、断线和重启都不能重复成交。
- 首笔实际 Fill 与 Event Lock、订单、fills、仓位、目标单、现金和盘口消费在同一 SQLite 事务提交；同一 Event 一轮只能持有一个 Token。每 Event 每轮预算在首笔 Fill 时冻结，后续剩余额度只可继续给 active Token。
- 首次实际 Sell 后整个 Event 停止继续买；完全卖清且没有活动卖单时原子释放 Event。若仍有合法开放兄弟 Market，下一轮重新仲裁，Winner 可以改变；没有手动“新一轮”入口。
- 具体 Condition 正式关闭并确认结果后，自动完成 TEST 结算和模拟赎回并原子释放当前 Event 周期；该 Condition 永久停止交易，但不错误关闭仍有开放兄弟 Market 的整个 Event。
- 买卖使用动态费用，资金和盈亏按净额计算；明确没有买盘时持仓可实现估值为 0。

## UI

- 手机优先、桌面与手机共用单列页面，至少支持 320px；
- 左上角 `TEST / LIVE`，LIVE 锁定；
- 默认只展示总资金、持仓实时价值、持仓数、当前持仓和扫描 Event，配置按需展开；
- 配置包括 Polymarket 首页栏目、二元/三元/多元（4+）、1–3¢ 买价、Bid/Ask 比例、最大生命周期进度、总时长自由区间、总模拟资金和每 Event 每轮金额；
- 符合配置的市场全部自动参与，不提供逐 Token 勾选；
- 当前持仓显示 Event、active Token、冻结预算、已用金额和累计/退出状态；持仓与扫描 Event 均默认显示前 20 项并可展开；扫描 Event 固定将可交易项排在待定项前面，两组内部使用一个小按钮切换生命周期进度正序/倒序；
- 扫描状态显示事件/盘口进度、监控数、可交易数和主要排除原因；行情重连时候选保留在列表并显示“上次价格/重连中”；
- 价格以两位小数美分显示，页面约每 500ms 刷新。

## 环境

- Node.js 24 或更高版本；
- npm 11 或更高版本；
- macOS 或 Linux；服务器推荐 Docker。

## 本地启动

```bash
cp .env.example .env
npm ci
npm run dev
```

打开 `http://localhost:3000`。

## Docker 启动

```bash
cp .env.example .env
docker compose up --build
```

Docker 默认只绑定 `127.0.0.1:3000`。服务器跨设备访问必须经过受信任 HTTPS、Nginx 和登录认证；不要把 3000 端口直接暴露到公网。详见 [`docs/SERVER_DEPLOY.md`](docs/SERVER_DEPLOY.md)。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

只读长期 TEST 留证工具仍使用兼容命令名：

```bash
npm run paper:soak -- --duration-seconds 300 --interval-seconds 10
```

兼容留证工具的操作与停止条件见 [`docs/PAPER_SOAK.md`](docs/PAPER_SOAK.md)。正式验证采用累计 72 小时、每 4 小时与配置变化分段、逐段由用户决定是否计入的管理流程，详见 [`docs/FORMAL_TEST_CAMPAIGN.md`](docs/FORMAL_TEST_CAMPAIGN.md)；未经用户新的开始指令不得执行。

## 安全边界

- 当前公开模式只有 TEST；内部 `paper_*` 表名是历史兼容实现；
- 不读取或保存私钥、助记词、钱包或交易凭据；
- `.env`、`data/`、SQLite、备份和日志不得提交 Git；
- 数据不完整时保守等待，不推定成交或结算；
- 完成长时间 TEST 验证前不得接入钱包或启用 LIVE。
