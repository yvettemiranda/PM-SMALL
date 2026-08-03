# PM-SMALL

Polymarket低价合约自动挂单交易机器人，全新独立项目。

> 当前版本：`v0.2.0`纸面实时成交版。仅支持PAPER模式，尚未完成完整纸面交易闭环，不能连接钱包、提交真实订单或执行链上赎回。

## 交接入口

更换电脑、账号或开发人员时，按以下顺序阅读：

1. [`HANDOFF.md`](HANDOFF.md)：当前进度、验证结果和下一步；
2. [`docs/DECISIONS.md`](docs/DECISIONS.md)：已确认且不得擅自改变的规则；
3. [`docs/PLAN.md`](docs/PLAN.md)：开发阶段和完成标准；
4. [`docs/polymarket_bot_final_closed_loop_plan_v1_3.md`](docs/polymarket_bot_final_closed_loop_plan_v1_3.md)：完整方案。

## 环境

- Node.js 24或更高版本；
- npm 11或更高版本；
- macOS或Linux；Windows建议使用Docker运行。

## 本地启动

```bash
cp .env.example .env
npm ci
npm run dev
```

打开 `http://localhost:3000`。

## Docker启动

```bash
cp .env.example .env
docker compose up --build
```

## 验证

```bash
npm run typecheck
npm test
npm run build
```

## 当前已实现

- 公开市场数据适配与候选市场扫描；
- 2至3个明确结果的事件过滤；
- 1至3美分Maker买价和单笔1U预算规则；
- SQLite纸面订单、成交、持仓和审计基础；
- 保守队列成交模型；
- 公开市场WebSocket订阅、断线重连和快照恢复；
- 实时成交驱动的纸面部分成交与去重；
- 买入成交后自动创建固定价格纸面卖单；
- 首次卖出成交后撤销剩余纸面买单并停止该轮新买；
- 基础网页界面和状态接口；
- 固定禁用的实盘执行器。

## 当前未实现

- 候选市场自动建立纸面买单；
- 体育比赛开始后的在途买单处理；
- 结算、纸面赎回和完整重启恢复；
- 钱包签名、实盘下单、撤单和链上赎回。

## 安全边界

- 默认且仅允许PAPER模式；
- 不读取或保存私钥、助记词、钱包及交易API凭证；
- `.env`、`data/`、数据库和日志不得提交；
- 所有时间统一保存为UTC。

详细要求见 [`SECURITY.md`](SECURITY.md)。
