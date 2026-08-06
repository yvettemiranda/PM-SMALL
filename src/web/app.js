const $ = (selector) => document.querySelector(selector);

const ui = {
  dashboard: null,
  preferences: null,
  strategyStatus: "STOPPED",
  candidates: [],
  candidateCount: 0,
  visibleCandidateCount: 20,
  durationOptions: [1, 7, 14, 30, 60, 90, 120, 180, 360, 365],
  configDirty: false,
  loading: false,
  reloadRequested: false,
  mutationVersion: 0,
  controlPending: false,
  messageTimer: null,
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers:
      options.body === undefined
        ? options.headers
        : { "content-type": "application/json", ...options.headers },
  });
  const rawBody = await response.text();
  let body = {};
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = { error: rawBody };
    }
  }
  if (!response.ok) {
    throw new Error(body.error || body.message || `请求失败（${response.status}）`);
  }
  return body;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
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
    element.className = "";
    ui.messageTimer = null;
  }, 4_500);
}

function formatMoney(value, signed = false) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const prefix = signed && amount > 0 ? "+" : "";
  return `${prefix}${amount.toFixed(2)}U`;
}

function formatCents(value) {
  const cents = Number(value) * 100;
  return Number.isFinite(cents) ? `${cents.toFixed(2)}¢` : "—";
}

function formatQuantity(value) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity)) return "—";
  return quantity.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function formatClock(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(date)
    : "—";
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date)
    : "—";
}

function formatCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, count).toLocaleString("zh-CN") : "0";
}

function setMoneyValue(selector, value, signed = false) {
  const element = $(selector);
  const amount = Number(value);
  element.textContent = formatMoney(value, signed);
  element.dataset.tone = amount > 0 ? "positive" : amount < 0 ? "negative" : "neutral";
}

function setButtonPending(button, pending, label = "处理中") {
  if (!button) return;
  if (pending) {
    button.dataset.idleLabel = button.textContent.trim();
    button.classList.add("is-pending");
    button.setAttribute("aria-busy", "true");
    button.textContent = label;
    button.disabled = true;
    return;
  }
  button.classList.remove("is-pending");
  button.removeAttribute("aria-busy");
  if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
  delete button.dataset.idleLabel;
  button.disabled = false;
}

function recordMutation() {
  ui.mutationVersion += 1;
  if (ui.loading) ui.reloadRequested = true;
}

function marketTitleMarkup(item) {
  const title = escapeHtml(item.marketQuestion || item.eventTitle || "未命名市场");
  return item.marketUrl
    ? `<a class="market-link" href="${escapeHtml(item.marketUrl)}" target="_blank" rel="noreferrer">${title}<span aria-hidden="true">↗</span></a>`
    : `<span class="market-link">${title}</span>`;
}

function progressMarkup(progressPercent, label = "市场进度") {
  const progress = Number(progressPercent);
  if (!Number.isFinite(progress)) {
    return '<div class="progress-track is-empty" aria-label="市场进度待更新"><span></span></div>';
  }
  const clamped = Math.min(100, Math.max(0, progress));
  return `<div class="progress-track" role="progressbar" aria-label="${escapeHtml(label)} ${clamped.toFixed(1)}%" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${clamped.toFixed(1)}"><span style="width:${clamped.toFixed(1)}%"></span></div>`;
}

function renderPortfolio(portfolio) {
  setMoneyValue("#total-funds", portfolio?.totalFunds);
  setMoneyValue("#total-pnl", portfolio?.totalPnl, true);
  setMoneyValue("#realized-pnl", portfolio?.realizedPnl, true);
  setMoneyValue("#unrealized-pnl", portfolio?.unrealizedPnl, true);
}

function renderRunControls() {
  const running = ui.strategyStatus === "RUNNING";
  const paused = ui.strategyStatus === "PAUSED";
  const runToggle = $("#run-toggle");
  if (!runToggle.classList.contains("is-pending")) {
    runToggle.textContent = running ? "暂停TEST" : "开始TEST";
  }
  runToggle.disabled = ui.controlPending;
  runToggle.setAttribute("aria-label", running ? "暂停TEST自动买入" : "开始TEST自动交易");

  const capital = $("#initial-capital");
  capital.disabled = running;
  capital.title = running ? "修改总模拟资金前请先暂停TEST" : "";
  const reset = $("#reset-test");
  reset.disabled = !paused || ui.controlPending;
  reset.title = paused ? "" : "重置前必须先暂停TEST";
}

function renderPositions(positions = []) {
  const current = positions.filter((position) => Number(position.quantity) > 0);
  $("#position-count").textContent = `${formatCount(current.length)}个`;
  $("#positions").innerHTML = current.length
    ? current
        .map((position) => {
          const progress = Number(position.progressPercent);
          const progressText = Number.isFinite(progress) ? `${progress.toFixed(1)}%` : "待更新";
          const targets = Array.isArray(position.targetSellPrices)
            ? position.targetSellPrices
            : position.targetSellPrice === null
              ? []
              : [position.targetSellPrice];
          const targetLabel = targets.length > 1
            ? `${formatCents(targets[0])} 起 · ${targets.length}档`
            : formatCents(position.targetSellPrice);
          const eventTitle = position.eventTitle && position.eventTitle !== position.marketQuestion
            ? `<span class="event-title">${escapeHtml(position.eventTitle)}</span>`
            : "";
          return `<article class="position-row">
            <div class="row-heading">
              <div class="market-copy">${marketTitleMarkup(position)}${eventTitle}</div>
              <div class="outcome-badge"><small>买入结果</small><strong>${escapeHtml(position.direction || "—")}</strong></div>
            </div>
            <div class="quote-grid position-quotes">
              <div><span>实际买入</span><strong>${formatCents(position.averageBuyPrice)}</strong></div>
              <div><span>当前可卖</span><strong>${formatCents(position.currentSellPrice)}</strong></div>
              <div title="${escapeHtml(targets.map(formatCents).join("、"))}"><span>目标卖价</span><strong>${targetLabel}</strong></div>
              <div><span>持仓数量</span><strong>${formatQuantity(position.quantity)}</strong></div>
            </div>
            <div class="progress-heading"><span>市场生命周期</span><strong>${progressText}</strong></div>
            ${progressMarkup(position.progressPercent, "市场生命周期")}
          </article>`;
        })
        .join("")
    : '<p class="empty-state">暂无已成交持仓</p>';
}

function renderCandidates() {
  const visible = ui.candidates;
  $("#candidate-count").textContent = `${formatCount(ui.candidateCount)}个`;
  $("#display-count").textContent = `当前显示 ${formatCount(visible.length)} / ${formatCount(ui.candidateCount)}`;
  const loadMore = $("#load-more");
  const allVisible = visible.length >= ui.candidateCount;
  loadMore.disabled = allVisible;
  loadMore.textContent = allVisible ? "已全部显示" : "再显示20个";

  $("#candidates").innerHTML = visible.length
    ? visible
        .map((candidate) => {
          const progress = Number(candidate.progressPercent);
          const progressText = Number.isFinite(progress) ? `${progress.toFixed(1)}%` : "待更新";
          const category = candidate.category
            ? `<span class="meta-pill">${escapeHtml(candidate.category)}</span>`
            : "";
          return `<article class="market-row">
            <div class="row-heading">
              <div class="market-copy">
                ${marketTitleMarkup(candidate)}
                <div class="market-meta">${category}<span>${escapeHtml(candidate.resultCount)}元市场</span></div>
              </div>
              <span class="market-outcome">${escapeHtml(candidate.direction || "—")}</span>
            </div>
            <div class="quote-grid candidate-quotes">
              <div><span>当前可买</span><strong>${formatCents(candidate.executableBuyPrice)}</strong></div>
              <div><span>当前可卖</span><strong>${formatCents(candidate.bestBid)}</strong></div>
              <div class="market-time"><span>开始</span><strong>${formatDate(candidate.openedAt)}</strong></div>
              <div class="market-time"><span>结束</span><strong>${formatDate(candidate.endsAt)}</strong></div>
            </div>
            <div class="progress-heading"><span>市场生命周期</span><strong>${progressText}</strong></div>
            ${progressMarkup(candidate.progressPercent, "市场生命周期")}
          </article>`;
        })
        .join("")
    : '<p class="empty-state">当前没有符合配置且可立即买入的市场</p>';
}

function scanPhaseLabel(phase) {
  return {
    EVENTS: "读取市场",
    ORDER_BOOKS: "读取订单簿",
    COMPLETE: "整理完成",
    FAILED: "扫描失败",
  }[phase] || "准备扫描";
}

function renderScanStatus(status) {
  const element = $("#scan-refresh-state");
  const diagnostics = status?.diagnostics;
  element.classList.toggle("is-refreshing", status?.scanning === true);
  element.classList.toggle("is-error", Boolean(status?.lastError));

  if (status?.scanning) {
    element.textContent = [
      `扫描中 · ${scanPhaseLabel(diagnostics?.phase)}`,
      `市场 ${formatCount(diagnostics?.eventCount)}`,
      `订单簿 ${formatCount(diagnostics?.orderBookCount)} / ${formatCount(diagnostics?.eligibleTokenCount)}`,
      `当前可买 ${formatCount(status.candidateCount)}`,
      `${((Number(diagnostics?.durationMs) || 0) / 1_000).toFixed(1)}秒`,
    ].join(" · ");
    return;
  }

  if (status?.lastError) {
    element.textContent = `扫描失败 · 已保留 ${formatCount(status.candidateCount)} 个上次候选 · ${formatClock(diagnostics?.completedAt)}`;
    element.title = status.lastError;
    return;
  }

  element.title = "";
  if (status?.lastScanAt) {
    element.textContent = [
      "扫描完成",
      `市场 ${formatCount(diagnostics?.eventCount)}`,
      `订单簿 ${formatCount(diagnostics?.orderBookCount)}`,
      `监控 ${formatCount(diagnostics?.monitoredTokenCount)}`,
      `当前可买 ${formatCount(status.candidateCount)}`,
      `${((Number(diagnostics?.durationMs) || 0) / 1_000).toFixed(1)}秒`,
      formatClock(status.lastScanAt),
    ].join(" · ");
    return;
  }
  element.textContent = "等待首次扫描";
}

function availableCategories(preferences) {
  const scanned = ui.dashboard?.marketScan?.diagnostics?.availableCategories ?? [];
  return Array.from(new Set([...scanned, ...(preferences?.selectedCategories ?? [])])).sort((left, right) =>
    left.localeCompare(right, "zh-CN"),
  );
}

function renderCategories(preferences) {
  const categories = availableCategories(preferences);
  const all = preferences.allCategories;
  $("#all-categories").checked = all;
  $("#category-options").innerHTML = categories
    .map((category) => `<label class="category-chip">
      <input type="checkbox" data-category="${escapeHtml(category)}" ${preferences.selectedCategories.includes(category) ? "checked" : ""} ${all ? "disabled" : ""} />
      <span>${escapeHtml(category)}</span>
    </label>`)
    .join("");
  $("#category-note").textContent = categories.length
    ? all
      ? `当前扫描到 ${categories.length} 个类别，已选择全部。`
      : `已选择 ${preferences.selectedCategories.length} / ${categories.length} 个类别。`
    : "扫描完成后会显示可选类别。";
}

function renderPreferences(preferences, strategy, force = false) {
  if (ui.configDirty && !force) return;
  ui.durationOptions = preferences.durationOptions ?? ui.durationOptions;
  $("#binary-market").checked = preferences.resultCounts.includes(2);
  $("#ternary-market").checked = preferences.resultCounts.includes(3);
  $("#max-buy-price").value = String(preferences.maxBuyPriceCents);
  const durationIndex = Math.max(0, ui.durationOptions.indexOf(preferences.maxMarketDurationDays));
  $("#market-duration").max = String(ui.durationOptions.length - 1);
  $("#market-duration").value = String(durationIndex);
  $("#duration-value").textContent = String(ui.durationOptions[durationIndex]);
  $("#duration-marks").innerHTML = ui.durationOptions.map((duration) => `<span>${duration}</span>`).join("");
  $("#market-duration").setAttribute("aria-valuetext", `1至${ui.durationOptions[durationIndex]}天`);
  $("#initial-capital").value = Number(strategy.initialCapital).toFixed(2);
  $("#order-amount").value = Number(preferences.orderAmount).toFixed(2);
  renderCategories(preferences);
  updateSortButtons(preferences.candidateSortDirection);
  renderRunControls();
}

function updateSortButtons(direction) {
  document.querySelectorAll("[data-sort]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.sort === direction));
  });
}

function applyDashboard(dashboard) {
  ui.dashboard = dashboard;
  ui.preferences = dashboard.preferences;
  ui.strategyStatus = dashboard.strategy.status;
  ui.candidates = dashboard.marketScan.candidates ?? [];
  ui.candidateCount = dashboard.marketScan.candidateCount ?? ui.candidates.length;
  renderRunControls();
  renderPortfolio(dashboard.portfolio);
  renderPositions(dashboard.positions);
  renderCandidates();
  renderScanStatus(dashboard.marketScan);
  renderPreferences(dashboard.preferences, dashboard.strategy);
}

async function loadDashboard({ silent = false } = {}) {
  if (ui.loading) {
    ui.reloadRequested = true;
    return;
  }
  ui.loading = true;
  const mutationVersion = ui.mutationVersion;
  try {
    const dashboard = await api(`/api/dashboard?limit=${ui.visibleCandidateCount}`);
    if (mutationVersion === ui.mutationVersion) applyDashboard(dashboard);
  } catch (error) {
    if (!silent) showMessage(`数据刷新失败：${error.message}`, true);
  } finally {
    ui.loading = false;
    if (ui.reloadRequested) {
      ui.reloadRequested = false;
      void loadDashboard({ silent: true });
    }
  }
}

function setConfigOpen(open) {
  $("#config-panel").hidden = !open;
  $("#config-toggle").setAttribute("aria-expanded", String(open));
}

function selectedCategoriesFromForm() {
  return Array.from(document.querySelectorAll("[data-category]:checked")).map(
    (input) => input.dataset.category,
  );
}

function collectConfigPayload() {
  const resultCounts = [];
  if ($("#binary-market").checked) resultCounts.push(2);
  if ($("#ternary-market").checked) resultCounts.push(3);
  if (resultCounts.length === 0) throw new Error("请至少选择一种市场类型");

  const allCategories = $("#all-categories").checked;
  const selectedCategories = selectedCategoriesFromForm();
  if (!allCategories && selectedCategories.length === 0) {
    throw new Error("请选择至少一个市场类别，或选择全部符合条件");
  }

  const maxBuyPriceCents = Number($("#max-buy-price").value);
  const durationIndex = Number($("#market-duration").value);
  const initialCapital = Number($("#initial-capital").value);
  const orderAmount = Number($("#order-amount").value);
  if (!Number.isInteger(maxBuyPriceCents) || maxBuyPriceCents < 1 || maxBuyPriceCents > 3) {
    throw new Error("最高买入价必须是1至3之间的整数美分");
  }
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new Error("总模拟资金必须大于0");
  if (!Number.isFinite(orderAmount) || orderAmount <= 0) throw new Error("每单使用金额必须大于0");
  if (orderAmount > initialCapital) throw new Error("每单使用金额不能超过总模拟资金");

  return {
    resultCounts,
    allCategories,
    selectedCategories,
    maxBuyPriceCents,
    maxMarketDurationDays: ui.durationOptions[durationIndex],
    candidateSortDirection: ui.preferences.candidateSortDirection,
    initialCapital,
    orderAmount,
  };
}

function savedPreferencePayload(overrides = {}) {
  return {
    resultCounts: ui.preferences.resultCounts,
    allCategories: ui.preferences.allCategories,
    selectedCategories: ui.preferences.selectedCategories,
    maxBuyPriceCents: ui.preferences.maxBuyPriceCents,
    maxMarketDurationDays: ui.preferences.maxMarketDurationDays,
    candidateSortDirection: ui.preferences.candidateSortDirection,
    orderAmount: Number(ui.preferences.orderAmount),
    ...overrides,
  };
}

$("#config-toggle").addEventListener("click", () => {
  const open = $("#config-panel").hidden;
  if (open && ui.dashboard) {
    ui.configDirty = false;
    renderPreferences(ui.preferences, ui.dashboard.strategy, true);
  }
  setConfigOpen(open);
});

$("#config-close").addEventListener("click", () => {
  ui.configDirty = false;
  if (ui.dashboard) renderPreferences(ui.preferences, ui.dashboard.strategy, true);
  setConfigOpen(false);
});

$("#config-form").addEventListener("input", () => {
  ui.configDirty = true;
});

$("#all-categories").addEventListener("change", () => {
  document.querySelectorAll("[data-category]").forEach((input) => {
    input.disabled = $("#all-categories").checked;
  });
});

$("#market-duration").addEventListener("input", (event) => {
  const value = ui.durationOptions[Number(event.target.value)];
  $("#duration-value").textContent = String(value);
  event.target.setAttribute("aria-valuetext", `1至${value}天`);
});

$("#config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter || $("#save-config");
  setButtonPending(submit, true, "保存中");
  try {
    const response = await api("/api/test/preferences", {
      method: "PUT",
      body: JSON.stringify(collectConfigPayload()),
    });
    recordMutation();
    ui.preferences = response.preferences;
    ui.strategyStatus = response.strategy.status;
    ui.visibleCandidateCount = 20;
    ui.configDirty = false;
    if (ui.dashboard) {
      ui.dashboard.preferences = response.preferences;
      ui.dashboard.strategy = response.strategy;
      renderPreferences(response.preferences, response.strategy, true);
    }
    setConfigOpen(false);
    showMessage(
      response.cancelledBuyCount > 0
        ? `配置已保存，已撤销 ${response.cancelledBuyCount} 张不再适用的旧买单`
        : "配置已保存，市场正在按新条件重新扫描",
    );
    await loadDashboard();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    setButtonPending(submit, false);
    renderRunControls();
  }
});

$("#run-toggle").addEventListener("click", async () => {
  const wasRunning = ui.strategyStatus === "RUNNING";
  const button = $("#run-toggle");
  ui.controlPending = true;
  setButtonPending(button, true, wasRunning ? "暂停中" : "启动中");
  try {
    const response = await api(wasRunning ? "/api/test/pause" : "/api/test/start", { method: "POST" });
    recordMutation();
    ui.strategyStatus = response.strategy.status;
    showMessage(wasRunning ? "TEST已暂停新买入；已有仓位仍会继续卖出和结算" : "TEST已开始");
    await loadDashboard();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    ui.controlPending = false;
    setButtonPending(button, false);
    renderRunControls();
  }
});

$("#reset-test").addEventListener("click", async () => {
  if (ui.strategyStatus !== "PAUSED") {
    showMessage("请先暂停TEST，再执行重置", true);
    return;
  }
  if (!window.confirm("重置会彻底清空TEST资金、订单、成交、持仓、盈亏、结算和配置。此操作无法恢复，继续吗？")) return;
  if (!window.confirm("最后确认：确定将TEST恢复为100U总资金、每单1U和默认筛选条件吗？")) return;
  const button = $("#reset-test");
  ui.controlPending = true;
  setButtonPending(button, true, "重置中");
  try {
    await api("/api/test/reset", {
      method: "POST",
      body: JSON.stringify({
        confirmation: "RESET TEST",
        finalConfirmation: "RESET TEST AGAIN",
      }),
    });
    recordMutation();
    ui.visibleCandidateCount = 20;
    ui.configDirty = false;
    showMessage("TEST已彻底重置，并保持暂停状态");
    await loadDashboard();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    ui.controlPending = false;
    setButtonPending(button, false);
    renderRunControls();
  }
});

$("#live-mode").addEventListener("click", () => {
  $("#live-lock").hidden = false;
  showMessage("LIVE仍然锁定，当前继续使用TEST");
});

$("#test-mode").addEventListener("click", () => {
  $("#live-lock").hidden = true;
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-sort]");
  if (!button || !ui.preferences) return;
  const direction = button.dataset.sort;
  if (direction === ui.preferences.candidateSortDirection) return;
  document.querySelectorAll("[data-sort]").forEach((item) => { item.disabled = true; });
  updateSortButtons(direction);
  try {
    const response = await api("/api/test/preferences", {
      method: "PUT",
      body: JSON.stringify(savedPreferencePayload({ candidateSortDirection: direction })),
    });
    recordMutation();
    ui.preferences = response.preferences;
    ui.visibleCandidateCount = 20;
    showMessage(direction === "ASC" ? "已按市场进度正序排列" : "已按市场进度倒序排列");
    await loadDashboard();
  } catch (error) {
    updateSortButtons(ui.preferences.candidateSortDirection);
    showMessage(error.message, true);
  } finally {
    document.querySelectorAll("[data-sort]").forEach((item) => { item.disabled = false; });
  }
});

$("#load-more").addEventListener("click", async () => {
  ui.visibleCandidateCount = Math.min(ui.candidateCount, ui.visibleCandidateCount + 20);
  await loadDashboard();
});

void loadDashboard();
window.setInterval(() => {
  void loadDashboard({ silent: true });
}, 500);
