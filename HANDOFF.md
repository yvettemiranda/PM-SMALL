# 项目交接记录

更新时间：2026-08-11

## 当前有效结论

PM-SMALL 当前交付目标是 Schema 16 的 `TEST + LIVE_DISABLED` 自动交易闭环。标准 Event 支持安全整数 `resultCount >= 2`，以 Token/Market 承载盘口、成交、仓位和 Condition 结算，以 Event 承载候选仲裁、每轮预算和互斥锁；增强型负风险 Event 继续排除。

本轮有效代码包括：可配置 `0.1¢–99¢` 买价闭区间、可配置目标卖价参数 `A/B`、紧凑单列 UI、五项资金摘要、默认折叠的真实交易记录，以及相应的 Schema 16 迁移、API、执行接线和回归。交易记录按真实成交批次而不是毫秒时间戳归组，因此同一卖单在同一毫秒内连续部分成交和最终成交不会被误合并；同一批次跨多个价位的 Fill 仍合并为一条。

本轮本地验证为 32 个测试文件、309 项测试全部通过；TypeScript 类型检查、生产构建、前端语法、正式 TEST 包装脚本语法和差异检查通过。GitHub 与服务器的最终状态不得仅凭本文件推断，交接时必须实时核对 `origin/main`、服务器 `git rev-parse HEAD`、Schema、状态端点和正式活动证据。

任何 2026-08-11 已被用户宣布作废的策略研究、Core/Runner、回本规则、OBSERVE 或 TEST/LIVE 新接缝均不属于当前需求，不得重新引用、推荐或带回实现。当前发布只交付已经确认的价格、UI、交易记录和可靠性修复。

## 不可越过的边界

- 当前只允许 `TEST + LIVE_DISABLED`；内部 `paper_*` 命名是兼容实现，不代表存在可切换的实盘路径。
- 不接钱包、不读取或保存私钥/助记词、不签名、不提交真实订单、不执行链上写操作。
- 实现、测试、部署或启动 TEST 都不构成 LIVE 授权。钱包与 LIVE 必须等正式 TEST 验收完成后由用户重新明确授权。
- 数据、盘口、费用、身份或正式结果不完整时失败关闭；账本验证失败时暂停增仓并保留现场，已有目标卖出仍可减仓。
- 本轮用户只授权在完成备份、迁移、重置和验证后启动一个全新的 TEST；该授权不得扩展到未来恢复旧活动、改策略或启用 LIVE。

## 当前扫描与执行规则

1. 流式遍历全部开放 Event 分页，不使用事件日期窗口或本地 Event/Market/Token 数量上限。
2. Event 与具体 Market 必须明确开放；Market 还须允许下单、启用订单簿、具有 Condition ID、费用状态明确，并满足市场时间、体育开赛时间和官方栏目设置。
3. 市场类型为 `BINARY`、`TERNARY`、`MULTI`（4+）；默认和重置只启用二元/三元，多元须由用户主动开启。
4. 买价是可配置闭区间，最低和最高均可在 `0.1¢–99¢` 内按 `0.1¢` 调整；还必须有新鲜完整盘口、有效 Best Bid、达到配置的 Bid/Ask 比例、合法 tick 和最小下单量。
5. 未锁 Event 只有全部静态合格兄弟 Token 都取得新鲜完整盘口后才执行无副作用 FAK Preview 和确定性仲裁；执行前必须用最新盘口、配置、现金和锁状态重算。
6. TEST 按 Best Ask 执行 FAK 买入，未成交余量取消。第一次实际 Fill 与 Event Lock、订单、Fill、仓位、目标卖单、现金和盘口消费在同一 SQLite 事务提交。
7. 每笔新 Fill 的目标卖价为 `min(99¢, tick↑ max(实际买入成交价+A, 实际买入成交价×B))`；默认 `A=1¢`、`B=1.5`，配置只影响后续新 Fill，不追溯改写已有目标卖单。
8. Best Bid 达标后立即按 FAK 从高到低卖出；允许部分成交。同一 Token 的小额目标可按稳定顺序聚合到市场最小下单量，批次限价取所含目标中的最高价。
9. 首次实际卖出后整个 Event 停止新买；仓位清零且没有活动卖单时原子释放 Event Lock，仍开放的 Event 可在下一轮重新仲裁。
10. 具体 Condition 正式关闭且官方结果明确后自动 TEST 结算和模拟赎回；不确定结果继续等待。

## 配置、重置与数据库

- Schema 16 为 preferences 增加最低买价、目标加价和目标倍数，并将最高买价上限放宽到 `99¢`。迁移保留原最高买价和已有 SELL targets，新增最低价 `0.1¢`、默认 `+1¢ / ×1.5`，同时强制 `PAUSED` 并取消仍活动的 BUY。
- 配置保存影响后续新买和新 Fill；若旧活动 BUY 因新配置失去资格，配置与撤单在同一事务提交。
- TEST 重置只能在 `PAUSED` 执行，并要求两次精确确认。重置默认值固定为：100U、每 Event 每轮 1U、二元/三元开启、多元关闭、全栏目、进度正序、`0.1¢–99¢`、`+1¢ / ×1.5`、Bid/Ask 50%、生命周期 20%、总时长 1–30 天。
- 重置默认值是产品规则，不继承服务器旧 `.env`。因此旧环境即使仍写着 1–3¢ 或其他启动值，也不能改变重置后的新 TEST 基线。
- 旧 TEST 账本会影响新基线、资金、持仓和交易记录，不能留在活动数据库中继续启动“全新 TEST”。发布流程必须先建立可恢复且通过哈希、SQLite 完整性和计数核验的备份，再用正式重置接口清空活动 TEST 数据；旧活动目录和备份证据继续保留，不把旧累计小时自动并入新活动。
- 多语句迁移与 schema version 登记必须在同一 SQLite 事务中完成；迁移前后及同库重启后都要核对资金、订单、Fill、仓位、结算、Event Lock、盘口消费与账本验证。

## API 与 UI

- 顶部使用单按钮切换 TEST/LIVE 视图；LIVE 始终锁定，运行按钮为 `START/PAUSE`。
- 资金摘要依次为总资金、已实现、未实现、持仓价值、单数。
- 页面顺序为配置、资金摘要、当前持仓、交易记录、扫描事件。持仓与扫描卡片使用紧凑布局；扫描排序按钮只显示箭头。
- 交易记录默认折叠，点击整行展开/收起，按时间倒序展示真实 TEST 账本中的开仓、加仓、部分平仓、已平仓和结算；首次展开才读取，展开后增量刷新，迟到回填会触发安全重建。
- 配置页市场类别使用紧凑标签网格；目标公式保持单行；市场总时长的最短/最长输入同排。
- 主要公开接口包括 `GET /api/dashboard`、`GET /api/test/preferences`、`PUT /api/test/preferences`、`GET /api/test/trade-records`、`POST /api/test/reset`、`POST /api/test/start` 和 `POST /api/test/pause`。

## 发布与新 TEST 的验收顺序

1. 本地全量测试、类型、构建、前端/Bash 语法、差异检查和 Standards/Spec 双轴复审全部通过，并形成只包含任务范围文件的本地提交。
2. 推送 GitHub `main` 并重新 fetch，确认远端 SHA 与本地一致。
3. 在任何服务器写操作前只读核对当前代码、活动、容器、Schema、策略、配置、账本计数和验证状态，保持或切换到 `PAUSED`。
4. 停止业务容器，备份 `data/`、`.env` 和 `docker-compose.yml`，核对 SHA-256；在可写临时副本中验证 SQLite `integrity_check=ok`、Schema 和账本计数。
5. 服务器只使用 `git pull --ff-only origin main`，构建并启动同一提交；验证 Schema 16、`TEST + LIVE_DISABLED + PAUSED`、账本、端口、HTTPS/认证和同库重启。
6. 保留上述备份后，用双重确认重置活动 TEST；确认 100U、固定默认配置和所有订单/Fill/仓位/结算/Event Lock/盘口消费为 0。
7. 以当前 SHA 准备独立监控镜像，再按用户本轮授权启动一个新的正式 TEST 活动；至少取得首个有效样本，并确认策略 `RUNNING`、监控重启 0、账本/SQLite 正常、LIVE 仍禁用。

公网入口为 `https://43-159-133-129.sslip.io/`。应用 3000 只允许绑定 `127.0.0.1`，公网只经 Nginx 80/443、HTTPS 与登录认证访问。当前动态活动 ID、服务器 SHA 和运行状态以服务器 `formal-test-current`、状态接口与留证目录为准。

## 尚未完成的长期事项

- 新正式 TEST 的约定时长、分段决定、资源/限流/断线验收和最终账本审计。
- 动态费用与未来真实成交的逐微单位对齐验证。
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

继续前依次阅读本文件、`docs/DECISIONS.md`、`docs/PLAN.md`、`SECURITY.md` 和 `docs/SERVER_DEPLOY.md`。任何历史方案与当前决定冲突时，以用户最新明确边界、GitHub `main` 和 `docs/DECISIONS.md` 为准。
