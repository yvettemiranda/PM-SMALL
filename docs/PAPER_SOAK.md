# PAPER长期验证运行手册

本工具只读取本机`/api/status?compact=true`和`/api/paper/validation`，按JSONL持续留证。轻量状态只返回候选数量而不传输候选详情；工具不会启动策略、注入故障、修改账本，也不会接触钱包或LIVE。

## 前置条件

1. 使用独立的PAPER数据库启动程序；
2. 确认`executionMode=PAPER`、`liveExecutionEnabled=false`；
3. 需要验证自动交易时，人工调用`POST /api/paper/start`；
4. 确认`data/`未被Git跟踪，验证证据默认写入`data/validation/`。

## 运行

先启动程序：

```bash
npm run dev
curl -X POST http://127.0.0.1:3000/api/paper/start
```

短时工具冒烟：

```bash
npm run paper:soak -- --duration-seconds 300 --interval-seconds 10
```

长期运行示例：

```bash
npm run paper:soak -- --duration-seconds 86400 --interval-seconds 60
```

常用参数：

- `--base-url`：本机程序地址，默认`http://127.0.0.1:3000`；
- `--duration-seconds`：运行时长，默认86400秒；
- `--interval-seconds`：采样间隔，默认60秒；
- `--output`：JSONL证据路径；
- `--max-consecutive-errors`：本机状态接口连续失败多少次后停止，默认3次；
- `--request-timeout-seconds`：单次本机请求超时，默认15秒；
- `--allow-not-running`：仅做停止状态观察时使用；正式运行验收不得使用。

## 证据内容

每个`sample`记录：

- PAPER/LIVE安全状态和策略状态；
- 资金、占用、持仓成本和已实现收益；
- 全市场扫描阶段、事件分页数、事件数、订单簿批次数、合格Token数、候选数和动态耗时；
- WebSocket连接、订阅、完整快照和成交计数；
- 自动买入、撤买、结算和周期验证计数；
- 即时SQLite及账本一致性结果；
- 临时组件告警与必须停止的关键错误。

接口部分失败时会写入`transport_error`；若已返回的安全结果包含关键异常、但另一响应无法形成完整样本，则写入`safety_failure`并立即停止。两类记录都保留具体错误和已确认的关键异常。

最后一行`summary`记录总样本数、告警样本数、本机采样失败数、最大扫描分页/批次/规模/耗时、最大订阅量和最终停止原因。

## 停止条件

出现以下任一情况立即以失败退出：

- 执行模式不是PAPER、LIVE被启用或策略意外离开`RUNNING`；
- 即时或周期账本验证失败、SQLite检查异常或周期验证服务停止；
- 周期验证累计失败次数非零，或整个窗口没有取得任何有效样本；
- 自动运行、结算或市场流服务停止；
- 本机状态采样连续失败达到配置阈值。

两个接口独立保留已返回的安全结果：即使另一个接口超时，已返回的LIVE或账本关键异常仍会在本轮立即判定失败，不会降级成普通重试。

市场扫描、WebSocket或结算接口的暂时错误先记录为告警，用于验证重试和恢复；它们不会被悄悄忽略，也不会单次出现就误判整个长期运行。

扫描尚未完成时，`diagnostics.phase`会显示`EVENTS`或`ORDER_BOOKS`，并持续更新已读取的分页、事件、订单簿批次和耗时；`COMPLETE`才表示本轮全部分页及订单簿处理完成，`FAILED`表示本轮失败。

Market频道订阅会显式请求初始盘口。连接建立后，`dataCompleteTokenCount`应逐步达到`subscribedTokenCount`；长期不增长或持续不足属于容量/恢复告警，不能把`connected=true`单独当成行情就绪。

## v0.5验收边界

- 工具正常结束只表示本次观察窗口完成，不自动把v0.5标记为完成；
- 必须分别保留稳定运行、断线、重启、重复结果、暂时接口失败和数据不一致场景的证据；
- 需要结合JSONL汇总、SQLite复核、资源/速率限制和WebSocket容量结果做最终判断；
- 最终连续运行时长在正式验收前确认，未确认或未跑满时继续保持钱包与LIVE禁用。
