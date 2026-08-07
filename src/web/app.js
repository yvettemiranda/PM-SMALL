const $ = (selector) => document.querySelector(selector);

const ui = {
  dashboard: null,
  preferences: null,
  strategyStatus: "STOPPED",
  candidates: [],
  candidateCount: 0,
  visibleCandidateCount: 20,
  positionsExpanded: false,
  configDirty: false,
  loading: false,
  reloadRequested: false,
  mutationVersion: 0,
  controlPending: false,
  messageTimer: null,
};

const POSITION_PREVIEW_LIMIT = 20;
const CATEGORY_LABELS_ZH = {
  Politics: "政治",
  Sports: "体育",
  Crypto: "加密",
  Esports: "电竞",
  Iran: "伊朗",
  Finance: "财务",
  Geopolitics: "地缘政治",
  Tech: "科技",
  Culture: "文化",
  Economy: "经济",
  Weather: "天气",
  Mentions: "提及",
  Elections: "选举",
  Art: "艺术",
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

function currentPositions(positions = []) {
  return positions.filter((position) => Number(position.quantity) > 0);
}

function renderPortfolio(portfolio, positions = []) {
  setMoneyValue("#total-funds", portfolio?.totalFunds);
  setMoneyValue("#position-value", portfolio?.positionValue);
  const positionCount = currentPositions(positions).length;
  const count = $("#portfolio-position-count");
  count.textContent = `${formatCount(positionCount)}单`;
  count.dataset.tone = "neutral";
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
  const capitalEditable = ui.dashboard?.capitalEditable === true;
  capital.disabled = !capitalEditable;
  capital.title = capitalEditable
    ? ""
    : running
      ? "修改总模拟资金前请先暂停TEST"
      : "总模拟资金仅能在暂停且没有交易记录时修改；如已有记录请先重置TEST";
  const reset = $("#reset-test");
  reset.disabled = !paused || ui.controlPending;
  reset.title = paused ? "" : "重置前必须先暂停TEST";
}

function renderPositions(positions = []) {
  const current = currentPositions(positions);
  if (current.length <= POSITION_PREVIEW_LIMIT) ui.positionsExpanded = false;
  const visible = ui.positionsExpanded
    ? current
    : current.slice(0, POSITION_PREVIEW_LIMIT);
  $("#position-count").textContent = `${formatCount(current.length)}个`;
  const controls = $("#position-list-controls");
  const toggle = $("#toggle-positions");
  controls.hidden = current.length <= POSITION_PREVIEW_LIMIT;
  $("#position-display-count").textContent =
    `当前显示 ${formatCount(visible.length)} / ${formatCount(current.length)}`;
  toggle.textContent = ui.positionsExpanded
    ? "收起至前20个"
    : `展开其余${formatCount(current.length - POSITION_PREVIEW_LIMIT)}个`;
  toggle.setAttribute("aria-expanded", String(ui.positionsExpanded));
  $("#positions").innerHTML = visible.length
    ? visible
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
          const currentSellPrice = formatCurrentSellPrice(position);
          return `<article class="position-row">
            <div class="row-heading">
              <div class="market-copy">${marketTitleMarkup(position)}${eventTitle}</div>
              <div class="outcome-badge"><small>买入结果</small><strong>${escapeHtml(position.direction || "—")}</strong></div>
            </div>
            <div class="quote-grid position-quotes">
              <div><span>实际买入</span><strong>${formatCents(position.averageBuyPrice)}</strong></div>
              <div><span>当前可卖</span><strong>${currentSellPrice}</strong></div>
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

function formatCurrentSellPrice(position) {
  if (position.currentSellPriceStatus === "READY") {
    return formatCents(position.currentSellPrice);
  }
  return escapeHtml({
    NO_BID: "暂无买盘",
    NOT_READY: "行情未就绪",
    RECONNECTING: "行情重连中",
    DISCONNECTED: "行情已断开",
  }[position.currentSellPriceStatus] || "行情未就绪");
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
          const labels = Array.isArray(candidate.categoryLabels)
            ? candidate.categoryLabels.slice(0, 2)
            : candidate.category
              ? [candidate.category]
              : [];
          const category = labels
            .map((label) => `<span class="meta-pill">${escapeHtml(label)}</span>`)
            .join("");
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

function renderScanStatus(status) {
  const element = $("#scan-refresh-state");
  const diagnostics = status?.diagnostics;
  element.classList.toggle("is-refreshing", status?.scanning === true);
  element.classList.toggle("is-error", Boolean(status?.lastError));

  if (status?.scanning) {
    element.textContent = "扫描中";
    return;
  }

  if (status?.lastError) {
    element.textContent = `扫描失败，已保留上次结果 · ${formatClock(diagnostics?.completedAt)}`;
    element.title = status.lastError;
    return;
  }

  element.title = "";
  if (status?.lastScanAt) {
    element.textContent = `扫描完成 · ${formatClock(status.lastScanAt)}`;
    return;
  }
  element.textContent = "等待首次扫描";
}

function availableCategories(preferences) {
  const scanned = ui.dashboard?.marketScan?.diagnostics?.availableCategories ?? [];
  const categories = new Map();
  for (const item of scanned) {
    const category = typeof item === "string" ? { id: item, label: item } : item;
    if (category?.id) categories.set(category.id, { id: category.id, label: category.label || category.id });
  }
  return Array.from(categories.values());
}

function categoryDisplayLabel(category) {
  return CATEGORY_LABELS_ZH[category.label] || category.label;
}

function renderCategories(preferences) {
  const categories = availableCategories(preferences);
  const selectedIds = preferences.selectedCategoryIds ?? preferences.selectedCategories ?? [];
  const all = preferences.allCategories;
  $("#all-categories").checked = all;
  $("#category-options").innerHTML = categories
    .map((category) => `<label class="category-chip">
      <input type="checkbox" data-category-id="${escapeHtml(category.id)}" ${all || selectedIds.includes(category.id) ? "checked" : ""} />
      <span>${escapeHtml(categoryDisplayLabel(category))}</span>
    </label>`)
    .join("");
  $("#category-note").textContent = categories.length
    ? all
      ? `已全选 Polymarket 首页的 ${categories.length} 个栏目；新栏目会自动纳入。`
      : `已选择 ${selectedIds.length} / ${categories.length} 个首页栏目。`
    : "正在同步 Polymarket 首页栏目。";
}

function renderPreferences(preferences, strategy, force = false) {
  if (ui.configDirty && !force) return;
  $("#binary-market").checked = preferences.resultCounts.includes(2);
  $("#ternary-market").checked = preferences.resultCounts.includes(3);
  $("#max-buy-price").value = String(preferences.maxBuyPriceCents);
  $("#bid-ask-ratio").value = String(preferences.minBidAskRatioPercent);
  $("#bid-ask-ratio-value").textContent = String(preferences.minBidAskRatioPercent);
  $("#bid-ask-ratio").setAttribute("aria-valuetext", `至少${preferences.minBidAskRatioPercent}%`);
  $("#market-progress-filter").value = String(preferences.maxMarketProgressPercent);
  $("#market-progress-value").textContent = String(preferences.maxMarketProgressPercent);
  $("#market-progress-filter").setAttribute("aria-valuetext", `不超过${preferences.maxMarketProgressPercent}%`);
  $("#min-market-duration").value = String(preferences.minMarketDurationDays);
  $("#max-market-duration").value = String(preferences.maxMarketDurationDays);
  $("#min-duration-value").textContent = String(preferences.minMarketDurationDays);
  $("#max-duration-value").textContent = String(preferences.maxMarketDurationDays);
  $("#initial-capital").value = Number(strategy.initialCapital).toFixed(2);
  $("#order-amount").value = Number(preferences.orderAmount).toFixed(2);
  renderCategories(preferences);
  updateSortToggle(preferences.candidateSortDirection);
  renderRunControls();
}

function updateSortToggle(direction) {
  const button = $("#sort-toggle");
  const ascending = direction === "ASC";
  button.dataset.nextSort = ascending ? "DESC" : "ASC";
  button.querySelector("strong").textContent = ascending ? "↑" : "↓";
  button.setAttribute(
    "aria-label",
    ascending
      ? "当前按市场进度正序，点击切换为倒序"
      : "当前按市场进度倒序，点击切换为正序",
  );
}

function applyDashboard(dashboard) {
  ui.dashboard = dashboard;
  ui.preferences = dashboard.preferences;
  ui.strategyStatus = dashboard.strategy.status;
  ui.candidates = dashboard.marketScan.candidates ?? [];
  ui.candidateCount = dashboard.marketScan.candidateCount ?? ui.candidates.length;
  renderRunControls();
  renderPortfolio(dashboard.portfolio, dashboard.positions);
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
  return Array.from(document.querySelectorAll("[data-category-id]:checked")).map(
    (input) => input.dataset.categoryId,
  );
}

function collectConfigPayload() {
  const resultCounts = [];
  if ($("#binary-market").checked) resultCounts.push(2);
  if ($("#ternary-market").checked) resultCounts.push(3);
  if (resultCounts.length === 0) throw new Error("请至少选择一种市场类型");

  const allCategories = $("#all-categories").checked;
  const selectedCategoryIds = selectedCategoriesFromForm();
  if (!allCategories && selectedCategoryIds.length === 0) {
    throw new Error("请选择至少一个市场类别，或选择全部符合条件");
  }

  const maxBuyPriceCents = Number($("#max-buy-price").value);
  const minMarketDurationDays = Number($("#min-market-duration").value);
  const maxMarketDurationDays = Number($("#max-market-duration").value);
  const initialCapital = Number($("#initial-capital").value);
  const orderAmount = Number($("#order-amount").value);
  const minBidAskRatioPercent = Number($("#bid-ask-ratio").value);
  const maxMarketProgressPercent = Number($("#market-progress-filter").value);
  if (!Number.isInteger(maxBuyPriceCents) || maxBuyPriceCents < 1 || maxBuyPriceCents > 3) {
    throw new Error("最高买入价必须是1至3之间的整数美分");
  }
  if (!Number.isInteger(minMarketDurationDays) || minMarketDurationDays < 1 || minMarketDurationDays > 365) {
    throw new Error("最短市场总时长必须是1至365天之间的整数");
  }
  if (!Number.isInteger(maxMarketDurationDays) || maxMarketDurationDays < 1 || maxMarketDurationDays > 365) {
    throw new Error("最长市场总时长必须是1至365天之间的整数");
  }
  if (minMarketDurationDays > maxMarketDurationDays) {
    throw new Error("最短市场总时长不能超过最长市场总时长");
  }
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new Error("总模拟资金必须大于0");
  if (!Number.isFinite(orderAmount) || orderAmount <= 0) throw new Error("每单使用金额必须大于0");
  if (orderAmount > initialCapital) throw new Error("每单使用金额不能超过总模拟资金");
  if (!Number.isInteger(minBidAskRatioPercent) || minBidAskRatioPercent < 1 || minBidAskRatioPercent > 100) {
    throw new Error("最低买卖盘比例必须是1至100之间的整数");
  }
  if (!Number.isInteger(maxMarketProgressPercent) || maxMarketProgressPercent < 1 || maxMarketProgressPercent > 100) {
    throw new Error("生命周期进度必须是1至100之间的整数");
  }

  return {
    resultCounts,
    allCategories,
    selectedCategoryIds,
    maxBuyPriceCents,
    minMarketDurationDays,
    maxMarketDurationDays,
    candidateSortDirection: ui.preferences.candidateSortDirection,
    minBidAskRatioPercent,
    maxMarketProgressPercent,
    initialCapital,
    orderAmount,
  };
}

function savedPreferencePayload(overrides = {}) {
  return {
    resultCounts: ui.preferences.resultCounts,
    allCategories: ui.preferences.allCategories,
    selectedCategoryIds: ui.preferences.selectedCategoryIds ?? ui.preferences.selectedCategories,
    maxBuyPriceCents: ui.preferences.maxBuyPriceCents,
    minMarketDurationDays: ui.preferences.minMarketDurationDays,
    maxMarketDurationDays: ui.preferences.maxMarketDurationDays,
    candidateSortDirection: ui.preferences.candidateSortDirection,
    minBidAskRatioPercent: ui.preferences.minBidAskRatioPercent,
    maxMarketProgressPercent: ui.preferences.maxMarketProgressPercent,
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
  document.querySelectorAll("[data-category-id]").forEach((input) => {
    input.checked = $("#all-categories").checked;
  });
});

$("#category-options").addEventListener("change", () => {
  const options = Array.from(document.querySelectorAll("[data-category-id]"));
  $("#all-categories").checked =
    options.length > 0 && options.every((input) => input.checked);
});

$("#min-market-duration").addEventListener("input", (event) => {
  $("#min-duration-value").textContent = event.target.value || "—";
});

$("#max-market-duration").addEventListener("input", (event) => {
  $("#max-duration-value").textContent = event.target.value || "—";
});

$("#bid-ask-ratio").addEventListener("input", (event) => {
  $("#bid-ask-ratio-value").textContent = event.target.value;
  event.target.setAttribute("aria-valuetext", `至少${event.target.value}%`);
});

$("#market-progress-filter").addEventListener("input", (event) => {
  $("#market-progress-value").textContent = event.target.value;
  event.target.setAttribute("aria-valuetext", `不超过${event.target.value}%`);
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
      ui.dashboard.capitalEditable = response.capitalEditable;
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

$("#sort-toggle").addEventListener("click", async () => {
  const button = $("#sort-toggle");
  if (!ui.preferences || button.disabled) return;
  const direction = button.dataset.nextSort;
  button.disabled = true;
  updateSortToggle(direction);
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
    updateSortToggle(ui.preferences.candidateSortDirection);
    showMessage(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#toggle-positions").addEventListener("click", () => {
  ui.positionsExpanded = !ui.positionsExpanded;
  renderPositions(ui.dashboard?.positions ?? []);
});

$("#load-more").addEventListener("click", async () => {
  ui.visibleCandidateCount = Math.min(ui.candidateCount, ui.visibleCandidateCount + 20);
  await loadDashboard();
});

void loadDashboard();
window.setInterval(() => {
  void loadDashboard({ silent: true });
}, 500);
