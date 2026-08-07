# Progress

## 当前任务

- 用户已授权按附件正式规格，把 PM-SMALL 从“二元/三元 Token 轮次”升级为“任意标准多元 Event 仲裁 + Event 轮次锁”，并在自动验证通过后同步 GitHub `main` 与 Linux 服务器。
- 固定实现基线与远端 `main` 均为 `7a02b06f4b19b70c4057177ebd0bf9bfb9e1ff84`；当前改动尚未提交或部署。
- 交付边界固定为 `TEST + LIVE_DISABLED + PAUSED`；只执行自动测试和 PAUSED 冒烟，不启动正式长期 TEST、不接钱包、不开发或启用 LIVE。

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

## 当前停止点

- 核心实现、自动验证、PAUSED UI 验收与逐条 Standards / Spec 复审均已完成；双轴复审为 0 个待修问题，远端 `main` 仍与固定基线一致。尚未提交 GitHub，服务器仍保持原版本与 `PAUSED`。

## 后续步骤

1. 提交并推送 GitHub `main`，核对远端 SHA；服务器部署前先暂停核验、备份配置与 SQLite、校验哈希和数据库完整性。
2. 服务器只部署同一 SHA 与 Schema 15，验证账本守恒、`TEST + LIVE_DISABLED + PAUSED`、容器/端口/HTTPS；不启动正式长期 TEST。
