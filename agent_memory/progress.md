# Progress

## 当前任务

- 用户已确认正式 TEST 验证方案，并要求实现服务器侧自主运行的累计 72 小时任务。
- 每 4 小时自动生成节点，配置变化额外切段；每段先待用户决定是否计入，只有合格且被用户确认计入的时长累计到 72 小时。
- 实现启动、状态、计入/排除、停止与中文报告工具；可并行的只读监测并行执行，不启动第二套会污染限流/资源基线的全市场扫描。
- 当前只实现、测试并部署工具，未经用户另行发出开始指令不得调用 TEST 启动接口；最终仍保持 `TEST + LIVE_DISABLED + PAUSED`。

## 已完成

- 已实现正式 TEST 累计管理核心与 CLI：72 小时目标、4 小时节点、配置更新时间切段、用户计入/排除、硬失败拒绝、采样有效率/覆盖率门槛、状态报告、停止和信号暂停。
- 已实现独立服务器包装工具：准备监控镜像、启动前安全检查与停机基线备份、SQLite/哈希复核、单监控容器、重启强制 PAUSED、状态/决定/停止命令；当前未执行 start。
- 正式 TEST 工具源码提交 `a2b404e69f0b2da22c7a8261d125db30dc223bab` 已推送 GitHub `main` 并同步服务器；服务器已构建独立镜像 `pm-small-formal-test:a2b404e69f0b`，没有创建活动或运行监控容器。
- 新增 3 个测试文件并完成全量 32 文件/292 项、typecheck、build、前端语法、Bash 语法和差异检查；正式运行手册、README、计划、决定和交接已同步。
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

- 正式 TEST 工具实现、本地自动验证及 Standards/Spec 双轴审查均已完成，两个审查均为 0 项发现；正式工具提交 `a2b404e69f0b2da22c7a8261d125db30dc223bab` 已推送并在服务器完成独立镜像准备。
- 准备前后业务容器均为同一镜像 `sha256:bceed0db82de8bfb0e2521bc36f2e2b60554ef705de2b51e1dc42604b22dfb95`，容器保持 `running healthy`，没有重建或重启业务机器人。
- 服务器最终复核为 `TEST + LIVE_DISABLED + PAUSED`、100U 初始/可用资金、空订单/持仓/待结算、SQLite `ok`；监控容器为空且不存在 `formal-test-current`，确认没有启动正式 TEST。
- 服务器清理后仍只保留最新验证备份 `/home/ubuntu/pm-small-backup-20260808T012255Z`；本轮准备没有生成新的基线备份，因为正式活动尚未开始。

## 后续步骤

1. 用户另行发出开始指令后，先再次执行安全前检、创建经校验的正式基线备份，再启动累计 72 小时 TEST 与独立监控。
2. 实际开始时创建 4 小时 Codex 提醒；每个 4 小时或配置变化片段均先向用户报告，由用户明确决定计入或排除。钱包和 LIVE 仍不在当前授权范围内。
