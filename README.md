# PM-SMALL

Polymarket低价合约自动挂单交易机器人，全新独立项目。

> 当前版本：`v0.4.0`纸面结算闭环版，`v0.5.0`长期验证开发中。仅支持PAPER模式，钱包、真实订单和链上操作仍然禁用。

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

长期PAPER留证工具见[`docs/PAPER_SOAK.md`](docs/PAPER_SOAK.md)。它只读取本机状态与账本验证接口，证据默认写入不受Git跟踪的`data/validation/`。

## 当前已实现

- 公开市场数据适配与候选市场扫描；
- 按市场总时长构造不漏候选的时间窗口，遍历窗口内开放事件的全部分页，不以固定 Token 数量截断扫描；
- 2至3个明确结果的事件过滤；
- 1至3美分Maker买价和单笔1U预算规则；
- SQLite纸面订单、成交、持仓和审计基础；
- 保守队列成交模型；
- 公开市场WebSocket订阅显式请求初始盘口，保留心跳失效重连和快照恢复；
- 实时成交驱动的纸面部分成交与去重；
- 买入成交后自动创建固定价格纸面卖单；
- 首次卖出成交后撤销剩余纸面买单并停止该轮新买；
- 策略启动后自动为合格候选Token建立纸面买单；
- 完整盘口就绪前禁止自动买入；
- 体育比赛开始后撤销未成交纸面买单并禁止重新挂买；
- 市场进度达到90%后撤销买单未成交部分并停止新买；
- 暂停或停止时撤销买单未成交部分，持仓及卖单继续管理；
- 重启后核对资金、活动订单、持仓和卖单覆盖关系，异常时自动暂停；
- 只接受市场关闭且正式结算状态为`resolved`或`settled`的结果；
- 自动取消结算市场的活动纸面订单；
- 模拟获胜Token赎回、失败Token归零和结算资产回收；
- 支持二元胜负及官方`50/50`结果的按比例纸面回收；
- 结算按Condition ID幂等处理，记录检查、回收、收益和恢复审计；
- 默认每60秒只读核对SQLite、资金守恒、挂单占用、持仓卖单覆盖和结算残留；
- 实时记录全市场扫描阶段、分页/批次数、规模和耗时，并提供JSONL长期PAPER留证运行器；
- 候选扫描可取消，WebSocket关闭等待和进程信号关停具有明确时间边界；
- 一致性失败时保留现场，除卖单继续减仓外冻结自动账本变更，并阻止未修复账本重新启动；
- 提供周期验证状态、轻量`GET /api/status?compact=true`和`GET /api/paper/validation`即时验证接口；
- 提供纸面持仓、结算和赎回状态接口及网页展示；
- 基础网页界面和状态接口；
- 固定禁用的实盘执行器。

## 当前未实现

- 长时间运行、完整故障注入、性能和真实全市场容量验证；
- 钱包签名、实盘下单、撤单和链上赎回。

## 安全边界

- 默认且仅允许PAPER模式；
- 不读取或保存私钥、助记词、钱包及交易API凭证；
- `.env`、`data/`、数据库和日志不得提交；
- 所有时间统一保存为UTC。

详细要求见 [`SECURITY.md`](SECURITY.md)。
