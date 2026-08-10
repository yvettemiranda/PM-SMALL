# 正式 TEST 交易审计（2026-08-10）

## 审计范围

- 起点：旧正式活动 `formal-test-20260808T081226Z` 的准确启动时间 `2026-08-08T08:12:27.448Z`。
- 账本：服务器 `/home/ubuntu/pm-small/data/paper.db`，Schema 15，只读查询。
- 盈亏快照：`2026-08-10T05:48:53Z`（Asia/Shanghai 13:48:53）。
- 安全状态：`TEST + LIVE_DISABLED + RUNNING`；即时验证通过、SQLite `ok`。

## 总览

- 买入：79 个 FAK BUY 订单、135 个价格档 Fill，覆盖 46 个 Event / 47 个 Token 仓位。
- 实际买入现金投入：`42.128780U`。
- 买入毛份额 `2,271.000000`，费用按份额扣除后实际获得 `2,164.895831` 份；买入费用价值口径 `1.954905U`，不是额外现金支出。
- 卖出：27 个目标 SELL 订单发生 30 个 Fill，覆盖 13 个 Event，共卖出 `339.276282` 份。
- 卖出毛回款 `13.393222U`，卖出费用 `0.592910U`，净回款 `12.800312U`。
- 资金守恒：`100.000000 - 42.128780 + 12.800312 + 0.000000 = 70.671532U` 可用现金，与账本完全一致。
- 当前 42 个未平仓 Token 仓位成本 `34.537746U`，实时可卖价值 `16.171550U`。
- 已实现盈亏 `+5.209278U`，未实现盈亏 `-18.366196U`，总盈亏 `-13.156918U`，总资金 `86.843082U`。

## 已完整闭环：4 个目标卖出 + 1 个结算

| 闭环方式 | Event / 具体市场 | 买入成本 | 净回款/结算 | 已实现盈亏 |
| --- | --- | ---: | ---: | ---: |
| 目标卖出 | How many Emmys will “The Pitt” win? / 0 or 1 awards（YES） | 1.000000U | 1.412645U | +0.412645U |
| 目标卖出 | Best AI model on August 24? / claude-opus-4-6-thinking（YES） | 0.210000U | 0.323636U | +0.113636U |
| 目标卖出 | White House # posts Aug 11–18 / 140–159（YES） | 1.000000U | 1.357314U | +0.357314U |
| 目标卖出 | ISM Services PMI Aug 2026 / 56.0–56.9（YES） | 0.210000U | 0.379648U | +0.169648U |
| 市场结算 | Kai and Speed Minecraft marathon deaths / 10–29（YES） | 1.000000U | 0.000000U | -1.000000U |

完整闭环合计投入 `3.420000U`、收回 `3.473243U`，净已实现 `+0.053243U`。其中 4 个目标卖出闭环盈利 `+1.053243U`，一个结算失败亏损 `-1.000000U`。

## 已部分卖出、仍有仓位：9 个

| Event / 具体市场 | 已卖份额 | 净回款 | 已实现盈亏 | 剩余成本 |
| --- | ---: | ---: | ---: | ---: |
| SC St. Tönis vs Eintracht Frankfurt / 3–0（YES） | 6.880000 | 0.130857U | +0.058475U | 0.927618U |
| GPU rental prices H200 end 2026 / 6.50–7.00（YES） | 25.929083 | 2.474462U | +1.820282U | 0.336220U |
| JOLTS Job Openings July / 7.6M–7.7M（YES） | 60.593133 | 1.440978U | +0.484996U | 0.043918U |
| US jobs added August / 100k–150k（YES） | 37.564500 | 1.430455U | +0.581060U | 0.150605U |
| Mecklenburg-Vorpommern SPD seats / fewer than 18（YES） | 10.000000 | 0.964000U | +0.695637U | 0.731537U |
| How many Emmys will “DTF St. Louis” win? / 2 or 3（YES） | 43.350666 | 0.976607U | +0.322645U | 0.345958U |
| Germany GDP growth Q3 / 0.1%–0.3%（YES） | 9.860000 | 0.761960U | +0.630362U | 0.866942U |
| RBA September / cut 25 bps（YES） | 18.180000 | 0.570932U | +0.374170U | 0.803178U |
| GPU rental prices A100 end September / 0.50–0.75（YES） | 14.630000 | 0.576818U | +0.188408U | 0.569390U |

这 9 个仓位已实现盈利合计 `+5.156035U`，但剩余成本 `4.775366U` 尚未闭环，不能把这些市场称为完整盈利交易。

## 已买入但尚未卖出：33 个 Token 仓位

| Event / 具体市场 | 当前成本 |
| --- | ---: |
| Taylor & Travis divorce in 2026?（YES） | 0.999840U |
| Fed Decision in December / hike 50+ bps（YES） | 0.999900U |
| Clacton by-election margin / Count Binface wins（YES） | 0.999940U |
| Emmys “Widow's Bay” / 8 or 9 awards（YES） | 0.999820U |
| South Korea GDP Q3 / below 2.0%（YES） | 0.969600U |
| ISM Manufacturing PMI August / below 51.0（YES） | 0.999900U |
| Bank of Japan October / hike 50+ bps（YES） | 0.999900U |
| UMich Consumer Sentiment August / at least 64.0（YES） | 0.999810U |
| Elon Musk posts Aug 11–18 / 300–319（YES） | 0.999860U |
| August unemployment / 3.9%（YES） | 0.999850U |
| Emmys “Hacks” / 0 or 1 awards（YES） | 0.999900U |
| Clacton Nigel Farage vote / 40–50%（YES） | 1.000000U |
| CZ posts Aug 11–18 / 60–79（YES） | 0.999960U |
| Eurozone GDP Q3 / at least 2.0%（YES） | 0.970000U |
| Anthropic valuation end August / below 500B（YES） | 0.300000U |
| AfD wins most seats in 0 September state elections（YES） | 0.999990U |
| Canada GDP June MoM / below 0.0%（YES） | 0.999820U |
| Bank of England November / hike 50+ bps（YES） | 0.999930U |
| NVIDIA Q2 adjusted gross margin / 78%+（YES） | 1.000000U |
| Pau FC vs AS Nancy / exact 3–3（YES） | 1.000000U |
| OpenAI valuation end August / 700B–800B（YES） | 1.000000U |
| OpenAI valuation end September / 600B–700B（YES） | 1.000000U |
| Best AI model Aug 24 / qwen3.8-max（YES） | 0.454200U |
| Khamenei posts Aug 11–18 / 30–34（YES） | 1.000000U |
| Emmys “Beef” / 4 or 5 awards（YES） | 0.999810U |
| Private company valuation growth / Stripe（YES） | 0.050000U |
| RBNZ October / hike 50+ bps（YES） | 0.999800U |
| Donald Trump Truth Social posts Aug 11–18 / 60–79（YES） | 0.999800U |
| Bank of Brazil November / hike 50+ bps（YES） | 0.999900U |
| Ted Cruz posts Aug 11–18 / 60–79（YES） | 0.999720U |
| Mecklenburg-Vorpommern AfD seats / 20–23（YES） | 0.999900U |
| TSV SCHOTT Mainz vs Borussia Mönchengladbach / Mainz wins（YES） | 0.999900U |
| Michigan Democratic Senate primary loser endorses winner（NO） | 0.021330U |

这 33 个从未卖出的仓位成本合计 `29.762380U`。

## 运行中发现的卖出碎片问题

- 当前 113 个活动目标卖单中，25 个目标单的剩余份额低于该市场 `5` 份最小下单量。
- 有 2 个 Token 的所有目标单都低于最小量，但合并后的总仓位高于最小量：Canada GDP June 和 GPU H200。
- Canada GDP June 是已证实的当前阻塞案例：持仓 `37.337455` 份，8 个目标单各 `3.396115–4.917960` 份，目标价 `3.8–3.9¢`；审计期间 Best Bid 从 `13.1¢` 升至 `13.7¢`，公开盘口抽样在目标价以上有 `59.45` 份深度，但系统仍未卖出。
- 原因已定位到当前执行语义：`executeTestFakSells()` 对每个 target 独立调用 `planFakSell()`，而 `planFakSell()` 会拒绝小于最小下单量的单个 target；这些可合并的碎片没有先聚合。
- 这不是 LIVE 风险，当前没有真实资金；但它会让部分 TEST 仓位不能按本应可成交的盘口退出，并影响长期闭环验证。审计时未擅自暂停或修改运行中的 TEST。
