const $ = (selector) => document.querySelector(selector);

const ui = {
  candidates: [],
  selectedCandidateCount: 0,
  sortDirection: "asc",
  visibleCandidateCount: 20,
  durationOptions: [1, 7, 14, 30, 60, 90, 120, 180, 360, 365],
  preferences: null,
  strategyStatus: "STOPPED",
  configDirty: false,
  messageTimer: null,
  loading: false,
  reloadRequested: false,
  mutationVersion: 0,
  controlPending: false,
  dataRefreshStartedAt: null,
  dataRefreshCompletedAt: null,
  dataRefreshFailed: false,
  scanStatus: null,
  scanObservedStartedAt: null,
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers:
      options.body === undefined
        ? options.headers
        : { "content-type": "application/json", ...options.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || body.message || "请求失败");
  return body;
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

function showMessage(message, error = false) {
  const element = $("#message");
  element.textContent = message;
  element.className = error ? "error" : "success";
  if (ui.messageTimer !== null) window.clearTimeout(ui.messageTimer);
  ui.messageTimer = window.setTimeout(() => {
    element.textContent = "";
    ui.messageTimer = null;
  }, 4_000);
}

function formatClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(date)
    : "—";
}

function elapsedSeconds(startedAt) {
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
}

function setButtonPending(button, pending, label = "处理中") {
  if (!button) return;
  if (pending) {
    if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent.trim();
    button.dataset.pendingStartedAt = String(Date.now());
    button.dataset.pendingLabel = label;
    button.classList.add("is-pending");
    button.setAttribute("aria-busy", "true");
    button.disabled = true;
  } else {
    button.classList.remove("is-pending");
    button.removeAttribute("aria-busy");
    button.disabled = false;
    if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
    delete button.dataset.pendingStartedAt;
    delete button.dataset.pendingLabel;
    delete button.dataset.idleLabel;
  }
  renderLiveRefreshStates();
}

function renderDataRefreshState() {
  const element = $("#data-refresh-state");
  element.classList.toggle("is-refreshing", ui.dataRefreshStartedAt !== null);
  element.classList.toggle("is-error", ui.dataRefreshFailed);
  if (ui.dataRefreshStartedAt !== null) {
    element.textContent = `数据刷新中 · ${elapsedSeconds(ui.dataRefreshStartedAt)}秒`;
  } else if (ui.dataRefreshCompletedAt !== null) {
    element.textContent = `${ui.dataRefreshFailed ? "刷新失败" : "数据更新于"} ${formatClock(ui.dataRefreshCompletedAt)}`;
  } else {
    element.textContent = "数据加载中";
  }
}

function renderScanRefreshState() {
  const element = $("#scan-refresh-state");
  const status = ui.scanStatus;
  const scanning = status?.scanning === true;
  element.classList.toggle("is-refreshing", scanning);
  element.classList.toggle("is-error", !scanning && Boolean(status?.lastError));
  if (scanning) {
    const diagnosticsStartedAt = Date.parse(status?.diagnostics?.startedAt ?? "");
    const startedAt = Number.isFinite(diagnosticsStartedAt)
      ? diagnosticsStartedAt
      : (ui.scanObservedStartedAt ?? Date.now());
    element.textContent = `扫描中 · ${elapsedSeconds(startedAt)}秒`;
  } else if (status?.lastError) {
    const completedAt = status?.diagnostics?.completedAt ?? new Date();
    element.textContent = `刷新失败 · ${formatClock(completedAt)}`;
  } else if (status?.lastScanAt) {
    element.textContent = `更新于 ${formatClock(status.lastScanAt)}`;
  } else {
    element.textContent = "等待首次扫描";
  }
}

function renderLiveRefreshStates() {
  document.querySelectorAll("[data-pending-started-at]").forEach((button) => {
    const startedAt = Number(button.dataset.pendingStartedAt);
    const label = button.dataset.pendingLabel || "处理中";
    button.textContent = `${label} · ${elapsedSeconds(startedAt)}秒`;
  });
  renderDataRefreshState();
  renderScanRefreshState();
}

function formatMoney(value, signed = false) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const prefix = signed && amount > 0 ? "+" : "";
  return `${prefix}${amount.toFixed(2)}U`;
}

function formatCents(value) {
  const cents = Number(value) * 100;
  if (!Number.isFinite(cents)) return "—";
  return `${cents.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}¢`;
}

function setMoneyValue(selector, value, signed = false) {
  const element = $(selector);
  const amount = Number(value);
  element.textContent = formatMoney(value, signed);
  element.dataset.tone = amount > 0 ? "positive" : amount < 0 ? "negative" : "neutral";
}

function renderPortfolio(portfolio) {
  setMoneyValue("#total-funds", portfolio.totalFunds);
  setMoneyValue("#total-pnl", portfolio.totalPnl, true);
  setMoneyValue("#realized-pnl", portfolio.realizedPnl, true);
  setMoneyValue("#unrealized-pnl", portfolio.unrealizedPnl, true);
}

function renderRunControls() {
  const running = ui.strategyStatus === "RUNNING";
  const runToggle = $("#run-toggle");
  if (!runToggle.classList.contains("is-pending")) {
    runToggle.textContent = running ? "暂停TEST" : "开始TEST";
  }
  runToggle.disabled = ui.controlPending;
  runToggle.setAttribute(
    "aria-label",
    running ? "暂停TEST自动交易" : "开始TEST自动交易",
  );
  const newCycle = $("#new-cycle");
  newCycle.disabled = running || ui.controlPending;
  $("#new-cycle-note").textContent = running
    ? "请先暂停TEST，再开始新一轮。持仓、卖单和历史盈亏不会清空。"
    : "新一轮只解锁已完成且尚未结算的市场；持仓、卖单和历史盈亏继续保留。";
}

function recordMutation() {
  ui.mutationVersion += 1;
  if (ui.loading) ui.reloadRequested = true;
}

function marketTitleMarkup(item) {
  const title = escapeHtml(item.marketQuestion || item.eventTitle || "未命名市场");
  const url = item.marketUrl;
  return url
    ? `<a class="market-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${title}</a>`
    : `<span class="market-link">${title}</span>`;
}

function progressMarkup(progressPercent, label = "市场进度") {
  const progress = Number(progressPercent);
  if (!Number.isFinite(progress)) {
    return `<div class="position-meta"><span>${label}</span><span>待更新</span></div>`;
  }
  const clamped = Math.min(100, Math.max(0, progress));
  return `<div class="progress-track" role="progressbar" aria-label="${label}${clamped.toFixed(1)}%" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${clamped.toFixed(1)}"><span style="width:${clamped.toFixed(1)}%"></span></div>`;
}

function renderPositions(positions, orders, activeBuyOrderCount) {
  const currentPositions = positions.filter(
    (position) => Number(position.quantity) > 0,
  );
  const activeBuyCount = Number.isInteger(activeBuyOrderCount)
    ? activeBuyOrderCount
    : orders.filter(
        (order) =>
          order.side === "BUY" &&
          (order.status === "OPEN" || order.status === "PARTIALLY_FILLED"),
      ).length;
  $("#position-count").textContent = `${currentPositions.length}个`;
  const summary = $("#pending-buy-summary");
  summary.classList.toggle(
    "is-refreshing",
    activeBuyCount === 0 &&
      ui.strategyStatus === "RUNNING" &&
      ui.scanStatus?.scanning === true,
  );
  if (activeBuyCount > 0) {
    summary.innerHTML = `<strong>${activeBuyCount.toLocaleString("zh-CN")}张买入委托等待成交</strong><span>筛选后已经自动挂单；未成交委托不算持仓，公开成交确认后才会显示在下方。</span>`;
  } else if (ui.strategyStatus === "RUNNING" && ui.scanStatus?.scanning === true) {
    summary.innerHTML = "<strong>正在扫描并准备买入委托</strong><span>扫描完成且盘口就绪后会自动挂单。</span>";
  } else if (ui.strategyStatus === "RUNNING") {
    summary.innerHTML = "<strong>当前没有等待成交的买入委托</strong><span>程序会在符合筛选条件且盘口就绪时自动挂单。</span>";
  } else {
    summary.innerHTML = "<strong>TEST尚未开始</strong><span>筛选只决定交易范围；点击“开始TEST”后才会自动挂单，成交后才形成持仓。</span>";
  }
  $("#positions").innerHTML = currentPositions.length
    ? currentPositions
        .map((position) => {
          const progress = Number(position.progressPercent);
          const progressText = Number.isFinite(progress)
            ? `市场进度 ${progress.toFixed(1)}%`
            : "市场进度待更新";
          return `<article class="position-row">
            <div class="position-main">
              <div>
                ${marketTitleMarkup(position)}
                <span class="event-title">${escapeHtml(position.eventTitle || "")}</span>
              </div>
              <div class="outcome-badge">
                <small>买入结果</small>
                <strong>${escapeHtml(position.direction || "—")}</strong>
              </div>
            </div>
            <div class="position-meta">
              <span class="buy-price">买入价 ${formatCents(position.averageBuyPrice)}</span>
              <span>${progressText}</span>
            </div>
            ${progressMarkup(position.progressPercent)}
          </article>`;
        })
        .join("")
    : '<p class="empty-state">暂无已成交持仓</p>';
}

function sortedCandidates() {
  return [...ui.candidates].sort((left, right) =>
    ui.sortDirection === "asc"
      ? left.progressPercent - right.progressPercent
      : right.progressPercent - left.progressPercent,
  );
}

function renderCandidates() {
  const sorted = sortedCandidates();
  const visible = sorted.slice(0, ui.visibleCandidateCount);
  const selectionDefault = ui.preferences?.candidatesSelectedByDefault
    ? "新市场默认勾选"
    : "新市场默认不勾选";
  $("#selection-count").textContent = `${selectionDefault} · 已选${ui.selectedCandidateCount.toLocaleString("zh-CN")} / ${sorted.length.toLocaleString("zh-CN")}`;
  $("#display-count").textContent = `当前显示${visible.length.toLocaleString("zh-CN")} / ${sorted.length.toLocaleString("zh-CN")}`;
  $("#load-more").disabled = visible.length >= sorted.length;
  $("#load-more").textContent = visible.length >= sorted.length ? "已全部显示" : "再显示20个";

  $("#candidates").innerHTML = visible.length
    ? visible
        .map(
          (candidate) => `<article class="market-row" data-market-token="${escapeHtml(candidate.tokenId)}">
            <label class="candidate-toggle ${candidate.selected ? "is-selected" : ""}">
              <input
                type="checkbox"
                data-candidate-token="${escapeHtml(candidate.tokenId)}"
                aria-label="允许TEST交易：${escapeHtml(candidate.marketQuestion)}—${escapeHtml(candidate.direction)}"
                ${candidate.selected ? "checked" : ""}
              />
              <span>参与</span>
            </label>
            <div>
              ${marketTitleMarkup(candidate)}
              <span class="mobile-market-detail">结果 ${escapeHtml(candidate.direction)}</span>
            </div>
            <span class="market-outcome">${escapeHtml(candidate.direction)}</span>
            <strong class="market-price"><small>买入价</small>${formatCents(candidate.makerBuyPrice)}</strong>
            <div class="market-progress">
              <div class="market-progress-heading"><span>市场进度</span><span>${Number(candidate.progressPercent).toFixed(1)}%</span></div>
              ${progressMarkup(candidate.progressPercent)}
            </div>
          </article>`,
        )
        .join("")
    : '<p class="empty-state">当前没有符合条件的市场</p>';
}

function renderPreferences(preferences) {
  ui.durationOptions = preferences.durationOptions;
  $("#binary-market").checked = preferences.resultCounts.includes(2);
  $("#ternary-market").checked = preferences.resultCounts.includes(3);
  $("#max-buy-price").value = String(preferences.maxBuyPriceCents);
  const durationIndex = Math.max(
    0,
    ui.durationOptions.indexOf(preferences.maxMarketDurationDays),
  );
  $("#market-duration").max = String(ui.durationOptions.length - 1);
  $("#market-duration").value = String(durationIndex);
  $("#duration-value").textContent = String(ui.durationOptions[durationIndex]);
  $("#market-duration").setAttribute(
    "aria-valuetext",
    ui.durationOptions[durationIndex] === 1
      ? "1天"
      : `1至${ui.durationOptions[durationIndex]}天`,
  );
  $("#duration-marks").innerHTML = ui.durationOptions
    .map((duration) => `<span>${duration}</span>`)
    .join("");
  $("#market-progress-filter").value = String(
    preferences.maxMarketProgressPercent,
  );
  $("#market-progress-value").textContent = String(
    preferences.maxMarketProgressPercent,
  );
  $("#market-progress-filter").setAttribute(
    "aria-valuetext",
    `不超过${preferences.maxMarketProgressPercent}%`,
  );
}

async function loadAll() {
  if (ui.loading) {
    ui.reloadRequested = true;
    return;
  }
  ui.loading = true;
  ui.dataRefreshStartedAt = Date.now();
  ui.dataRefreshFailed = false;
  renderLiveRefreshStates();
  const mutationVersion = ui.mutationVersion;
  try {
    const [status, candidates, positions, orders, preferences] = await Promise.all([
      api("/api/status?compact=true"),
      api("/api/candidates"),
      api("/api/paper/positions"),
      api("/api/paper/orders"),
      api("/api/paper/preferences"),
    ]);
    if (mutationVersion !== ui.mutationVersion) return;
    ui.strategyStatus = status.strategy.status;
    ui.scanStatus = candidates;
    if (candidates.scanning && ui.scanObservedStartedAt === null) {
      ui.scanObservedStartedAt = Date.now();
    } else if (!candidates.scanning) {
      ui.scanObservedStartedAt = null;
    }
    renderRunControls();
    renderPortfolio(status.portfolio);
    renderPositions(
      positions.positions,
      orders.orders,
      orders.activeBuyOrderCount,
    );
    ui.candidates = candidates.candidates;
    ui.selectedCandidateCount = candidates.selectedCandidateCount;
    ui.preferences = preferences.preferences;
    ui.visibleCandidateCount = Math.max(
      20,
      Math.min(ui.visibleCandidateCount, Math.max(20, ui.candidates.length)),
    );
    renderCandidates();
    if (!ui.configDirty) {
      renderPreferences(preferences.preferences);
    }
    ui.dataRefreshCompletedAt = new Date();
  } catch (error) {
    ui.dataRefreshFailed = true;
    ui.dataRefreshCompletedAt = new Date();
    throw error;
  } finally {
    ui.dataRefreshStartedAt = null;
    ui.loading = false;
    renderLiveRefreshStates();
    if (ui.reloadRequested) {
      ui.reloadRequested = false;
      void loadAll().catch((error) => showMessage(error.message, true));
    }
  }
}

async function waitForCandidateRefresh() {
  let snapshot = await api("/api/candidates");
  while (snapshot.scanning) {
    ui.scanStatus = snapshot;
    if (ui.scanObservedStartedAt === null) {
      ui.scanObservedStartedAt = Date.now();
    }
    renderScanRefreshState();
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    snapshot = await api("/api/candidates");
  }
  ui.scanStatus = snapshot;
  ui.scanObservedStartedAt = null;
  renderScanRefreshState();
  if (snapshot.lastError) {
    throw new Error(`市场扫描失败：${snapshot.lastError}`);
  }
}

function setConfigOpen(open) {
  $("#config-panel").hidden = !open;
  $("#config-toggle").setAttribute("aria-expanded", String(open));
  renderRunControls();
}

$("#config-toggle").addEventListener("click", () => {
  const open = $("#config-panel").hidden;
  if (ui.preferences !== null) renderPreferences(ui.preferences);
  ui.configDirty = false;
  setConfigOpen(open);
});

$("#config-close").addEventListener("click", () => {
  if (ui.preferences !== null) renderPreferences(ui.preferences);
  ui.configDirty = false;
  setConfigOpen(false);
});

$("#config-form").addEventListener("input", () => {
  ui.configDirty = true;
});

$("#market-duration").addEventListener("input", (event) => {
  const index = Number(event.target.value);
  $("#duration-value").textContent = String(ui.durationOptions[index]);
  event.target.setAttribute(
    "aria-valuetext",
    ui.durationOptions[index] === 1
      ? "1天"
      : `1至${ui.durationOptions[index]}天`,
  );
});

$("#market-progress-filter").addEventListener("input", (event) => {
  $("#market-progress-value").textContent = event.target.value;
  event.target.setAttribute("aria-valuetext", `不超过${event.target.value}%`);
});

$("#config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  setButtonPending(submit, true, "保存中");
  try {
    const resultCounts = [];
    if ($("#binary-market").checked) resultCounts.push(2);
    if ($("#ternary-market").checked) resultCounts.push(3);
    const durationIndex = Number($("#market-duration").value);
    const response = await api("/api/paper/preferences", {
      method: "PUT",
      body: JSON.stringify({
        resultCounts,
        maxBuyPriceCents: Number($("#max-buy-price").value),
        maxMarketDurationDays: ui.durationOptions[durationIndex],
        maxMarketProgressPercent: Number($("#market-progress-filter").value),
      }),
    });
    recordMutation();
    ui.preferences = response.preferences;
    ui.configDirty = false;
    renderPreferences(response.preferences);
    ui.visibleCandidateCount = 20;
    showMessage(
      response.cancelledBuyCount > 0
        ? `配置已保存，已撤销${response.cancelledBuyCount}张不再合格的买单`
        : "配置已保存，正在重新扫描市场",
    );
    await loadAll();
    await waitForCandidateRefresh();
    await loadAll();
    setConfigOpen(false);
    showMessage(
      response.cancelledBuyCount > 0
        ? `配置已保存，已撤销${response.cancelledBuyCount}张买单，市场扫描已更新`
        : "配置已保存，市场扫描已更新",
    );
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    setButtonPending(submit, false);
  }
});

$("#run-toggle").addEventListener("click", async () => {
  const wasRunning = ui.strategyStatus === "RUNNING";
  ui.controlPending = true;
  renderRunControls();
  setButtonPending(
    $("#run-toggle"),
    true,
    wasRunning ? "暂停中" : "启动中",
  );
  try {
    const response = await api(
      wasRunning ? "/api/paper/pause" : "/api/paper/start",
      { method: "POST" },
    );
    recordMutation();
    ui.strategyStatus = response.strategy.status;
    showMessage(wasRunning ? "TEST已暂停，现有持仓和卖单继续保留" : "TEST已开始");
    await loadAll();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    ui.controlPending = false;
    setButtonPending($("#run-toggle"), false);
    renderRunControls();
  }
});

$("#new-cycle").addEventListener("click", async () => {
  if (
    !window.confirm(
      "开始新一轮会让已完整卖出且尚未结算的Token重新参与买入。现有持仓、卖单和历史盈亏不会清空。继续吗？",
    )
  ) {
    return;
  }
  ui.controlPending = true;
  renderRunControls();
  setButtonPending($("#new-cycle"), true, "启动新一轮中");
  try {
    const response = await api("/api/paper/cycle/start", { method: "POST" });
    recordMutation();
    ui.strategyStatus = response.strategy.status;
    setConfigOpen(false);
    showMessage(
      response.resetTokenCount > 0
        ? `新一轮已开始，已解锁${response.resetTokenCount}个已完成Token`
        : "新一轮已开始，没有需要解锁的Token",
    );
    await loadAll();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    ui.controlPending = false;
    setButtonPending($("#new-cycle"), false);
    renderRunControls();
  }
});

$("#live-mode").addEventListener("click", () => {
  $("#live-lock").hidden = false;
  showMessage("LIVE 尚未开放，当前仍为 TEST");
});

$("#test-mode").addEventListener("click", () => {
  $("#live-lock").hidden = true;
});

document.addEventListener("click", async (event) => {
  const sortButton = event.target.closest("[data-sort]");
  if (sortButton) {
    ui.sortDirection = sortButton.dataset.sort;
    document.querySelectorAll("[data-sort]").forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.sort === ui.sortDirection),
      );
    });
    renderCandidates();
  }
});

$("#candidates").addEventListener("change", async (event) => {
  const input = event.target.closest("[data-candidate-token]");
  if (!input) return;
  const candidate = ui.candidates.find(
    (item) => item.tokenId === input.dataset.candidateToken,
  );
  if (!candidate) return;
  const toggle = input.closest(".candidate-toggle");
  input.disabled = true;
  toggle?.classList.add("is-pending");
  toggle?.setAttribute("aria-busy", "true");
  try {
    await api("/api/paper/candidate-selection", {
      method: "PUT",
      body: JSON.stringify({
        action: "set",
        tokenId: candidate.tokenId,
        selected: input.checked,
      }),
    });
    recordMutation();
    candidate.selected = input.checked;
    ui.selectedCandidateCount = ui.candidates.filter(
      (item) => item.selected,
    ).length;
    renderCandidates();
  } catch (error) {
    input.checked = !input.checked;
    input.disabled = false;
    toggle?.classList.remove("is-pending");
    toggle?.removeAttribute("aria-busy");
    showMessage(error.message, true);
  }
});

async function setAllCandidates(action, button) {
  setButtonPending(button, true, action === "all" ? "全选中" : "清空中");
  try {
    await api("/api/paper/candidate-selection", {
      method: "PUT",
      body: JSON.stringify({ action }),
    });
    recordMutation();
    const selected = action === "all";
    if (ui.preferences !== null) {
      ui.preferences.candidatesSelectedByDefault = selected;
    }
    ui.candidates.forEach((candidate) => {
      candidate.selected = selected;
    });
    ui.selectedCandidateCount = selected ? ui.candidates.length : 0;
    renderCandidates();
    showMessage(selected ? "已选择全部扫描市场" : "已清空TEST交易范围");
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    setButtonPending(button, false);
  }
}

$("#select-all").addEventListener("click", (event) =>
  setAllCandidates("all", event.currentTarget),
);
$("#clear-all").addEventListener("click", (event) =>
  setAllCandidates("none", event.currentTarget),
);

$("#load-more").addEventListener("click", () => {
  ui.visibleCandidateCount = Math.min(
    ui.candidates.length,
    ui.visibleCandidateCount + 20,
  );
  renderCandidates();
});

loadAll().catch((error) => showMessage(error.message, true));
window.setInterval(renderLiveRefreshStates, 1_000);
window.setInterval(() => {
  loadAll().catch(() => {});
}, 10_000);
