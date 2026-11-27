const state = {
  app: null,
  pendingConfirm: null,
};

const $ = (id) => document.getElementById(id);

function showToast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  $("toast-container").appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith("/api/auth/")) {
    showLogin();
    throw new Error(data.error || "Session expired. Please sign in again.");
  }
  if (!res.ok) {
    const errMsg = Array.isArray(data.errors) ? data.errors.join(" | ") : (data.error || `Request failed (${res.status})`);
    const err = new Error(errMsg);
    err.data = data;
    throw err;
  }
  return data;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showLogin(authStatus = null) {
  $("app-view").classList.add("hidden");
  $("login-view").classList.remove("hidden");

  const params = new URLSearchParams(window.location.search);
  const authError = params.get("auth_error");
  if (authError) {
    const messages = {
      invalid_state: "Discord OAuth state expired or was invalid. Try again.",
      token_exchange_failed: "Discord OAuth token exchange failed.",
      user_fetch_failed: "Could not read your Discord profile.",
      not_admin: "Your Discord user ID is not listed in ADMINS.",
      oauth_exception: "Discord OAuth login failed.",
    };
    $("login-error").textContent = messages[authError] || "Authentication failed.";
    $("login-error").classList.remove("hidden");
    window.history.replaceState({}, "", "/");
  }

  if (authStatus?.authMethods?.discordOAuth) {
    $("discord-oauth-wrap").classList.remove("hidden");
  }
  if (authStatus?.authMethods?.usingEphemeralToken) {
    $("ephemeral-hint").classList.remove("hidden");
  }
}

function showDashboard() {
  $("login-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
}

function resolveChannelLabel(channelId) {
  const ch = state.app?.bot?.channels?.find((c) => c.id === channelId);
  return ch ? `#${ch.name} (${ch.guildName})` : channelId;
}

function populateChannelSelects() {
  const channels = state.app?.bot?.channels || [];
  for (const [selectId, inputId] of [
    ["disable-channel-select", "disable-channel-input"],
    ["sched-channel-select", "sched-channel-input"],
  ]) {
    const sel = $(selectId);
    const inp = $(inputId);
    if (channels.length === 0) {
      sel.classList.add("hidden");
      continue;
    }
    sel.classList.remove("hidden");
    sel.innerHTML = `<option value="">Pick a Discord channel (or type ID)...</option>` +
      channels.map((c) => `<option value="${escapeHtml(c.id)}">#${escapeHtml(c.name)} — ${escapeHtml(c.guildName)}</option>`).join("");
    sel.onchange = () => {
      if (sel.value) inp.value = sel.value;
    };
  }
}

function renderTopbar() {
  const { bot } = state.app;
  const pill = $("bot-status-pill");
  if (bot.ready) {
    pill.textContent = `Online: ${bot.tag}`;
    pill.className = "pill pill-success";
    $("bot-meta").textContent = `${bot.guildCount} server(s) • Web port ${bot.port}`;
  } else {
    pill.textContent = "Bot: Connecting / Offline";
    pill.className = "pill pill-warn";
    $("bot-meta").textContent = `Web port ${bot.port}`;
  }

  const pauseBtn = $("pause-toggle-btn");
  if (bot.paused) {
    pauseBtn.textContent = "▶️ AI: Paused (Resume)";
    pauseBtn.className = "btn btn-sm btn-danger";
  } else {
    pauseBtn.textContent = "⏸️ AI: Active (Pause)";
    pauseBtn.className = "btn btn-sm btn-secondary";
  }
}

function renderOverview() {
  const { config, bot, logging, scheduledTasks } = state.app;
  const te = config.thinking_effort || { mode: "global", global: "medium", local: {} };
  const activeLevels = Object.entries(logging.config.levels || {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "none";
  const cards = [
    {
      title: "Response Mode",
      value: config.response_mode || "smart",
      sub: `Random rate: ${config.random_appear_rate ?? 0.2} • Max history: ${config.max_history ?? 30}`,
    },
    {
      title: "Model & Thinking",
      value: `${config.model_mode || "flash-lite"} (${te.mode || "global"}: ${te.global || "medium"})`,
      sub: `Show thinking: ${config.show_thinking || "off"}`,
    },
    {
      title: "Memory & Greet",
      value: config.temp_memory_enabled !== false ? `Temp Mem ON (${config.temp_memory_ttl_minutes ?? 240}m)` : "Temp Mem OFF",
      sub: `Greet: ${config.greet_new_members !== false ? "ON" : "OFF"} • Feedback: ${config.feedback_system !== false ? "ON" : "OFF"}`,
    },
    {
      title: "Logging & Scheduler",
      value: logging.master ? "Logging ON" : "Logging OFF",
      sub: `Levels: ${activeLevels} • Tasks: ${scheduledTasks.length}`,
    },
  ];

  $("overview-cards").innerHTML = cards.map((c) => `
    <div class="stat-card">
      <div class="stat-title">${escapeHtml(c.title)}</div>
      <div class="stat-value">${escapeHtml(c.value)}</div>
      <div class="stat-sub">${escapeHtml(c.sub)}</div>
    </div>
  `).join("");

  const disabled = config.disabled_channels || [];
  const listEl = $("disabled-channels-list");
  if (disabled.length === 0) {
    listEl.innerHTML = `<span class="muted small">No disabled channels.</span>`;
  } else {
    listEl.innerHTML = disabled.map((id) => `
      <span class="chip">
        <span>${escapeHtml(resolveChannelLabel(id))}</span>
        <button type="button" data-enable-channel="${escapeHtml(id)}" title="Re-enable AI in this channel">✕</button>
      </span>
    `).join("");
    listEl.querySelectorAll("[data-enable-channel]").forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api("/api/channels/enable", {
            method: "POST",
            body: JSON.stringify({ channelId: btn.dataset.enableChannel }),
          });
          showToast("Channel re-enabled.", "success");
          await loadState();
        } catch (err) {
          showToast(err.message, "error");
        }
      };
    });
  }
  populateChannelSelects();
}

function renderFieldInput(sectionKey, field) {
  const id = `sec-${sectionKey}-${field.id}`;
  if (field.type === "select") {
    const opts = (field.options || []).map((opt) =>
      `<option value="${escapeHtml(opt)}" ${String(field.value) === String(opt) ? "selected" : ""}>${escapeHtml(opt)}</option>`
    ).join("");
    return `<select id="${id}" name="${escapeHtml(field.id)}">${opts}</select>`;
  }
  if (field.type === "boolean") {
    const isTrue = String(field.value) === "true";
    return `
      <select id="${id}" name="${escapeHtml(field.id)}">
        <option value="true" ${isTrue ? "selected" : ""}>true (ON)</option>
        <option value="false" ${!isTrue ? "selected" : ""}>false (OFF)</option>
      </select>`;
  }
  if (field.type === "number" || field.type === "integer") {
    const minAttr = field.min !== null ? `min="${field.min}"` : "";
    const maxAttr = field.max !== null ? `max="${field.max}"` : "";
    const stepAttr = field.step !== null ? `step="${field.step}"` : "";
    return `<input id="${id}" name="${escapeHtml(field.id)}" type="number" value="${escapeHtml(field.value)}" ${minAttr} ${maxAttr} ${stepAttr} />`;
  }
  return `<input id="${id}" name="${escapeHtml(field.id)}" type="text" value="${escapeHtml(field.value)}" />`;
}

function renderSections() {
  const container = $("sections-container");
  const formSections = state.app.sections.filter((s) => s.key !== "raw_json");
  container.innerHTML = formSections.map((sec) => `
    <div class="card">
      <div class="card-header">
        <div>
          <h2>${escapeHtml(sec.emoji)} ${escapeHtml(sec.label)}</h2>
          <p class="muted small">${escapeHtml(sec.description)}</p>
        </div>
      </div>
      <div id="sec-err-${escapeHtml(sec.key)}" class="alert alert-error hidden"></div>
      <form class="stack section-form" data-section="${escapeHtml(sec.key)}">
        ${sec.fields.map((f) => `
          <label class="field">
            <span>${escapeHtml(f.label)}</span>
            ${renderFieldInput(sec.key, f)}
            ${f.help ? `<span class="help">${escapeHtml(f.help)}</span>` : ""}
          </label>
        `).join("")}
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Review & Save</button>
        </div>
      </form>
    </div>
  `).join("");

  container.querySelectorAll(".section-form").forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const sectionKey = form.dataset.section;
      const errBox = $(`sec-err-${sectionKey}`);
      errBox.classList.add("hidden");

      const values = {};
      new FormData(form).forEach((val, key) => {
        values[key] = val;
      });
      await previewAndConfirmSection(sectionKey, values, errBox, form.closest(".card").querySelector("h2").textContent);
    };
  });
}

async function previewAndConfirmSection(sectionKey, values, errBox, title) {
  try {
    const res = await api("/api/config/validate", {
      method: "POST",
      body: JSON.stringify({ section: sectionKey, values }),
    });
    if (!res.diffs || res.diffs.length === 0) {
      showToast("No changes detected.", "info");
      return;
    }
    state.pendingConfirm = { section: sectionKey, values };
    $("confirm-modal-title").textContent = `Confirm: ${title}`;
    $("confirm-diff-list").innerHTML = res.diffs.map((d) => `
      <div class="diff-row">
        <div><strong>${escapeHtml(d.key)}</strong></div>
        <div><span class="diff-old">${escapeHtml(d.oldStr)}</span> → <span class="diff-new">${escapeHtml(d.newStr)}</span></div>
      </div>
    `).join("");
    $("confirm-modal").classList.remove("hidden");
  } catch (err) {
    if (errBox) {
      errBox.textContent = err.message;
      errBox.classList.remove("hidden");
    } else {
      showToast(err.message, "error");
    }
  }
}

function renderThinking() {
  const cfg = state.app.config;
  const te = cfg.thinking_effort || { mode: "global", global: "medium", local: {} };
  $("thinking-mode").value = te.mode || "global";
  $("thinking-global").value = te.global || "medium";
  const showVal = cfg.show_thinking === true ? "spoiler" : (!cfg.show_thinking ? "off" : cfg.show_thinking);
  $("thinking-show").value = ["off", "spoiler", "visible", "embed"].includes(showVal) ? showVal : "off";
  $("thinking-window").checked = cfg.thinking_window !== false;

  const entries = Object.entries(te.local || {});
  const listEl = $("thinking-local-list");
  if (entries.length === 0) {
    listEl.innerHTML = `<span class="muted small">No per-model local overrides configured.</span>`;
    return;
  }
  listEl.innerHTML = entries.map(([model, effort]) => `
    <div class="list-row">
      <div><code>${escapeHtml(model)}</code> → <span class="pill pill-muted">${escapeHtml(effort)}</span></div>
      <button type="button" class="btn btn-xs btn-danger" data-remove-local="${escapeHtml(model)}">Remove</button>
    </div>
  `).join("");
  listEl.querySelectorAll("[data-remove-local]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api("/api/thinking", {
          method: "PUT",
          body: JSON.stringify({ removeLocal: btn.dataset.removeLocal }),
        });
        showToast(`Removed override for ${btn.dataset.removeLocal}.`, "success");
        await loadState();
      } catch (err) {
        showToast(err.message, "error");
      }
    };
  });
}

function renderModels() {
  const { config, models } = state.app;
  const compare = config.model_compare || { enabled: false, models: [] };
  $("compare-enabled").checked = Boolean(compare.enabled);

  const cmpEl = $("compare-models-list");
  cmpEl.innerHTML = (compare.models || []).length === 0
    ? `<span class="muted small">No comparison models added.</span>`
    : compare.models.map((m) => `
      <span class="chip">
        <code>${escapeHtml(m)}</code>
        <button type="button" data-remove-compare="${escapeHtml(m)}">✕</button>
      </span>
    `).join("");

  cmpEl.querySelectorAll("[data-remove-compare]").forEach((btn) => {
    btn.onclick = async () => {
      const next = (compare.models || []).filter((m) => m !== btn.dataset.removeCompare);
      await updateCompare({ models: next });
    };
  });

  // Task Categories
  const tasks = config.models || {};
  $("task-categories-list").innerHTML = Object.entries(tasks).map(([cat, list]) => `
    <div class="pool-box">
      <div class="pool-header">
        <strong>${escapeHtml(cat)}</strong>
        <button type="button" class="btn btn-xs btn-ghost" data-delete-cat="${escapeHtml(cat)}">Delete Category</button>
      </div>
      <div class="pool-items">
        ${(list || []).length === 0 ? `<span class="muted small">(empty)</span>` : list.map((item, idx) => `
          <div class="pool-item">
            <span>${idx + 1}. <code>${escapeHtml(item)}</code></span>
            <div class="btn-group">
              <button type="button" class="btn btn-xs btn-secondary" data-task-move="${escapeHtml(cat)}" data-item="${escapeHtml(item)}" data-dir="up">↑</button>
              <button type="button" class="btn btn-xs btn-secondary" data-task-move="${escapeHtml(cat)}" data-item="${escapeHtml(item)}" data-dir="down">↓</button>
              <button type="button" class="btn btn-xs btn-danger" data-task-remove="${escapeHtml(cat)}" data-item="${escapeHtml(item)}">✕</button>
            </div>
          </div>
        `).join("")}
      </div>
      <form class="inline-form compact task-add-form" data-cat="${escapeHtml(cat)}">
        <input type="text" placeholder="Add series or model..." required />
        <button type="submit" class="btn btn-xs btn-primary">Add</button>
      </form>
    </div>
  `).join("");

  // Series Pools
  $("series-pools-list").innerHTML = Object.entries(models || {}).map(([series, list]) => `
    <div class="pool-box">
      <div class="pool-header">
        <strong>${escapeHtml(series)}</strong>
        <button type="button" class="btn btn-xs btn-ghost" data-delete-series="${escapeHtml(series)}">Delete Series</button>
      </div>
      <div class="pool-items">
        ${(list || []).length === 0 ? `<span class="muted small">(empty)</span>` : list.map((model, idx) => `
          <div class="pool-item">
            <span>${idx + 1}. <code>${escapeHtml(model)}</code></span>
            <div class="btn-group">
              <button type="button" class="btn btn-xs btn-secondary" data-series-move="${escapeHtml(series)}" data-model="${escapeHtml(model)}" data-dir="up">↑</button>
              <button type="button" class="btn btn-xs btn-secondary" data-series-move="${escapeHtml(series)}" data-model="${escapeHtml(model)}" data-dir="down">↓</button>
              <button type="button" class="btn btn-xs btn-danger" data-series-remove="${escapeHtml(series)}" data-model="${escapeHtml(model)}">✕</button>
            </div>
          </div>
        `).join("")}
      </div>
      <form class="inline-form compact series-add-form" data-series="${escapeHtml(series)}">
        <input type="text" placeholder="Add model ID..." required />
        <button type="submit" class="btn btn-xs btn-primary">Add</button>
      </form>
    </div>
  `).join("");

  bindModelActions();
}

function bindModelActions() {
  document.querySelectorAll(".task-add-form").forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const input = form.querySelector("input");
      await postModelAction("/api/models/task", { action: "add_item", category: form.dataset.cat, item: input.value.trim() });
    };
  });
  document.querySelectorAll("[data-task-remove]").forEach((btn) => {
    btn.onclick = () => postModelAction("/api/models/task", { action: "remove_item", category: btn.dataset.taskRemove, item: btn.dataset.item });
  });
  document.querySelectorAll("[data-task-move]").forEach((btn) => {
    btn.onclick = () => postModelAction("/api/models/task", { action: "move_item", category: btn.dataset.taskMove, item: btn.dataset.item, direction: btn.dataset.dir });
  });
  document.querySelectorAll("[data-delete-cat]").forEach((btn) => {
    btn.onclick = () => postModelAction("/api/models/task", { action: "delete", category: btn.dataset.deleteCat });
  });

  document.querySelectorAll(".series-add-form").forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const input = form.querySelector("input");
      await postModelAction("/api/models/series", { action: "add_model", series: form.dataset.series, model: input.value.trim() });
    };
  });
  document.querySelectorAll("[data-series-remove]").forEach((btn) => {
    btn.onclick = () => postModelAction("/api/models/series", { action: "remove_model", series: btn.dataset.seriesRemove, model: btn.dataset.model });
  });
  document.querySelectorAll("[data-series-move]").forEach((btn) => {
    btn.onclick = () => postModelAction("/api/models/series", { action: "move_model", series: btn.dataset.seriesMove, model: btn.dataset.model, direction: btn.dataset.dir });
  });
  document.querySelectorAll("[data-delete-series]").forEach((btn) => {
    btn.onclick = () => postModelAction("/api/models/series", { action: "delete", series: btn.dataset.deleteSeries });
  });
}

async function postModelAction(endpoint, payload) {
  try {
    await api(endpoint, { method: "POST", body: JSON.stringify(payload) });
    showToast("Models updated.", "success");
    await loadState();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function updateCompare(patch) {
  try {
    await api("/api/models/compare", { method: "PUT", body: JSON.stringify(patch) });
    showToast("Model comparison updated.", "success");
    await loadState();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function renderLogging() {
  const { master, config, levels, categories, presets } = state.app.logging;
  $("log-master").checked = Boolean(master);
  $("log-console").checked = Boolean(config.console);
  $("log-file").checked = Boolean(config.file);
  $("log-max-mb").value = config.max_file_size_mb ?? 10;
  $("log-raw-chars").value = config.raw_max_chars ?? 0;

  $("log-presets-bar").innerHTML = presets.map((p) => `
    <button type="button" class="btn btn-sm btn-secondary" data-preset="${escapeHtml(p.name)}" title="${escapeHtml(p.description)}">
      Preset: ${escapeHtml(p.name)}
    </button>
  `).join("");
  $("log-presets-bar").querySelectorAll("[data-preset]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api("/api/logging", { method: "PUT", body: JSON.stringify({ preset: btn.dataset.preset }) });
        showToast(`Applied logging preset "${btn.dataset.preset}".`, "success");
        await loadState();
      } catch (err) {
        showToast(err.message, "error");
      }
    };
  });

  $("log-levels-grid").innerHTML = levels.map((lvl) => `
    <label class="checkbox-field">
      <input type="checkbox" data-log-level="${escapeHtml(lvl)}" ${config.levels?.[lvl] ? "checked" : ""} />
      <span>${escapeHtml(lvl)}</span>
    </label>
  `).join("");

  $("log-categories-grid").innerHTML = categories.map((cat) => `
    <label class="checkbox-field">
      <input type="checkbox" data-log-cat="${escapeHtml(cat)}" ${config.categories?.[cat] ? "checked" : ""} />
      <span>${escapeHtml(cat)}</span>
    </label>
  `).join("");

  const catFilter = $("log-filter-category");
  const prevCat = catFilter.value;
  catFilter.innerHTML = `<option value="all">All Categories</option>` +
    categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  if (categories.includes(prevCat)) catFilter.value = prevCat;
}

async function loadLogs() {
  try {
    const lines = $("log-filter-lines").value;
    const level = $("log-filter-level").value;
    const category = $("log-filter-category").value;
    const data = await api(`/api/logs?lines=${encodeURIComponent(lines)}&level=${encodeURIComponent(level)}&category=${encodeURIComponent(category)}`);
    $("log-file-meta").textContent = `${data.logFile} • Showing ${data.lines.length} of ${data.totalMatched} matched line(s)`;
    $("log-viewer").textContent = data.lines.length > 0 ? data.lines.join("\n") : "(no matching log lines)";
  } catch (err) {
    $("log-viewer").textContent = `Failed to load logs: ${err.message}`;
  }
}

function renderSchedule() {
  const tasks = state.app.scheduledTasks || [];
  const listEl = $("schedule-list");
  if (tasks.length === 0) {
    listEl.innerHTML = `<span class="muted small">No scheduled tasks configured.</span>`;
    return;
  }
  listEl.innerHTML = tasks.map((t) => {
    const timing = t.type === "daily"
      ? `Daily at ${String(t.fixed_hour).padStart(2, "0")}:${String(t.fixed_minute ?? 0).padStart(2, "0")} UTC`
      : `Random every ${t.interval_min}–${t.interval_max} min`;
    return `
      <div class="list-row">
        <div>
          <div>
            <code>${escapeHtml(t.id)}</code>
            <span class="pill ${t.enabled ? "pill-success" : "pill-muted"}">${t.enabled ? "Enabled" : "Paused"}</span>
            <strong>${escapeHtml(resolveChannelLabel(t.channel_id))}</strong>
          </div>
          <div class="muted small">${escapeHtml(timing)} — ${escapeHtml(t.prompt)}</div>
        </div>
        <div class="btn-group">
          <button type="button" class="btn btn-sm btn-secondary" data-sched-toggle="${escapeHtml(t.id)}">${t.enabled ? "Pause" : "Enable"}</button>
          <button type="button" class="btn btn-sm btn-danger" data-sched-remove="${escapeHtml(t.id)}">Remove</button>
        </div>
      </div>
    `;
  }).join("");

  listEl.querySelectorAll("[data-sched-toggle]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api("/api/schedule", { method: "POST", body: JSON.stringify({ action: "toggle", id: btn.dataset.schedToggle }) });
        showToast("Task updated.", "success");
        await loadState();
      } catch (err) {
        showToast(err.message, "error");
      }
    };
  });
  listEl.querySelectorAll("[data-sched-remove]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api("/api/schedule", { method: "POST", body: JSON.stringify({ action: "remove", id: btn.dataset.schedRemove }) });
        showToast("Task removed.", "success");
        await loadState();
      } catch (err) {
        showToast(err.message, "error");
      }
    };
  });
}

function renderRawJson() {
  $("raw-json-editor").value = JSON.stringify(state.app.config, null, 2);
  $("raw-errors").classList.add("hidden");
}

function renderAll() {
  renderTopbar();
  renderOverview();
  renderSections();
  renderThinking();
  renderModels();
  renderLogging();
  renderSchedule();
  renderRawJson();
}

async function loadState() {
  state.app = await api("/api/state");
  renderAll();
}

function wireEvents() {
  // Tabs
  $("nav-tabs").querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      $("nav-tabs").querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
      $(`tab-${tab.dataset.tab}`).classList.remove("hidden");
      if (tab.dataset.tab === "logging") loadLogs();
    };
  });

  // Auth
  $("login-form").onsubmit = async (e) => {
    e.preventDefault();
    $("login-error").classList.add("hidden");
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ password: $("login-password").value }),
      });
      $("login-password").value = "";
      showDashboard();
      await loadState();
    } catch (err) {
      $("login-error").textContent = err.message;
      $("login-error").classList.remove("hidden");
    }
  };

  $("logout-btn").onclick = async () => {
    await api("/api/auth/logout", { method: "POST" });
    const status = await api("/api/auth/status");
    showLogin(status);
  };

  $("refresh-all-btn").onclick = async () => {
    await loadState();
    showToast("Refreshed.", "success");
  };

  $("pause-toggle-btn").onclick = async () => {
    try {
      const res = await api("/api/bot/pause", { method: "POST", body: JSON.stringify({}) });
      showToast(res.paused ? "AI paused globally." : "AI resumed.", "info");
      await loadState();
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  // Disable channel
  $("disable-channel-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/channels/disable", {
        method: "POST",
        body: JSON.stringify({ channelId: $("disable-channel-input").value }),
      });
      $("disable-channel-input").value = "";
      showToast("Channel disabled.", "success");
      await loadState();
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  // Confirm modal
  $("confirm-cancel-btn").onclick = () => {
    state.pendingConfirm = null;
    $("confirm-modal").classList.add("hidden");
  };
  $("confirm-save-btn").onclick = async () => {
    if (!state.pendingConfirm) return;
    try {
      const res = await api("/api/config/section", {
        method: "PUT",
        body: JSON.stringify(state.pendingConfirm),
      });
      state.pendingConfirm = null;
      $("confirm-modal").classList.add("hidden");
      state.app = res.state;
      renderAll();
      showToast("Configuration saved to config.json.", "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  // Thinking
  $("thinking-global-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/thinking", {
        method: "PUT",
        body: JSON.stringify({
          mode: $("thinking-mode").value,
          global: $("thinking-global").value,
          show_thinking: $("thinking-show").value,
          thinking_window: $("thinking-window").checked,
        }),
      });
      showToast("Thinking settings saved.", "success");
      await loadState();
    } catch (err) {
      showToast(err.message, "error");
    }
  };
  $("thinking-local-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/thinking", {
        method: "PUT",
        body: JSON.stringify({
          setLocal: {
            model: $("thinking-local-model").value,
            effort: $("thinking-local-effort").value,
          },
        }),
      });
      $("thinking-local-model").value = "";
      showToast("Local model override saved.", "success");
      await loadState();
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  // Models & Compare
  $("compare-enabled").onchange = () => updateCompare({ enabled: $("compare-enabled").checked });
  $("compare-add-form").onsubmit = async (e) => {
    e.preventDefault();
    const val = $("compare-model-input").value.trim();
    if (!val) return;
    const current = state.app.config.model_compare?.models || [];
    $("compare-model-input").value = "";
    await updateCompare({ models: [...current, val] });
  };
  $("create-category-form").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("new-category-name").value.trim();
    if (!name) return;
    $("new-category-name").value = "";
    await postModelAction("/api/models/task", { action: "create", category: name });
  };
  $("create-series-form").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("new-series-name").value.trim();
    if (!name) return;
    $("new-series-name").value = "";
    await postModelAction("/api/models/series", { action: "create", series: name });
  };

  // Logging
  $("logging-form").onsubmit = async (e) => {
    e.preventDefault();
    const levels = {};
    document.querySelectorAll("[data-log-level]").forEach((cb) => {
      levels[cb.dataset.logLevel] = cb.checked;
    });
    const categories = {};
    document.querySelectorAll("[data-log-cat]").forEach((cb) => {
      categories[cb.dataset.logCat] = cb.checked;
    });
    try {
      await api("/api/logging", {
        method: "PUT",
        body: JSON.stringify({
          master: $("log-master").checked,
          console: $("log-console").checked,
          file: $("log-file").checked,
          max_file_size_mb: Number($("log-max-mb").value),
          raw_max_chars: Number($("log-raw-chars").value),
          levels,
          categories,
        }),
      });
      showToast("Logging config saved.", "success");
      await loadState();
    } catch (err) {
      showToast(err.message, "error");
    }
  };
  $("log-reset-btn").onclick = async () => {
    await api("/api/logging", { method: "PUT", body: JSON.stringify({ action: "reset" }) });
    showToast("Logging reset to defaults.", "success");
    await loadState();
  };
  $("log-clear-btn").onclick = async () => {
    await api("/api/logging", { method: "PUT", body: JSON.stringify({ action: "clear_file" }) });
    showToast("Log file cleared.", "success");
    await loadLogs();
  };
  $("refresh-logs-btn").onclick = loadLogs;
  $("log-filter-level").onchange = loadLogs;
  $("log-filter-category").onchange = loadLogs;
  $("log-filter-lines").onchange = loadLogs;

  // Schedule
  $("sched-type").onchange = () => {
    const isDaily = $("sched-type").value === "daily";
    document.querySelectorAll(".sched-daily-only").forEach((el) => el.classList.toggle("hidden", !isDaily));
    document.querySelectorAll(".sched-random-only").forEach((el) => el.classList.toggle("hidden", isDaily));
  };
  $("schedule-add-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/schedule", {
        method: "POST",
        body: JSON.stringify({
          action: "add",
          channelId: $("sched-channel-input").value,
          type: $("sched-type").value,
          intervalMin: Number($("sched-min").value),
          intervalMax: Number($("sched-max").value),
          hour: $("sched-hour").value,
          minute: $("sched-minute").value,
          prompt: $("sched-prompt").value,
        }),
      });
      $("sched-prompt").value = "";
      showToast("Scheduled task created.", "success");
      await loadState();
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  // Raw JSON
  $("raw-format-btn").onclick = () => {
    try {
      const parsed = JSON.parse($("raw-json-editor").value);
      $("raw-json-editor").value = JSON.stringify(parsed, null, 2);
      $("raw-errors").classList.add("hidden");
    } catch (err) {
      $("raw-errors").textContent = `JSON Syntax Error: ${err.message}`;
      $("raw-errors").classList.remove("hidden");
    }
  };
  $("raw-reload-btn").onclick = renderRawJson;
  $("raw-review-btn").onclick = () => {
    $("raw-errors").classList.add("hidden");
    previewAndConfirmSection("raw_json", { raw_json: $("raw-json-editor").value }, $("raw-errors"), "Raw config.json");
  };
}

async function init() {
  wireEvents();
  try {
    const status = await api("/api/auth/status");
    if (status.authenticated) {
      showDashboard();
      await loadState();
    } else {
      showLogin(status);
    }
  } catch (err) {
    showLogin();
    showToast(err.message, "error");
  }
}

init();
