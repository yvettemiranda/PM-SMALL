# Progress

## 当前任务

- 用户已确认把旧活动前两个合格片段共 8.00 小时计入 72 小时，并于 2026-08-09 明确授权继续累计；新正式活动 `formal-test-20260809T083806Z` 已启动并由服务器独立运行。
- 首次 `start` 在调用 TEST 启动前因监控证据目录为 `root:root / 0700` 而安全失败；策略与账本保持 PAUSED/健康。目录权限交接已修复并以红绿测试、全量测试、类型检查和构建验证，修复提交 `df01ecf626734e54123383357b11af22f1fe2cda` 已推送并部署，第二次启动成功。
- 用户确认扫描 Event 必须先显示全部可交易项、再显示待定项；正序/倒序只控制两组内部的生命周期进度顺序。
- 排序修改、回归验证、GitHub 与服务器同步均已完成；用户筛选项已读取并作为正式启动配置冻结到活动证据。
- 用户已确认正式 TEST 验证方案，并要求实现服务器侧自主运行的累计 72 小时任务。
- 每 4 小时自动生成节点，配置变化额外切段；每段先待用户决定是否计入，只有合格且被用户确认计入的时长累计到 72 小时。
- 实现启动、状态、计入/排除、停止与中文报告工具；可并行的只读监测并行执行，不启动第二套会污染限流/资源基线的全市场扫描。
- 当前只运行 TEST；`LIVE_DISABLED`、不接钱包、不签名和不提交真实订单的边界不变。
- 用户已确认计入新活动前 5 个合格节点；已执行 `include segment-0001` 至 `include segment-0005`，新活动正式计入 20.00 小时，跨活动累计为 `28.00 / 72.00` 小时。
- 已从旧活动准确启动时刻开始只读审计服务器 Schema 15 账本，逐项核对 BUY/SELL Fill、目标单、持仓、结算、已实现/未实现盈亏与资金守恒；完整结果写入 `agent_memory/trading-audit-2026-08-10.md`。
- 用户已授权暂停、最小修复目标卖单碎片、保留已计入的 28.00 小时并在验证后同步 GitHub/服务器；旧活动已停止，第 6 段约 1.33 小时维持 `PENDING`、未计入。修复部署验收后，新活动 `formal-test-20260810T063329Z` 已恢复运行。
- 已用失败回归复现单个 target 小于平台最小量而同 Token 合计可合法卖出的漏卖；生产实现现按既有 target 顺序聚合到最小量、以批次最高目标价保护全部 target，并由 Preview/Arbitration 与真实 SELL 共用同一深度消费规划器。审查发现的微单位 Fill 反算差异也已用第二个失败回归修复，每条持久化 Fill 现按自身价格/份额/费率精确计算。
- 最终本地验证为聚焦 20 项、全量 32 文件/298 项、typecheck、build、前端语法、Bash 语法与差异检查全部通过；2,000 组确定性 target/bid 分配不变量检查通过，Standards/Spec 双轴复核在修正两项发现后均为 0 findings。
- 运行提交 `805145c4c3798e43db15c460c5d5fff38b850965` 已推送 GitHub `main` 并部署；部署备份 `/home/ubuntu/pm-small-backup-20260810T062528Z` 的哈希、隔离 SQLite、Schema 15 和账本计数均通过，同库重启没有重复 Fill。
- 修复在服务器旧账本上产生预期退出证据：Canada GDP June 的 8 个碎片 target 合计卖出 37.337455 份、净回款 4.175610U、已实现盈利 3.175790U，仓位归零且 Event Lock 释放；公开入口与 PAUSED/RUNNING 两种状态均验收通过。
- 新活动基线 `/home/ubuntu/pm-small-formal-test-baseline-20260810T063325Z` 已建立；连续两次 60 秒样本正常，监控 `running=true / restarts=0`，策略为 `TEST + LIVE_DISABLED + RUNNING`。

## 已完成

- 已创建并启动正式 TEST 活动 `formal-test-20260808T081226Z`：启动前基线 `/home/ubuntu/pm-small-formal-test-baseline-20260808T081222Z` 的 SHA-256 全部通过，证据目录所有权与镜像运行用户一致；首次运行阶段监控重启 0、行情连接正常并订阅 6,236 个 Token，扫描、盘口、仲裁与模拟执行链路均产生真实 TEST 证据。
- 用户明确不需要 Codex 自动提醒；未创建后台自动任务。以后用户回到当前任务询问时，再按需连接服务器读取活动状态。
- 修复提交 `52fa4cbabdf237b624264fab7a7df31d9c060f5b` 已推送 GitHub `main` 并部署；部署备份 `/home/ubuntu/pm-small-backup-20260809T082316Z` 的 SHA-256、SQLite `integrity_check=ok`、Schema 15 与 PAUSED 状态已复核。
- 新业务镜像及同库重启均通过即时验证；新监控镜像 `pm-small-formal-test:52fa4cbabdf2` 的独立服务器冒烟保持 `running=true / restarts=0`，临时环境已清理。公网 HTTPS、认证、TEST/PAUSED/LIVE 禁用和验证脚本全部通过。
- 启动前发现先前准备的监控镜像已不在 Docker 本地缓存；无 `sudo` 的首次 `prepare` 因 Docker socket 权限在构建前安全退出。随后按服务器既有权限模型重新准备 `pm-small-formal-test:d29a6cc4d483`，应用全程保持 PAUSED，未触碰账本。
- 新活动启动自动创建并复核基线 `/home/ubuntu/pm-small-formal-test-baseline-20260809T083801Z`，证据目录为 `/home/ubuntu/pm-small/data/validation/formal-test-20260809T083806Z`。连续两次 60 秒采样、业务容器、行情连接、即时账本与 SQLite 均正常，监控 `running=true / restarts=0`，策略为 `TEST + LIVE_DISABLED + RUNNING`。

- 已用公开 Dashboard 接口修复扫描 Event 展示排序：`READY` 可交易 Event 固定置顶，正序/倒序只影响可交易组和待定组各自内部；回归同时覆盖默认前 20 项的 ASC/DESC 顺序。
- 本轮聚焦 `app.test.ts` 17 项、全量 32 文件/293 项、typecheck、build、前端语法、正式 TEST 脚本语法和差异检查均通过；Standards/Spec 双轴审查均为 0 项发现。
- 运行提交 `375ec17952a02ccab89c757185fc17119431c0ea` 已推送并部署；新备份 `/home/ubuntu/pm-small-backup-20260808T040744Z`、新镜像 `sha256:e86a4b054cfd9b7930ee8ef9332e76654e9130d2c36d4d7345b03f42096515a4`、容器/公网/验证均通过。实扫 197 个 Event 中 9 个可交易项全部置顶，188 个待定项在后，两组 ASC 正确。
- 已实现正式 TEST 累计管理核心与 CLI：72 小时目标、4 小时节点、配置更新时间切段、用户计入/排除、硬失败拒绝、采样有效率/覆盖率门槛、状态报告、停止和信号暂停。
- 已实现独立服务器包装工具：准备监控镜像、启动前安全检查与停机基线备份、SQLite/哈希复核、单监控容器、重启强制 PAUSED、状态/决定/停止命令。
- 正式 TEST 工具源码提交 `a2b404e69f0b2da22c7a8261d125db30dc223bab` 已推送 GitHub `main` 并同步服务器；服务器已构建对应独立镜像。
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
- 任意标准多元架构阶段的全量自动化结果为 29 个文件、279 项全部通过；TypeScript 类型检查、生产构建、前端语法和差异检查同时通过，当时未启动 TEST 交易。
- 已在临时空数据库和 `PAUSED + LIVE_DISABLED` 下完成 462px/320px UI 冒烟：无横向溢出、无控制台错误；14 个首页栏目默认全选、多元默认关闭、7–30 天自由区间和 Event 周期文案均通过，未点击“开始TEST”。
- 服务器 PAUSED 发现层完整遍历 182 页、18,103 个 Event，3,192/3,192 本参与盘口完整且行情连接正常；0 个最终候选由结果数、生命周期、Ask 上限、总时长、缺 Ask 和 Bid/Ask 比例硬筛选造成，不是扫描中断或代码报错。
- 已以红绿测试修复 Preview 共享 Bid 深度重复计算：按 target 顺序复用 `planFakSell()` 并扣减 mutable Bids；完全共享和三 target 场景均与真实 `executeTestFakSells()` 的实际退出量一致。
- UI 买入费用说明已改为份额扣费口径；聚焦 31 项、全量 29 文件/279 项、typecheck、build、前端语法和差异检查全部通过。本机默认 PATH 无 `npm`，已使用工作区自带 Node 24.14.0 与本地项目二进制完成验证。
- 运行提交 `4f4f12e9eb91ef2e002906e7765a0fb6d8318a6c` 已部署服务器；新备份 `/home/ubuntu/pm-small-backup-20260808T012255Z` 通过 SHA-256、隔离 SQLite、Schema 15 和空账本计数校验，同库重启、公网 HTTPS/认证、Nginx、监听边界及新 UI 文案均通过。
- 首次备份命名守卫因时间戳位数表达式过严而在停服务前安全退出；首次镜像 ID 记录误读已移除的旧镜像后，失败恢复钩子自动启动旧容器。两次均未改数据库，修正检查命令后完整发布通过。
- 清理前盘点 7 个部署备份约 75MB、旧迁移备份约 6.3MB，Docker 构建缓存 1.921GB（可回收 1.352GB）；所有旧备份哈希不同，但用户明确放弃此前数据。
- 删除前重新验证保留备份 `/home/ubuntu/pm-small-backup-20260808T012255Z`：SHA-256、隔离 SQLite `integrity_check=ok`、Schema 15、PAUSED、100U 空账本及 0 订单/Fill/持仓/结算/Event 锁全部通过。
- 已永久删除其余 6 个旧部署备份和旧迁移备份目录，释放 `71,165,976` 字节；已清理 1.352GB 未使用 Docker 构建缓存。磁盘占用从 8.1GB/18% 降至 6.9GB/15%，空闲增至 41GB。

## 当前运行点

- 旧活动已记录 11.33 小时：`segment-0001` 与 `segment-0002` 各 4.00 小时已计入，`segment-0003` 为 3.33 小时 `REJECTED`；旧证据未被改写。新活动前 5 段各 4.00 小时已按用户确认写为 `INCLUDED`，跨活动正式累计为 `28.00 / 72.00` 小时。
- 活动 `formal-test-20260809T083806Z` 已按用户授权安全停止；其 `segment-0006` 约 1.33 小时保持 `PENDING` 且不计入。修复后的新活动 `formal-test-20260810T063329Z` 于 2026-08-10 14:33:29（Asia/Shanghai）启动，跨活动确认累计仍为 `28.00 / 72.00` 小时，新活动后续最多还需由用户确认计入 44.00 小时。
- 五个完整片段均为 240 个样本、有效率和覆盖率 100%、0 关键错误、0 资格失败、0 传输错误、0 限流。警告仅为首样本尚未完成扫描、一次瞬态扫描错误经 1 次重试恢复，以及一次行情完整率短暂降至 98.12% 后恢复；两次 WS 异常断线均恢复。
- 2026-08-10 13:48:53（Asia/Shanghai）交易快照：总资金 86.843082U、总盈亏 -13.156918U（已实现 +5.209278U、未实现 -18.366196U），可用现金 70.671532U，42 个持仓、113 个活动目标单、46 个待结算市场；账本资金守恒与 SQLite 即时验证通过。
- 正式启动以来共有 79 个 FAK BUY 订单/135 个 BUY Fill，覆盖 46 Event / 47 Token，投入 42.128780U；27 个目标 SELL 订单/30 个 SELL Fill 覆盖 13 Event，净回款 12.800312U。4 个目标卖出完整闭环盈利 1.053243U，1 个结算闭环亏损 1.000000U，完整闭环净盈利 0.053243U；另有 9 个部分卖出仓位已实现盈利 5.156035U。
- 审计发现的目标单碎片漏卖已完成最小修复、发布和服务器实证：同 Token 的有序 target 聚合到平台最小量，批次限价取最高 target，成交与费用按稳定顺序分配回原 target；Preview/Arbitration 与真实 SELL 使用相同的共享 Bid 消费语义。
- Event 816196 的审计证明第一轮 Token 已完全卖出并释放 Event Lock，随后兄弟 Token 合法进入新一轮；实际运行符合现行设计。`validatePaperState()` 跨轮关联旧 `first_sell_at` 与新一轮 BUY，造成误报并安全暂停。
- 已以红绿测试修复两处问题：Event 账本验证仅比较当前 ACTIVE Lock Token，本轮真实卖后再买仍失败；supervisor 等待阶段用可清理定时句柄保持 Node 进程存活，收到信号后正常退出。聚焦 39 项、全量 32 文件/295 项、typecheck、build、Bash/前端语法和差异检查均通过；双轴审查的规格轴 0 项，规范轴发现已修正；GitHub 与服务器交付完成。

## 后续步骤

1. 服务器继续自主运行 `formal-test-20260810T063329Z`；每个 4 小时片段完成后保持待决定，用户回来询问时再读取证据并决定是否计入。
2. 跨活动正式累计从 `28.00 / 72.00` 小时继续；旧 `segment-0006` 未经用户决定保持不计入，新活动最多再确认 44.00 小时后受控停止并做最终审计。
3. 钱包和 LIVE 仍不在当前授权范围内。
