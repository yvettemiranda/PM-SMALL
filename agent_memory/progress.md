# Progress

## 当前任务

- 用户要求在当前 `main` 上做最后一次最小范围精度修复：FAK Preview 的 Exit Bid Coverage 必须像真实 `executeTestFakSells()` 一样，让多个 SELL target 顺序消费同一份 mutable Bid 深度；同时修正一处买入费用 UI 文案。
- 固定实现与审查基线为 `69ddc8b3393b576ab076e625a511a64ec843f08d`，本地与 `origin/main` 已核对为 `0/0`、工作树干净。
- 不改 Event Arbitration 排序、Event Lock、ResultCount/Multi、Settlement、Validation、资金模型、Buy Fee 或真实 FAK Sell 执行路径；交付仍固定为 `TEST + LIVE_DISABLED + PAUSED`。

## 已完成

- 已完整阅读附件规格和当前项目上下文，核对市场结构、扫描、候选、FAK、自动化、数据库、迁移、结算、验证、API/UI 与测试接缝。
- 已将 `resultCount` 统一为安全整数 `>=2`，新增 `BINARY / TERNARY / MULTI` 类型模型；旧 binary/ternary 选择保留，multi 默认关闭，增强型负风险 Event 继续排除。
- 已新增无副作用 FAK Preview，并与实际 FAK Buy 共用同一纯规划核心；预演包含持久化盘口消费、资金/冻结预算、逐 Fill 费用与目标、目标 Bid 深度覆盖、净收益率和可成交比例。
- 已新增独立、确定性的 Event Arbitration：依次比较退出就绪度、目标价 Bid 深度覆盖、可成交比例、Bid/Ask、费后目标净收益率、生命周期顺序和稳定身份字段。
- CandidateService 已增加 `tokenId -> eventId` 与 `eventId -> sibling candidates` 索引；行情更新提升为 Event 局部重算，锁定 Event 的兄弟报价不会触发无意义仲裁，定时全量校正仍保留。
- 已新增 Event 完整性门槛：未锁 Event 的全部静态合格兄弟必须有新鲜完整 Book；完整但无有效 Bid/Ask 仅淘汰该 Token；锁定后只要求 active Token 就绪。
- 已新增 Schema 15 与 `paper_event_locks`。首笔实际 Fill、锁、订单、fills、仓位、targets、资金及盘口消费在同一 SQLite 事务提交；0 Fill 不留锁；最终卖清或结算清仓在同一事务释放锁。
- 每 Event 每轮预算在首笔 Fill 时冻结；锁定后只有 active Token 可继续累计，首次实际 Sell 后整个 Event 禁止再买；下一轮释放后可重新选择任意仍开放兄弟 Token。
- Maker 兼容路径也已纳入数据库最终互斥防线；迁移会取消旧活动 BUY、强制 `PAUSED`，单 Token 旧仓迁移为冻结预算的 ACTIVE 锁，多 Token 旧仓迁移为 `LEGACY_CONFLICT` 并只允许减仓/结算。
- `validatePaperState()` 已增加 Event 身份、互斥、锁/仓位/target、首次 Sell 后 BUY、冻结预算、僵尸锁、settled Condition 与 legacy conflict 校验；原订单、fill、position、target coverage 和资金守恒校验保留。
- API 和手机 UI 已增加二元/三元/多元配置，并把扫描主列表升级为 Event 聚合展示；手动买入只能执行最新完整仲裁 Winner，并在执行前再次复核。
- 扫描与自动化诊断已增加 Event 数量、不完整 Event、仲裁/重算、stale 拒绝、锁定兄弟跳过和最大结果数等指标。
- 新增及更新的单元/集成回归覆盖 2/3/4/10/128 结果、augmented 排除、完整性、仲裁各级 tie-break、原子锁、冻结预算、兄弟互斥、退出重仲裁、结算、迁移、恢复和 Event 局部重算。
- 当前最近一次全量自动化结果为 29 个文件、276 项全部通过；TypeScript 类型检查、生产构建、前端语法和差异检查同时通过，未启动 TEST 交易。
- 已在临时空数据库和 `PAUSED + LIVE_DISABLED` 下完成 462px/320px UI 冒烟：无横向溢出、无控制台错误；14 个首页栏目默认全选、多元默认关闭、7–30 天自由区间和 Event 周期文案均通过，未点击“开始TEST”。
- 已创建并校验服务器备份 `/home/ubuntu/pm-small-backup-20260807T161243Z`；Schema 15 迁移、同库重启、账本/SQLite 校验、端口、HTTPS/认证与公网 PAUSED 冒烟全部通过。
- 服务器 PAUSED 发现层完整遍历 182 页、18,103 个 Event，3,192/3,192 本参与盘口完整且行情连接正常；0 个最终候选由结果数、生命周期、Ask 上限、总时长、缺 Ask 和 Bid/Ask 比例硬筛选造成，不是扫描中断或代码报错。
- 部署前服务器实际为 100U 空账本，与旧交接状态不一致；本轮未重置账本、未删除任何旧备份，并将差异保留为后续审计项。
- 已以红绿测试修复 Preview 共享 Bid 深度重复计算：按 target 顺序复用 `planFakSell()` 并扣减 mutable Bids；完全共享和三 target 场景均与真实 `executeTestFakSells()` 的实际退出量一致。
- UI 买入费用说明已改为份额扣费口径；聚焦 31 项、全量 29 文件/279 项、typecheck、build、前端语法和差异检查全部通过。本机默认 PATH 无 `npm`，已使用工作区自带 Node 24.14.0 与本地项目二进制完成验证。

## 当前停止点

- 实现和本地自动验证已完成；真实 SELL、Event Arbitration、Lock、ResultCount/Multi、Settlement、Validation、资金与 Buy Fee 路径均未改，准备进行固定基线双轴审查和发布。

## 后续步骤

1. 以 `69ddc8b3393b576ab076e625a511a64ec843f08d` 为固定点完成 Standards/Spec 双轴审查，处理所有有效发现。
2. 审查通过后提交 GitHub，服务器备份并部署同一 SHA；只做 PAUSED 冒烟，不调用启动接口。
