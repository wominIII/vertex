const STORAGE_KEY = "vertex-admin-password";

const loginOverlay = document.querySelector("#loginOverlay");
const appShell = document.querySelector("#appShell");
const loginPasswordInput = document.querySelector("#loginPassword");
const rememberPasswordInput = document.querySelector("#rememberPassword");
const loginBtn = document.querySelector("#loginBtn");
const loginStatus = document.querySelector("#loginStatus");
const sessionHint = document.querySelector("#sessionHint");
const logoutBtn = document.querySelector("#logoutBtn");

const loadBtn = document.querySelector("#loadBtn");
const refreshModelsBtn = document.querySelector("#refreshModelsBtn");
const saveConfigBtn = document.querySelector("#saveConfigBtn");
const importCredentialsBtn = document.querySelector("#importCredentialsBtn");
const changePasswordBtn = document.querySelector("#changePasswordBtn");
const statusBox = document.querySelector("#statusBox");
const modelsBox = document.querySelector("#modelsBox");

const fieldIds = [
  "host",
  "port",
  "location",
  "defaultTemperature",
  "defaultTopP",
  "defaultTopK",
  "defaultMaxOutputTokens",
  "inboundApiKey",
  "logLevel",
  "thoughtsMode",
  "thinkingBudget",
  "maxFetchAttempts",
  "fetchRetryDelayMs",
  "includeThoughts",
  "enableStreaming",
];

let adminPassword = "";

loginBtn.addEventListener("click", login);
logoutBtn.addEventListener("click", logout);
loadBtn.addEventListener("click", loadConfig);
refreshModelsBtn.addEventListener("click", () => loadModels(true));
saveConfigBtn.addEventListener("click", saveConfig);
importCredentialsBtn.addEventListener("click", importCredentials);
changePasswordBtn.addEventListener("click", changePassword);
loginPasswordInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    login();
  }
});

await bootstrap();

async function bootstrap() {
  const savedPassword = localStorage.getItem(STORAGE_KEY) || "";
  if (savedPassword) {
    rememberPasswordInput.checked = true;
    loginPasswordInput.value = savedPassword;
    await login({ silent: true });
    if (!adminPassword) {
      loginStatus.textContent = "已记住的密码失效，请重新输入。";
      localStorage.removeItem(STORAGE_KEY);
      loginPasswordInput.value = "";
    }
  }
}

async function login({ silent = false } = {}) {
  const password = loginPasswordInput.value.trim();
  if (!password) {
    if (!silent) loginStatus.textContent = "请输入控制台密码。";
    return;
  }

  try {
    adminPassword = password;
    const data = await api("/api/admin/config");
    if (rememberPasswordInput.checked) {
      localStorage.setItem(STORAGE_KEY, password);
      sessionHint.textContent = "已记住此浏览器";
    } else {
      localStorage.removeItem(STORAGE_KEY);
      sessionHint.textContent = "当前浏览器会话";
    }

    fillForm(data.config);
    statusBox.textContent = JSON.stringify(data.config, null, 2);
    loginOverlay.classList.add("hidden");
    appShell.classList.remove("hidden");
    loginStatus.textContent = "登录成功";
    await loadModels(false);
  } catch (error) {
    adminPassword = "";
    appShell.classList.add("hidden");
    loginOverlay.classList.remove("hidden");
    loginStatus.textContent = error.message;
    if (!silent) {
      loginPasswordInput.select();
    }
  }
}

function logout() {
  adminPassword = "";
  appShell.classList.add("hidden");
  loginOverlay.classList.remove("hidden");
  loginStatus.textContent = "已退出登录";
}

async function loadConfig() {
  try {
    const data = await api("/api/admin/config");
    fillForm(data.config);
    statusBox.textContent = JSON.stringify(data.config, null, 2);
  } catch (error) {
    statusBox.textContent = error.message;
  }
}

async function loadModels(refresh) {
  try {
    const suffix = refresh ? "?refresh=1" : "";
    const data = await api(`/api/admin/models${suffix}`);
    modelsBox.textContent = JSON.stringify(data.models, null, 2);
  } catch (error) {
    modelsBox.textContent = error.message;
  }
}

async function saveConfig() {
  const payload = {};
  for (const id of fieldIds) {
    const element = document.querySelector(`#${id}`);
    payload[id] = element.type === "checkbox" ? element.checked : element.value;
  }

  try {
    const data = await api("/api/admin/config", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    fillForm(data.config);
    statusBox.textContent = `${data.message}\n\n${JSON.stringify(data.config, null, 2)}`;
    flash("配置已保存");
  } catch (error) {
    statusBox.textContent = error.message;
  }
}

async function importCredentials() {
  const jsonText = document.querySelector("#credentialsJson").value.trim();

  try {
    const data = await api("/api/admin/import-credentials", {
      method: "POST",
      body: JSON.stringify({ jsonText }),
    });
    fillForm(data.config);
    statusBox.textContent = `${data.message}\n\n${JSON.stringify(data.config, null, 2)}`;
    flash("服务账号 JSON 已导入");
  } catch (error) {
    statusBox.textContent = error.message;
  }
}

async function changePassword() {
  const currentPassword = document.querySelector("#currentPassword").value;
  const newPassword = document.querySelector("#newPassword").value;

  try {
    const data = await api("/api/admin/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    adminPassword = newPassword;
    loginPasswordInput.value = newPassword;
    if (rememberPasswordInput.checked) {
      localStorage.setItem(STORAGE_KEY, newPassword);
    }
    document.querySelector("#currentPassword").value = "";
    document.querySelector("#newPassword").value = "";
    statusBox.textContent = data.message;
    flash("控制台密码已更新");
  } catch (error) {
    statusBox.textContent = error.message;
  }
}

function fillForm(config) {
  for (const id of fieldIds) {
    const element = document.querySelector(`#${id}`);
    if (!element) continue;
    if (element.type === "checkbox") {
      element.checked = Boolean(config[id]);
    } else {
      element.value = config[id] ?? "";
    }
  }
}

async function api(url, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (adminPassword) {
    headers["X-Admin-Password"] = adminPassword;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || `HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  }

  return payload;
}

function flash(message) {
  statusBox.textContent = message;
  setTimeout(() => loadConfig(), 800);
}
