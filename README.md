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

- 遍历 Polymarket 全部开放事件分页，再筛选具体市场；不设本地市场或 Token 数量上限。
- 市场必须开放、未关闭/归档、允许下单、启用订单簿并具有 Condition ID。
- 具体市场总时长固定至少 1 天，上限由滑杆选择；默认 30 天即 `1 天 <= 总时长 <= 30 天`。剩余时间不参与筛选，生命周期进度只用于展示和排序。
- 支持二元/三元和类别多选；没有历史成交量硬过滤。
- 所有结构合格 Token 进入实时监控。Best Ask 大于 0 且不超过 1–3¢ 配置，并满足最小下单量时，按实时订单簿执行 FAK 买入。
- 买入可部分成交，剩余立即取消。每笔填充创建 `max(买价+1¢, 买价×1.5)`、按 tick 向上取整的目标卖出价。
- Best Bid 达标后立即按 FAK 卖出；买入完成时也会在同一盘口立即复查。部分卖出继续等待，首次卖出后本轮停止新买。
- 完整卖出且市场仍开放、未结算时自动开始下一轮；没有手动“新一轮”入口。
- 市场正式关闭并确认结果后，自动完成 TEST 结算和模拟赎回。
- 买卖使用动态费用，资金和盈亏按净额计算；明确没有买盘时持仓可实现估值为 0。

## UI

- 手机优先、桌面与手机共用单列页面，至少支持 320px；
- 左上角 `TEST / LIVE`，LIVE 锁定；
- 默认只展示资金盈亏、当前持仓和扫描市场，配置按需展开；
- 配置包括类别、二元/三元、最高买价、总时长、总模拟资金和每轮金额；
- 符合配置的市场全部自动参与，不提供逐 Token 勾选；
- 扫描市场默认显示 20 项，可展开，支持生命周期进度正序/倒序；
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

操作与停止条件见 [`docs/PAPER_SOAK.md`](docs/PAPER_SOAK.md)。正式长期验证计划由用户制定，未经确认不得自行开始。

## 安全边界

- 当前公开模式只有 TEST；内部 `paper_*` 表名是历史兼容实现；
- 不读取或保存私钥、助记词、钱包或交易凭据；
- `.env`、`data/`、SQLite、备份和日志不得提交 Git；
- 数据不完整时保守等待，不推定成交或结算；
- 完成长时间 TEST 验证前不得接入钱包或启用 LIVE。
