# Progress

## 当前任务

- 用户明确授权清理不影响运行的旧数据和备份，并说明正式验证尚未开始、此前数据不再重要。
- 清理边界固定为：保留当前数据库、运行镜像、活动日志和最新已验证 Schema 15 回滚备份；删除其余旧部署/迁移备份并清理未使用 Docker 构建缓存。
- 不启动正式 TEST，不修改账本、配置或运行代码，最终仍保持 `TEST + LIVE_DISABLED + PAUSED`。

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
- 当前最近一次全量自动化结果为 29 个文件、279 项全部通过；TypeScript 类型检查、生产构建、前端语法和差异检查同时通过，未启动 TEST 交易。
- 已在临时空数据库和 `PAUSED + LIVE_DISABLED` 下完成 462px/320px UI 冒烟：无横向溢出、无控制台错误；14 个首页栏目默认全选、多元默认关闭、7–30 天自由区间和 Event 周期文案均通过，未点击“开始TEST”。
- 服务器 PAUSED 发现层完整遍历 182 页、18,103 个 Event，3,192/3,192 本参与盘口完整且行情连接正常；0 个最终候选由结果数、生命周期、Ask 上限、总时长、缺 Ask 和 Bid/Ask 比例硬筛选造成，不是扫描中断或代码报错。
- 已以红绿测试修复 Preview 共享 Bid 深度重复计算：按 target 顺序复用 `planFakSell()` 并扣减 mutable Bids；完全共享和三 target 场景均与真实 `executeTestFakSells()` 的实际退出量一致。
- UI 买入费用说明已改为份额扣费口径；聚焦 31 项、全量 29 文件/279 项、typecheck、build、前端语法和差异检查全部通过。本机默认 PATH 无 `npm`，已使用工作区自带 Node 24.14.0 与本地项目二进制完成验证。
- 运行提交 `4f4f12e9eb91ef2e002906e7765a0fb6d8318a6c` 已部署服务器；新备份 `/home/ubuntu/pm-small-backup-20260808T012255Z` 通过 SHA-256、隔离 SQLite、Schema 15 和空账本计数校验，同库重启、公网 HTTPS/认证、Nginx、监听边界及新 UI 文案均通过。
- 首次备份命名守卫因时间戳位数表达式过严而在停服务前安全退出；首次镜像 ID 记录误读已移除的旧镜像后，失败恢复钩子自动启动旧容器。两次均未改数据库，修正检查命令后完整发布通过。
- 清理前盘点 7 个部署备份约 75MB、旧迁移备份约 6.3MB，Docker 构建缓存 1.921GB（可回收 1.352GB）；所有旧备份哈希不同，但用户明确放弃此前数据。
- 删除前重新验证保留备份 `/home/ubuntu/pm-small-backup-20260808T012255Z`：SHA-256、隔离 SQLite `integrity_check=ok`、Schema 15、PAUSED、100U 空账本及 0 订单/Fill/持仓/结算/Event 锁全部通过。
- 已永久删除其余 6 个旧部署备份和旧迁移备份目录，释放 `71,165,976` 字节；已清理 1.352GB 未使用 Docker 构建缓存。磁盘占用从 8.1GB/18% 降至 6.9GB/15%，空闲增至 41GB。

## 当前停止点

- 实现、本地自动验证及 Standards/Spec 双轴审查均已完成，两个审查均为 0 项发现；真实 SELL、Event Arbitration、Lock、ResultCount/Multi、Settlement、Validation、资金与 Buy Fee 路径均未改。
- 精度修复提交 `4f4f12e9eb91ef2e002906e7765a0fb6d8318a6c` 已推送 GitHub `main`，本地与 `origin/main` 已回读为 `0/0`。
- 服务器已部署同一运行提交并完成备份、同库重启、账本/SQLite、容器、端口、HTTPS/认证和 UI 文案验证；最终仍为 `TEST + LIVE_DISABLED + PAUSED`，没有调用启动接口。
- 部署证据已提交 GitHub；服务器仓库仅快进最终纯文档提交，运行镜像继续保持已验证的 `4f4f12e9eb91ef2e002906e7765a0fb6d8318a6c`，无需再次重建或重启。
- 服务器清理后仅保留最新验证备份；当前数据库、运行镜像、活动日志、公网 HTTPS 与验证状态均复核通过。

## 后续步骤

1. 保持 PAUSED，等待用户共同制定并确认正式长期 TEST 验证计划；未经确认不执行。
2. 正式长期 TEST 前核对此前异常 RUNNING 的触发来源；钱包和 LIVE 仍不在当前授权范围内。
