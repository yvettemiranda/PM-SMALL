# 项目交接记录

更新时间：2026-08-08

## 当前结论

PM-SMALL 已在本地完成从“二元/三元、每 Token 独立周期”到“任意标准多元、Event 仲裁与 Event 周期锁”的 Schema 15 架构升级。标准 Event 统一支持安全整数 `resultCount >= 2`；增强型负风险 Event 继续排除。交易、订单、Fill、Position 和 Condition 结算仍以 Token/Market 为底层单位，候选择优、单轮资金上限和同 Event 互斥提升到 Event 级。

本轮代码、迁移、API/UI 和自动化验证已完成；32 个测试文件、293 项测试、TypeScript 类型检查、生产构建、前端语法和差异检查均通过。用户已明确授权正式 TEST，活动 `formal-test-20260808T081226Z` 于 2026-08-08 16:12:27（Asia/Shanghai）启动；当前仍严格为 `TEST + LIVE_DISABLED`，没有接钱包、签名、提交真实订单或执行链上操作。

当前正式 TEST 运行代码提交为 `df01ecf626734e54123383357b11af22f1fe2cda`，已推送 GitHub `main` 并部署到 Linux；它修复了 `sudo` 创建证据目录与非 root 监控镜像之间的权限交接，没有新增迁移或改变交易逻辑。完整测试、类型检查、构建、Bash/前端语法和差异检查均通过。

用户已确认正式长期 TEST 采用累计 72 小时：每 4 小时及配置变化自动切段，每段先报告再由用户明确决定计入或排除，硬失败与有效采样率不足片段自动拒绝。服务器独立监控按 60 秒采样，Codex 是否打开不影响运行；用户明确不设置 Codex 自动提醒，后续回到当前任务询问时再即时读取证据。

当前监控镜像为 `pm-small-formal-test:df01ecf62673`，运行目录为 `/home/ubuntu/pm-small/data/validation/formal-test-20260808T081226Z`，启动基线为 `/home/ubuntu/pm-small-formal-test-baseline-20260808T081222Z`。最近复核为 `TEST / LIVE=False / RUNNING`、监控重启 0、账本验证通过、SQLite `ok`，首个 4 小时节点为 2026-08-08 20:12:27。

## 当前扫描与执行规则

1. 扫描器流式遍历全部开放 Event 分页，不使用事件日期窗口、隐藏 Event/Market/Token 数量上限，也不在新一轮开始时清空上一轮结果。
2. Event 必须明确开放、未关闭、未归档；每个具体 Market 必须开放、可下单、启用订单簿、有 Condition ID、费用状态明确，且具体市场时间、体育开赛时间和官方栏目符合设置。
3. 单 Market Event 视为二元；标准 Negative Risk Multi-Market Event 以原始 `event.markets.length` 作为整体结果数。配置分为 `BINARY`、`TERNARY`、`MULTI`（4+）；升级和重置默认只启用二元/三元，多元由用户主动开启。
4. 对所有通过静态资格的具体 Market 生成 YES/NO Token，并保留高于当前买价或暂时无有效价但仍需监控的 Token。Token 始终携带 Event、Market、Condition、direction 和整体 resultCount 身份。
5. 盘口拉取后，每个 Token 先过现有硬资格：新鲜完整 Book、身份一致、Ask 1–3¢、有效 Bid、Bid/Ask 比例、时长、生命周期进度、官方栏目、最小下单量、tick 和体育开赛边界。
6. 未锁 Event 只有全部静态合格兄弟 Token 的盘口状态都明确、新鲜、完整时才开始比较。完整 Book 但没有有效 Bid/Ask 只淘汰该 Token；未取得完整 Book、重连或未知状态会阻断整个 Event 本轮开仓。
7. 每个合格 Token 使用与真实成交完全相同的 FAK 规划核心做无副作用 Preview，带入已持久化盘口消费、现金、冻结预算、费用、min size、tick 和逐 Fill 目标；Exit Bid Coverage 按 target 顺序调用 `planFakSell()` 并顺序扣减同一份 mutable Bid Book，不允许不同 target 重复使用同一深度。
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
- 持仓继续按 Token 展示实际执行细节，同时增加 Event 锁状态、active Token、周期状态、冻结预算和本轮已用金额。资金摘要单行显示总资金、持仓实时价值和持仓数；持仓与 Event 列表默认前 20 项。扫描 Event 先显示可交易项、后显示待定项，两组内部继续使用单按钮切换生命周期进度正序/倒序。
- 状态与 soak 诊断增加 monitored Event/Token、完整/不完整 Event、eligible Token、仲裁/重算/stale 拒绝、锁定/退出/conflict 和最大 resultCount 指标。

## 本轮已完成验证

- 结果数覆盖 2、3、4、10、128 和非法/增强型负风险边界；多元默认关闭与 API 保存/恢复均有回归。
- FAK Preview 与实际成交共用纯规划核心；覆盖多档深度、已消费盘口、费用、min size、目标、共享 Bid 深度顺序消费、成交比例与 `NO_FILL`。
- 仲裁覆盖全部优先级、稳定 tie-break、YES/NO 竞争和“最便宜不一定获胜”。
- 完整性覆盖兄弟 `NOT_READY` 阻断、完整无 Bid 仅淘汰自身、锁定后兄弟断线不影响 active Token 退出。
- 锁与轮次覆盖 0 Fill 不锁、首个部分/完整 Fill 原子锁、兄弟互斥、近同时执行、预算冻结、改单不抬额、首次 Sell 后禁买、部分退出保持锁、完整退出解锁和下一轮换 Winner。
- 结算与迁移覆盖 Condition 结算解锁、兄弟下一轮、单 Token legacy lock、多 Token conflict、原子回滚和重启恢复。
- 最终本地验证：32 个测试文件、293 项通过；typecheck、build、`node --check src/web/app.js`、正式 TEST 包装脚本语法和`git diff --check`通过；462px/320px PAUSED UI 和控制台通过。

## 服务器交付边界

- 公网入口：`https://43-159-133-129.sslip.io/`；应用 3000 只允许绑定 `127.0.0.1`，公网只经 Nginx 80/443、HTTPS 与登录认证。
- 部署前必须再次确认 PAUSED，停止容器后备份 `data/`、`.env` 和 `docker-compose.yml`，保存 SHA-256；在可写临时副本上执行 SQLite `integrity_check`。同一次部署不得顺手删除旧备份；后续清理必须获得用户明确授权，并至少保留一份重新验证过的当前回滚备份。
- 迁移前后必须核对 schema、策略状态、资金、订单、fills、仓位、结算和盘口消费计数；部署后复核容器、端口、HTTPS/认证、状态与 `/api/test/validation`，并做同库重启恢复。
- 正式活动运行期间必须保持 Schema 15、`TEST + LIVE_DISABLED` 和当前证据链；未经用户明确授权不得停止、重置、改配置、重启正式活动或触碰 LIVE。任何片段只有在工具健康门槛通过且用户明确确认后才可计入。

## 本轮服务器交付证据

- 本轮任何写操作前的实际服务器盘点为：旧代码 `7a02b06f4b19b70c4057177ebd0bf9bfb9e1ff84`、Schema 14、`TEST + LIVE_DISABLED + PAUSED`、初始/可用资金均为 100U，订单、Fill、持仓、结算和盘口消费均为 0。该状态与旧交接所记 1000U 和历史账本不一致，但不是本轮重置造成；部署期间没有删除或改写旧备份。
- 服务器以 `git pull --ff-only` 更新到运行时代码 `cb1472c90039ed72e9038821434cf22b45153f43`，重建并启动 `bot`。迁移后及同库重启后均为 Schema 15、Event 锁 0、订单/Fill/持仓/结算/盘口消费 0、资金 100U、验证 `ok`；迁移和恢复审计已写入。
- Docker 容器最终为 `healthy`，3000 仅绑定 `127.0.0.1`；Nginx 只在 80/443 对外。公网脚本确认 HTTP 跳转 HTTPS、未认证 401、认证后首页 200、页面为 `TEST + LIVE_DISABLED + PAUSED`，TEST 验证和 SQLite 完整性均通过。
- 共享 Bid 深度精度修复发布前，服务器仓库为 `69ddc8b3393b576ab076e625a511a64ec843f08d`、工作树干净，运行状态仍为 `TEST + LIVE_DISABLED + PAUSED`、100U 空账本、Schema 15、验证通过。停止 `bot` 后新建 `/home/ubuntu/pm-small-backup-20260808T012255Z`；SHA-256 与隔离可写副本检查均通过，`integrity_check=ok`，订单/Fill/正仓/结算/Event 锁/盘口消费均为 0。
- 服务器随后快进到运行提交 `4f4f12e9eb91ef2e002906e7765a0fb6d8318a6c` 并重建镜像。同库重启后容器健康、Schema 15、100U 可用资金、空账本、Event 锁 0、验证 `ok` 均保持不变；3000 仅监听 `127.0.0.1`，Nginx 配置通过，公网 401/跳转/认证 200 与精确 UI 文案检查通过。
- 用户确认尚未正式验证且此前数据不再需要后，已重新验证上述最新 Schema 15 备份的哈希、隔离 SQLite、100U 空账本和 0 交易计数；随后删除其余 6 个旧部署备份及旧迁移备份目录，释放 `71,165,976` 字节，并清理 `1.352GB` 未使用 Docker 构建缓存。服务器只保留 `/home/ubuntu/pm-small-backup-20260808T012255Z`；磁盘占用从 8.1GB 降至 6.9GB，运行镜像、当前数据库、活动日志及 `TEST + LIVE_DISABLED + PAUSED` 状态不变。
- PAUSED 发现层的一次完整轮次遍历 182 页、18,103 个 Event；780 个 Event 通过静态结构筛选，3,192 个参与 Token 的 3,192 本盘口全部取得，行情流保持连接且扫描/行情错误均为 `null`。最终 0 个可交易 Event；逐规则淘汰主要为 `RESULT_COUNT=48,604`、`PROGRESS_ABOVE_MAX=30,782`、`ASK_ABOVE_MAX=3,035`、`DURATION_ABOVE_MAX=1,102`、`ASK_MISSING=156`、`BID_ASK_RATIO=11`。这证明扫描链路正常，当前无候选由默认二元/三元、生命周期 `<=20%`、Ask `<=3¢`、总时长 `<=30天` 等硬条件与实时盘口共同造成。
- 以上均为迁移、恢复和 PAUSED 发现层冒烟；没有调用 `/api/test/start`，不属于正式长期 TEST。
- 正式 TEST 工具准备时，服务器仓库从 `9cfe103ea76921b1a0589a8fab5e2fcdf52ed656` 快进到工具源码提交 `a2b404e69f0b2da22c7a8261d125db30dc223bab`，工作树干净；`prepare` 构建并校验独立镜像 `pm-small-formal-test:a2b404e69f0b`（镜像 ID `sha256:a2bd4013377b66e998d390d226877552f8f47490c81d4f8aa42cfd691bd532bb`）。原业务容器继续使用 `sha256:bceed0db82de8bfb0e2521bc36f2e2b60554ef705de2b51e1dc42604b22dfb95` 且 `running healthy`；复核仍为 `TEST / LIVE=false / PAUSED`、100U 初始/可用资金、验证 `True / ok / 0 / 0 / 0`。监控容器为空，`formal-test-current` 不存在，确认没有开始 72 小时活动。
- 扫描排序修复运行提交 `375ec17952a02ccab89c757185fc17119431c0ea` 已推送并部署；停机一致性备份 `/home/ubuntu/pm-small-backup-20260808T040744Z` 的 SHA-256 与隔离 SQLite 副本均通过，Schema 15、PAUSED、100U 和 0 订单/Fill/正仓/结算/Event 锁保持不变。新业务镜像 `sha256:e86a4b054cfd9b7930ee8ef9332e76654e9130d2c36d4d7345b03f42096515a4` 健康运行；实际 197 个扫描 Event 为 9 个 `READY` 全部置顶、188 个待定在后，两组进度 ASC 均通过。公网脚本全部通过，监控容器与 `formal-test-current` 仍不存在，未启动 TEST。
- 正式启动第一次尝试在调用 TEST 启动接口前因证据目录权限 `EACCES` 安全退出，策略仍为 PAUSED、账本验证通过；失败监控已停止，失败运行目录与基线保留。修复提交 `df01ecf626734e54123383357b11af22f1fe2cda` 部署后重新准备镜像并成功启动 `formal-test-20260808T081226Z`。
- 成功启动基线 `/home/ubuntu/pm-small-formal-test-baseline-20260808T081222Z` 的全部 SHA-256 项已独立复核通过。监控容器 `running`、重启 0、日志无错误；行情连接并订阅 6,236 个 Token，扫描无限流、瞬态错误或断线，随后产生 TEST 模拟持仓，账本验证继续为 `passed=true`、SQLite `ok`。

## 尚未完成

- 累计 72 小时正式长期 TEST 正在执行；尚未完成首个 4 小时片段的用户决定、后续累计与最终审计。
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
