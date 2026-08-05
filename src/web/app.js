const $ = (selector) => document.querySelector(selector);

const ui = {
  candidates: [],
  selectedCandidateCount: 0,
  sortDirection: "asc",
  visibleCandidateCount: 20,
  durationOptions: [1, 7, 14, 30, 60, 90, 120, 180, 360, 365],
  messageTimer: null,
  loading: false,
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
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

function renderPositions(positions) {
  const currentPositions = positions.filter(
    (position) => Number(position.quantity) > 0 && position.cycleClosedAt === null,
  );
  $("#position-count").textContent = `${currentPositions.length}个`;
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
    : '<p class="empty-state">暂无当前持仓</p>';
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
  $("#selection-count").textContent = `已选${ui.selectedCandidateCount.toLocaleString("zh-CN")} / ${sorted.length.toLocaleString("zh-CN")}`;
  $("#display-count").textContent = `当前显示${visible.length.toLocaleString("zh-CN")} / ${sorted.length.toLocaleString("zh-CN")}`;
  $("#load-more").disabled = visible.length >= sorted.length;
  $("#load-more").textContent = visible.length >= sorted.length ? "已全部显示" : "再显示20个";

  $("#candidates").innerHTML = visible.length
    ? visible
        .map(
          (candidate) => `<article class="market-row" data-market-token="${escapeHtml(candidate.tokenId)}">
            <input
              type="checkbox"
              data-candidate-token="${escapeHtml(candidate.tokenId)}"
              aria-label="允许TEST交易：${escapeHtml(candidate.marketQuestion)}—${escapeHtml(candidate.direction)}"
              ${candidate.selected ? "checked" : ""}
            />
            <div>
              ${marketTitleMarkup(candidate)}
              <span class="mobile-market-detail">结果 ${escapeHtml(candidate.direction)}</span>
            </div>
            <span class="market-outcome">${escapeHtml(candidate.direction)}</span>
            <strong class="market-price">${formatCents(candidate.makerBuyPrice)}</strong>
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
  $("#duration-marks").innerHTML = ui.durationOptions
    .map((duration) => `<span>${duration}</span>`)
    .join("");
}

async function loadAll() {
  if (ui.loading) return;
  ui.loading = true;
  try {
    const [status, candidates, positions, preferences] = await Promise.all([
      api("/api/status"),
      api("/api/candidates"),
      api("/api/paper/positions"),
      api("/api/paper/preferences"),
    ]);
    renderPortfolio(status.portfolio);
    renderPositions(positions.positions);
    ui.candidates = candidates.candidates;
    ui.selectedCandidateCount = candidates.selectedCandidateCount;
    ui.visibleCandidateCount = Math.max(
      20,
      Math.min(ui.visibleCandidateCount, Math.max(20, ui.candidates.length)),
    );
    renderCandidates();
    renderPreferences(preferences.preferences);
  } finally {
    ui.loading = false;
  }
}

function setConfigOpen(open) {
  $("#config-panel").hidden = !open;
  $("#config-toggle").setAttribute("aria-expanded", String(open));
}

$("#config-toggle").addEventListener("click", () => {
  setConfigOpen($("#config-panel").hidden);
});

$("#config-close").addEventListener("click", () => setConfigOpen(false));

$("#market-duration").addEventListener("input", (event) => {
  const index = Number(event.target.value);
  $("#duration-value").textContent = String(ui.durationOptions[index]);
});

$("#config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  if (submit) submit.disabled = true;
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
      }),
    });
    renderPreferences(response.preferences);
    ui.visibleCandidateCount = 20;
    setConfigOpen(false);
    showMessage("配置已保存，正在重新扫描市场");
    await loadAll();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    if (submit) submit.disabled = false;
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
  input.disabled = true;
  try {
    await api("/api/paper/candidate-selection", {
      method: "PUT",
      body: JSON.stringify({
        action: "set",
        tokenId: candidate.tokenId,
        selected: input.checked,
      }),
    });
    candidate.selected = input.checked;
    ui.selectedCandidateCount = ui.candidates.filter(
      (item) => item.selected,
    ).length;
    renderCandidates();
  } catch (error) {
    input.checked = !input.checked;
    input.disabled = false;
    showMessage(error.message, true);
  }
});

async function setAllCandidates(action) {
  try {
    await api("/api/paper/candidate-selection", {
      method: "PUT",
      body: JSON.stringify({ action }),
    });
    const selected = action === "all";
    ui.candidates.forEach((candidate) => {
      candidate.selected = selected;
    });
    ui.selectedCandidateCount = selected ? ui.candidates.length : 0;
    renderCandidates();
    showMessage(selected ? "已选择全部扫描市场" : "已清空TEST交易范围");
  } catch (error) {
    showMessage(error.message, true);
  }
}

$("#select-all").addEventListener("click", () => setAllCandidates("all"));
$("#clear-all").addEventListener("click", () => setAllCandidates("none"));

$("#load-more").addEventListener("click", () => {
  ui.visibleCandidateCount = Math.min(
    ui.candidates.length,
    ui.visibleCandidateCount + 20,
  );
  renderCandidates();
});

loadAll().catch((error) => showMessage(error.message, true));
window.setInterval(() => {
  loadAll().catch(() => {});
}, 10_000);
