const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

function money(value) {
  return `${Number(value).toFixed(2)}U`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function shortToken(value) {
  const text = String(value);
  return `${escapeHtml(text.slice(0, 8))}…${escapeHtml(text.slice(-6))}`;
}

function showMessage(message, error = false) {
  const element = $("#message");
  element.textContent = message;
  element.className = error ? "error" : "success";
}

function renderStatus(status) {
  const strategy = status.strategy;
  const stream = status.marketStream;
  const streamState = stream.connected
    ? `行情 ${stream.dataCompleteTokenCount}/${stream.subscribedTokenCount}`
    : "行情未连接";
  const automationState = status.paperAutomation.running ? "自动调度" : "调度停止";
  $("#system-state").textContent = `${strategy.status} · PAPER · ${automationState} · ${streamState}`;
  $("#system-state").dataset.status = strategy.status;
  $("#stats").innerHTML = [
    ["可用资金", money(strategy.availableCash)],
    ["挂单占用", money(strategy.reservedCash)],
    ["持仓成本", money(strategy.positionCost)],
    ["已实现收益", money(strategy.realizedPnl)],
  ]
    .map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`)
    .join("");
}

function renderCandidates(snapshot) {
  const body = $("#candidates");
  $("#scan-meta").textContent = snapshot.lastError
    ? `扫描异常：${snapshot.lastError}`
    : snapshot.lastScanAt
      ? `最近扫描：${new Date(snapshot.lastScanAt).toLocaleString()}，共${snapshot.candidates.length}个`
      : "尚未完成扫描";

  body.innerHTML = snapshot.candidates.length
    ? snapshot.candidates
        .map(
          (candidate) => `<tr>
            <td><strong>${escapeHtml(candidate.eventTitle)}</strong><small>${escapeHtml(candidate.marketQuestion)}</small></td>
            <td>${escapeHtml(candidate.direction)}</td>
            <td>${candidate.progressPercent.toFixed(1)}%</td>
            <td>${candidate.bestBid}</td>
            <td>${candidate.makerBuyPrice}</td>
            <td>${candidate.fixedSellPrice}</td>
            <td>${Number(candidate.orderSize).toFixed(2)}</td>
            <td><button class="small" data-buy="${escapeHtml(candidate.candidateId)}">虚拟买入</button></td>
          </tr>`,
        )
        .join("")
    : '<tr><td colspan="8" class="empty">当前没有符合条件的候选Token</td></tr>';
}

function renderOrders(orders) {
  $("#orders").innerHTML = orders.length
    ? orders
        .map(
          (order) => `<tr>
            <td title="${escapeHtml(order.tokenId)}">${shortToken(order.tokenId)}</td>
            <td>${escapeHtml(order.side)}</td>
            <td>${order.price}</td>
            <td>${Number(order.originalSize).toFixed(2)}</td>
            <td>${Number(order.filledSize).toFixed(2)}</td>
            <td>${escapeHtml(order.status)}</td>
          </tr>`,
        )
        .join("")
    : '<tr><td colspan="6" class="empty">暂无测试订单</td></tr>';
}

function renderPositions(positions) {
  const body = $("#positions");
  body.innerHTML = positions.length
    ? positions
        .map(
          (position) => `<tr>
            <td title="${escapeHtml(position.tokenId)}">${shortToken(position.tokenId)}<small>${shortToken(position.conditionId)}</small></td>
            <td>${Number(position.quantity).toFixed(2)}</td>
            <td>${Number(position.cost).toFixed(2)}</td>
            <td>${Number(position.realizedPnl).toFixed(2)}</td>
            <td>${position.cycleClosedAt ? "已关闭" : "持有中"}</td>
          </tr>`,
        )
        .join("")
    : '<tr><td colspan="5" class="empty">暂无纸面持仓</td></tr>';
}

function renderSettlements(settlements) {
  const body = $("#settlements");
  body.innerHTML = settlements.length
    ? settlements
        .map(
          (settlement) => `<tr>
            <td title="${escapeHtml(settlement.conditionId)}">${shortToken(settlement.conditionId)}<small>${escapeHtml(settlement.marketId)}</small></td>
            <td>${escapeHtml(settlement.status)}<small>${escapeHtml(settlement.winningOutcome || "等待正式结果")}</small></td>
            <td>${escapeHtml(settlement.outcome || "-")}</td>
            <td>${Number(settlement.payout).toFixed(2)}</td>
            <td>${Number(settlement.realizedPnl).toFixed(2)}</td>
            <td>${escapeHtml(settlement.redemptionStatus)}</td>
          </tr>`,
        )
        .join("")
    : '<tr><td colspan="6" class="empty">暂无待结算市场</td></tr>';
}

async function loadAll(refresh = false) {
  const [status, candidates, orders, positions, settlements] = await Promise.all([
    api("/api/status"),
    api(`/api/candidates${refresh ? "?refresh=true" : ""}`),
    api("/api/paper/orders"),
    api("/api/paper/positions"),
    api("/api/paper/settlements"),
  ]);
  renderStatus(status);
  renderCandidates(candidates);
  renderOrders(orders.orders);
  renderPositions(positions.positions);
  renderSettlements(settlements.settlements);
}

document.addEventListener("click", async (event) => {
  const action = event.target.dataset.action;
  const candidateId = event.target.dataset.buy;
  try {
    if (action) {
      await api(`/api/paper/${action}`, { method: "POST" });
      showMessage(`策略状态已更新：${action}`);
      await loadAll();
    }
    if (candidateId) {
      await api("/api/paper/orders/buy", {
        method: "POST",
        body: JSON.stringify({ candidateId }),
      });
      showMessage("虚拟买单已创建");
      await loadAll();
    }
  } catch (error) {
    showMessage(error.message, true);
  }
});

$("#refresh").addEventListener("click", async () => {
  try {
    showMessage("正在刷新候选市场");
    await loadAll(true);
    showMessage("候选市场已刷新");
  } catch (error) {
    showMessage(error.message, true);
  }
});

loadAll().catch((error) => showMessage(error.message, true));
setInterval(() => loadAll().catch(() => {}), 10_000);
