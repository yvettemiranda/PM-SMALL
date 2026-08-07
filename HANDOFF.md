# 项目交接记录

更新时间：2026-08-08

## 当前结论

PM-SMALL 已在本地完成从“二元/三元、每 Token 独立周期”到“任意标准多元、Event 仲裁与 Event 周期锁”的 Schema 15 架构升级。标准 Event 统一支持安全整数 `resultCount >= 2`；增强型负风险 Event 继续排除。交易、订单、Fill、Position 和 Condition 结算仍以 Token/Market 为底层单位，候选择优、单轮资金上限和同 Event 互斥提升到 Event 级。

本轮代码、迁移、API/UI 和自动化验证已完成；29 个测试文件、276 项测试、TypeScript 类型检查、生产构建、前端语法和差异检查均通过。临时空数据库在 `TEST + LIVE_DISABLED + PAUSED` 下完成 462px/320px UI 冒烟，没有横向溢出或控制台错误。整个过程没有启动 TEST、接钱包、签名、提交真实订单或执行链上操作。

当前正在同步 GitHub `main` 和 Linux 服务器。同步完成前，固定本地/远端基线仍为 `7a02b06f4b19b70c4057177ebd0bf9bfb9e1ff84`；服务器仍为旧运行时代码 `ff8b5bc9010261a349f27d7640c17789896f38d0`、Schema 14，并应保持 `TEST + LIVE_DISABLED + PAUSED`。GitHub `main` 是唯一交付进度依据；本地未推送内容或服务器临时状态不算正式进度。

## 当前扫描与执行规则

1. 扫描器流式遍历全部开放 Event 分页，不使用事件日期窗口、隐藏 Event/Market/Token 数量上限，也不在新一轮开始时清空上一轮结果。
2. Event 必须明确开放、未关闭、未归档；每个具体 Market 必须开放、可下单、启用订单簿、有 Condition ID、费用状态明确，且具体市场时间、体育开赛时间和官方栏目符合设置。
3. 单 Market Event 视为二元；标准 Negative Risk Multi-Market Event 以原始 `event.markets.length` 作为整体结果数。配置分为 `BINARY`、`TERNARY`、`MULTI`（4+）；升级和重置默认只启用二元/三元，多元由用户主动开启。
4. 对所有通过静态资格的具体 Market 生成 YES/NO Token，并保留高于当前买价或暂时无有效价但仍需监控的 Token。Token 始终携带 Event、Market、Condition、direction 和整体 resultCount 身份。
5. 盘口拉取后，每个 Token 先过现有硬资格：新鲜完整 Book、身份一致、Ask 1–3¢、有效 Bid、Bid/Ask 比例、时长、生命周期进度、官方栏目、最小下单量、tick 和体育开赛边界。
6. 未锁 Event 只有全部静态合格兄弟 Token 的盘口状态都明确、新鲜、完整时才开始比较。完整 Book 但没有有效 Bid/Ask 只淘汰该 Token；未取得完整 Book、重连或未知状态会阻断整个 Event 本轮开仓。
7. 每个合格 Token 使用与真实成交完全相同的 FAK 规划核心做无副作用 Preview，带入已持久化盘口消费、现金、冻结预算、费用、min size、tick、逐 Fill 目标与目标 Bid 深度。
8. Event 仲裁依次比较：最难退出 Fill 的 `BestBid/TerminalTarget`、目标价 Bid 深度覆盖率、预计成交资金比例、`BestBid/BestAsk`、费后目标净收益率、生命周期顺序、稳定身份字段。`NO_FILL` 或 spent=0 不得成为 Winner。
9. 执行前使用最新配置、兄弟盘口 revision、数据库锁、现金、仓位和盘口消费重新评估。变化后采用最新结果，不执行陈旧 Winner。
10. 实际买入按 Best Ask 执行 FAK，可跨档部分成交；0 Fill 不创建锁。第一次实际 Fill、Event 锁、订单、fills、仓位、targets、资金和盘口消费在同一 SQLite 事务提交。
11. 同一 Event 每轮最多一个 active Token。锁定后只允许该 Token 在冻结的 Event 轮次预算内继续累计；兄弟 Token 禁买，兄弟普通报价变化不再触发无意义仲裁。
12. 每笔 Fill 的目标价为 `max(买价+1¢, 买价×1.5)`并按 tick 向上取整；Best Bid 达标后以 FAK 从高到低退出。首次实际 Sell 后整个 Event 禁止继续买入。
13. 最后一部分仓位退出且没有活动 SELL 时，在同一事务释放 Event 锁；若 Event 仍开放，下一轮重新完整仲裁，Winner 可以变成另一个兄弟 Token。
14. 具体 Condition 正式结算仍使用原二元 payout 模型。结算清仓与 Event 解锁同事务；只结束该 Condition，不永久关闭仍有合法开放兄弟 Market 的整个 Event。

因此用户之前询问的流程可以概括为：先扫描 Event/具体 Market 的静态结构，再取得所有参与兄弟 Token 的完整盘口，按 Token 硬资格过滤，做真实 FAK Preview，最后在 Event 内选出唯一 Winner；页面只显示完整评估后的 Event 机会。PAUSED 时发现层仍可扫描和展示，但不会执行买入。

## 数据库与升级

- Schema 15 重建 `paper_trading_preferences`，新增 `multi_enabled`；重建 `paper_market_metadata`，将 `result_count` 放宽为 `NULL` 或 2 至 JavaScript 最大安全整数的 SQLite INTEGER。
- 新增 `paper_event_locks`，正常锁为 `ACTIVE`，历史同 Event 多 Token 正仓为 `LEGACY_CONFLICT`；新增 Event/Token 查询索引。
- 迁移与 schema version 登记在同一事务执行，并强制策略为 `PAUSED`。所有旧活动 BUY 取消并释放预留现金；活动 SELL、成交、仓位、结算、审计和盘口消费保留。
- 旧 Event 只有一个正仓 Token 时创建对应 ACTIVE legacy lock，冻结预算为其已使用现金；同 Event 有两个及以上正仓 Token 时标记 `LEGACY_CONFLICT`，禁止新增买入，只允许减仓和正式结算，不自动挑选赢家或删除历史。
- `validatePaperState()` 继续核对 SQLite、订单、fills、费用、仓位、targets 和资金守恒，并新增 Event 身份、单 Token 互斥、锁与正仓/target 一致、兄弟 BUY、首次 Sell 后 BUY、冻结预算、settled Condition、僵尸锁和 legacy conflict 校验。

## API 与 UI

- 配置页显示 Polymarket 首页栏目并默认全选；栏目变更由公开接口同步。市场类型为二元、三元、多元（4+）；多元默认关闭。市场总时长的最短/最长值都可在 1–365 天内自由输入。
- 扫描主列表按 Event 聚合，显示 N 元结果数、当前参与/合格 Token 数、Winner 的 Market/YES-NO、锁/退出/冲突状态和可展开的兄弟 Token，不把多元 Event 铺成大量独立机会。
- 手动 TEST 买入只能提交最新完整仲裁的 Winner，并在执行前再次评估；未锁 Event 盘口不完整、Winner 改变或 0 Fill 都失败关闭。
- 持仓继续按 Token 展示实际执行细节，同时增加 Event 锁状态、active Token、周期状态、冻结预算和本轮已用金额。资金摘要单行显示总资金、持仓实时价值和持仓数；持仓与 Event 列表默认前 20 项；排序使用单按钮切换。
- 状态与 soak 诊断增加 monitored Event/Token、完整/不完整 Event、eligible Token、仲裁/重算/stale 拒绝、锁定/退出/conflict 和最大 resultCount 指标。

## 本轮已完成验证

- 结果数覆盖 2、3、4、10、128 和非法/增强型负风险边界；多元默认关闭与 API 保存/恢复均有回归。
- FAK Preview 与实际成交共用纯规划核心；覆盖多档深度、已消费盘口、费用、min size、目标、成交比例与 `NO_FILL`。
- 仲裁覆盖全部优先级、稳定 tie-break、YES/NO 竞争和“最便宜不一定获胜”。
- 完整性覆盖兄弟 `NOT_READY` 阻断、完整无 Bid 仅淘汰自身、锁定后兄弟断线不影响 active Token 退出。
- 锁与轮次覆盖 0 Fill 不锁、首个部分/完整 Fill 原子锁、兄弟互斥、近同时执行、预算冻结、改单不抬额、首次 Sell 后禁买、部分退出保持锁、完整退出解锁和下一轮换 Winner。
- 结算与迁移覆盖 Condition 结算解锁、兄弟下一轮、单 Token legacy lock、多 Token conflict、原子回滚和重启恢复。
- 最终本地验证：29 个测试文件、276 项通过；typecheck、build、`node --check src/web/app.js`、`git diff --check`通过；462px/320px PAUSED UI 和控制台通过。

## 服务器交付边界

- 公网入口：`https://43-159-133-129.sslip.io/`；应用 3000 只允许绑定 `127.0.0.1`，公网只经 Nginx 80/443、HTTPS 与登录认证。
- 部署前必须再次确认 PAUSED，停止容器后备份 `data/`、`.env` 和 `docker-compose.yml`，保存 SHA-256；在可写临时副本上执行 SQLite `integrity_check`。旧备份不得删除。
- 迁移前后必须核对 schema、策略状态、资金、订单、fills、仓位、结算和盘口消费计数；部署后复核容器、端口、HTTPS/认证、状态与 `/api/test/validation`，并做同库重启恢复。
- 本轮只允许部署 GitHub `main` 的同一 SHA 和 Schema 15，最终状态必须为 `TEST + LIVE_DISABLED + PAUSED`。不得调用 `/api/test/start`，不得把 PAUSED 下的发现层冒烟记为正式长期 TEST。

## 尚未完成

- GitHub 与服务器本轮 Schema 15 同步及其部署证据回填。
- 与用户共同制定并由用户确认的正式长期 TEST 验证计划及执行。
- 服务器此前异常进入 RUNNING 的来源、启动接口和访问审计正式复核。
- 长期接口限流、全量扫描耗时、WebSocket 容量/断线、服务器资源和公开行情成交样本验收。
- 钱包、签名、LIVE 下单/撤单/对账和链上赎回；这些仍明确禁止。

## 接手步骤

```bash
git clone https://github.com/yvettemiranda/PM-SMALL.git
cd PM-SMALL
cp .env.example .env
npm ci
npm run typecheck
npm test
npm run build
```

继续前依次阅读本文件、`docs/DECISIONS.md`、`docs/PLAN.md`、`SECURITY.md` 和 `docs/SERVER_DEPLOY.md`。任何历史方案与现行决定冲突时，以 GitHub `main` 上的代码与 `docs/DECISIONS.md` 为准。
