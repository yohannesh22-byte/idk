const state = {
  csrfToken: "",
  user: null,
  ownerUnlocked: false,
  ownerUnlockedUntil: 0,
  scanner: null,
  scanning: false,
  mode: "sale",
  pendingBarcode: "",
  editItemId: null,
  inventory: []
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function showToast(message, type = "ok") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $("#toast-root").appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (state.csrfToken && options.method && options.method !== "GET") {
    headers.set("X-CSRF-Token", state.csrfToken);
  }

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin"
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    if (response.status === 401) {
      showLogin();
    }
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("inventory-theme", theme);
}

function showLogin() {
  state.user = null;
  state.ownerUnlocked = false;
  state.csrfToken = "";
  stopScanner();
  $("#login-screen").classList.remove("hidden");
  $("#app-screen").classList.add("hidden");
}

function showApp() {
  $("#login-screen").classList.add("hidden");
  $("#app-screen").classList.remove("hidden");
  renderChrome();
  showView("scanner");
}

function renderChrome() {
  const isOwner = state.user?.role === "owner";
  state.ownerUnlocked = Boolean(isOwner && state.ownerUnlockedUntil > Date.now());

  $("#session-title").textContent = state.ownerUnlocked ? "Owner Console" : "Scanner";
  $("#role-chip").textContent = state.ownerUnlocked ? "Owner Unlocked" : state.user?.role === "owner" ? "Owner Locked" : "Worker";
  $("#owner-nav").classList.toggle("hidden", !isOwner);
  $("#unlock-tab").classList.toggle("hidden", !isOwner || state.ownerUnlocked);
  $("#dashboard-tab").classList.toggle("hidden", !state.ownerUnlocked);
  $("#logs-tab").classList.toggle("hidden", !state.ownerUnlocked);
  $("#mode-switch").classList.toggle("hidden", !state.ownerUnlocked);

  if (!state.ownerUnlocked && state.mode === "register") {
    setMode("sale");
  }
}

function setMode(mode) {
  state.mode = mode;
  $("#sale-mode-button").classList.toggle("active", mode === "sale");
  $("#register-mode-button").classList.toggle("active", mode === "register");
  $("#scanner-heading").textContent = mode === "register" ? "Add / Register Mode" : "Checkout / Sale Mode";
  setResult("Ready", mode === "register" ? "Scan a new barcode to register product details." : "Scan a barcode to sell one unit.");
}

function setResult(title, detail) {
  $("#result-title").textContent = title;
  $("#result-detail").textContent = detail;
}

async function showView(name) {
  await stopScanner();
  $$(".view").forEach((view) => view.classList.remove("active"));
  $$(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $(`#${name}-view`).classList.add("active");

  if (name === "dashboard") {
    await loadInventory();
  }

  if (name === "logs") {
    await loadLogs();
  }
}

async function startScanner() {
  if (!window.Html5Qrcode) {
    showToast("Scanner library failed to load.", "error");
    return;
  }

  try {
    if (!state.scanner) {
      const formats = window.Html5QrcodeSupportedFormats ? [
        Html5QrcodeSupportedFormats.QR_CODE,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E
      ] : undefined;

      state.scanner = formats ? new Html5Qrcode("reader", { formatsToSupport: formats }) : new Html5Qrcode("reader");
    }

    const config = {
      fps: 10,
      qrbox: (width, height) => {
        const edge = Math.floor(Math.min(width, height) * 0.72);
        return { width: Math.max(edge, 220), height: Math.max(Math.floor(edge * 0.62), 140) };
      },
      aspectRatio: 1.777778
    };

    await state.scanner.start({ facingMode: "environment" }, config, onScanSuccess);
    state.scanning = true;
    $("#start-scan-button").disabled = true;
    $("#stop-scan-button").disabled = false;
    setResult("Scanning", "Point the camera at a barcode or QR code.");
  } catch (error) {
    showToast(error.message || "Unable to start camera.", "error");
    $("#start-scan-button").disabled = false;
    $("#stop-scan-button").disabled = true;
  }
}

async function stopScanner() {
  if (!state.scanner || !state.scanning) {
    $("#start-scan-button").disabled = false;
    $("#stop-scan-button").disabled = true;
    return;
  }

  try {
    await state.scanner.stop();
    await state.scanner.clear();
  } catch {}

  state.scanning = false;
  $("#start-scan-button").disabled = false;
  $("#stop-scan-button").disabled = true;
}

async function onScanSuccess(decodedText) {
  const barcode = decodedText.trim();
  if (!barcode) {
    return;
  }

  await stopScanner();

  if (state.mode === "register") {
    state.pendingBarcode = barcode;
    $("#register-barcode-title").textContent = barcode;
    $("#register-product-name").value = "";
    $("#register-stock").value = "0";
    $("#register-description").value = "";
    $("#register-modal").showModal();
    setResult("Barcode captured", barcode);
    return;
  }

  await processSale(barcode);
}

async function processSale(barcode) {
  try {
    setResult("Processing sale", barcode);
    const data = await api("/api/scan/sale", {
      method: "POST",
      body: JSON.stringify({ barcode })
    });
    setResult("Sale Recorded", `${data.item.productName} sold. Remaining stock: ${data.item.quantity}.`);
    showToast("Sale saved and SMS alert sent.");
  } catch (error) {
    setResult("Sale Failed", error.message);
    showToast(error.message, "error");
  }
}

async function loadInventory() {
  try {
    const data = await api("/api/owner/inventory", { method: "GET" });
    state.inventory = data.items;
    renderInventory();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function statusLabel(status) {
  if (status === "out") {
    return "Out of Stock";
  }
  if (status === "low") {
    return "Low Stock";
  }
  return "In Stock";
}

function renderInventory() {
  const body = $("#inventory-body");

  if (!state.inventory.length) {
    body.innerHTML = `<tr><td colspan="6">No inventory registered.</td></tr>`;
    return;
  }

  body.innerHTML = state.inventory.map((item) => `
    <tr>
      <td><strong>${escapeHtml(item.productName)}</strong></td>
      <td>${escapeHtml(item.barcode)}</td>
      <td>${item.quantity}</td>
      <td><span class="status ${item.status}">${statusLabel(item.status)}</span></td>
      <td>${escapeHtml(item.description)}</td>
      <td>
        <div class="row-actions">
          <button class="secondary-button" type="button" data-edit="${item.id}">Edit</button>
          <button class="ghost-button" type="button" data-delete="${item.id}">Delete</button>
        </div>
      </td>
    </tr>
  `).join("");
}

async function loadLogs() {
  try {
    const data = await api("/api/owner/logs", { method: "GET" });
    const list = $("#logs-list");

    if (!data.logs.length) {
      list.innerHTML = `<div class="log-item"><strong>No logs yet</strong><span>Activity will appear here.</span></div>`;
      return;
    }

    list.innerHTML = data.logs.map((log) => `
      <div class="log-item">
        <strong>${escapeHtml(log.action.replaceAll("_", " "))}</strong>
        <span>${escapeHtml(log.createdAt)} by ${escapeHtml(log.username)}</span>
        <span>${escapeHtml(log.productName || log.barcode || "System")} ${Number.isInteger(log.quantityAfter) ? `-> ${log.quantityAfter}` : ""}</span>
      </div>
    `).join("");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function openEditModal(id) {
  const item = state.inventory.find((entry) => entry.id === id);
  if (!item) {
    return;
  }

  state.editItemId = id;
  $("#edit-barcode-title").textContent = item.barcode;
  $("#edit-product-name").value = item.productName;
  $("#edit-stock").value = String(item.quantity);
  $("#edit-description").value = item.description;
  $("#edit-modal").showModal();
}

async function deleteItem(id) {
  const item = state.inventory.find((entry) => entry.id === id);
  if (!item || !confirm(`Delete ${item.productName}?`)) {
    return;
  }

  try {
    await api(`/api/owner/inventory/${id}`, { method: "DELETE" });
    showToast("Item deleted.");
    await loadInventory();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function bindEvents() {
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: $("#login-username").value,
          password: $("#login-password").value
        })
      });

      state.user = data.user;
      state.csrfToken = data.csrfToken;
      state.ownerUnlockedUntil = data.ownerUnlockedUntil;
      $("#login-password").value = "";
      showApp();
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  $("#logout-button").addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {}
    showLogin();
  });

  $("#theme-toggle").addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });

  $("#start-scan-button").addEventListener("click", startScanner);
  $("#stop-scan-button").addEventListener("click", stopScanner);
  $("#sale-mode-button").addEventListener("click", () => setMode("sale"));
  $("#register-mode-button").addEventListener("click", () => setMode("register"));

  $$("#owner-nav .tab-button").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });

  $("#pin-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const data = await api("/api/auth/owner-unlock", {
        method: "POST",
        body: JSON.stringify({ pin: $("#owner-pin").value })
      });

      state.user = data.user;
      state.csrfToken = data.csrfToken;
      state.ownerUnlockedUntil = data.ownerUnlockedUntil;
      $("#owner-pin").value = "";
      renderChrome();
      await showView("dashboard");
      showToast("Owner dashboard unlocked.");
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  $("#register-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await api("/api/scan/register", {
        method: "POST",
        body: JSON.stringify({
          barcode: state.pendingBarcode,
          productName: $("#register-product-name").value,
          initialStock: Number($("#register-stock").value),
          description: $("#register-description").value
        })
      });

      $("#register-modal").close();
      showToast("Product registered.");
      setResult("Product Registered", state.pendingBarcode);
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  $("#edit-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await api(`/api/owner/inventory/${state.editItemId}`, {
        method: "PUT",
        body: JSON.stringify({
          productName: $("#edit-product-name").value,
          quantity: Number($("#edit-stock").value),
          description: $("#edit-description").value
        })
      });

      $("#edit-modal").close();
      showToast("Product updated.");
      await loadInventory();
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  $("#inventory-body").addEventListener("click", (event) => {
    const editId = event.target.dataset.edit;
    const deleteId = event.target.dataset.delete;

    if (editId) {
      openEditModal(Number(editId));
    }

    if (deleteId) {
      deleteItem(Number(deleteId));
    }
  });

  $("#refresh-inventory-button").addEventListener("click", loadInventory);
  $("#refresh-logs-button").addEventListener("click", loadLogs);
}

async function boot() {
  setTheme(localStorage.getItem("inventory-theme") || "dark");
  bindEvents();
  setMode("sale");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  try {
    const data = await api("/api/auth/me", { method: "GET" });
    state.user = data.user;
    state.csrfToken = data.csrfToken;
    state.ownerUnlockedUntil = data.ownerUnlockedUntil;
    showApp();
  } catch {
    showLogin();
  }
}

boot();
