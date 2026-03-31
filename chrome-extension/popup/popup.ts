// ── 类型定义 ──────────────────────────────────
interface ScriptConfig {
  targetUrl: string;
  code: string;
}
type ScriptsStore = Record<string, ScriptConfig>;

// ── DOM 引用 ──────────────────────────────────
const scriptList = document.getElementById("script-list") as HTMLDivElement;
const noScripts = document.getElementById("no-scripts") as HTMLParagraphElement;
const installBtn = document.getElementById("install-btn") as HTMLButtonElement;
const statusMsg = document.getElementById("status-msg") as HTMLParagraphElement;
const badge = document.getElementById("connection-badge") as HTMLSpanElement;

const nameInput = document.getElementById("script-name") as HTMLInputElement;
const urlInput = document.getElementById("target-url") as HTMLInputElement;
const codeInput = document.getElementById("script-code") as HTMLTextAreaElement;

// ── 连接状态检测 ──────────────────────────────
async function checkConnectionStatus() {
  try {
    await fetch("http://127.0.0.1:3282/health", { signal: AbortSignal.timeout(1500) });
    badge.textContent = "已连接";
    badge.className = "badge";
  } catch {
    badge.textContent = "未连接";
    badge.className = "badge disconnected";
  }
}

// ── 加载已安装脚本列表 ────────────────────────
async function loadScripts() {
  const { scripts } = (await chrome.storage.local.get("scripts")) as {
    scripts?: ScriptsStore;
  };

  const entries = Object.entries(scripts ?? {});
  scriptList.innerHTML = "";

  if (entries.length === 0) {
    scriptList.appendChild(noScripts);
    return;
  }

  for (const [name, config] of entries) {
    const item = document.createElement("div");
    item.className = "script-item";
    item.innerHTML = `
      <div style="flex:1;min-width:0">
        <div class="name">${escapeHtml(name)}</div>
        <div class="url" title="${escapeHtml(config.targetUrl)}">${escapeHtml(config.targetUrl)}</div>
      </div>
      <button data-name="${escapeHtml(name)}">删除</button>
    `;

    item.querySelector("button")!.addEventListener("click", () => deleteScript(name));
    scriptList.appendChild(item);
  }
}

// ── 安装脚本 ──────────────────────────────────
installBtn.addEventListener("click", async () => {
  const name = nameInput.value.trim();
  const targetUrl = urlInput.value.trim();
  const code = codeInput.value.trim();

  // 基础校验
  if (!name || !targetUrl || !code) {
    showStatus("请填写所有字段", true);
    return;
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    showStatus("工具名称只能包含字母、数字和下划线", true);
    return;
  }
  let origin: string;
  try {
    origin = new URL(targetUrl).origin;
  } catch {
    showStatus("目标网址格式不正确", true);
    return;
  }

  installBtn.disabled = true;
  showStatus("正在安装...");

  try {
    // 注销旧版本（如果存在）
    const existing = await chrome.userScripts.getScripts({ ids: [name] });
    if (existing.length > 0) {
      await chrome.userScripts.unregister({ ids: [name] });
    }

    // 注册 User Script（独立沙箱，不污染页面）
    await chrome.userScripts.register([
      {
        id: name,
        matches: [`${origin}/*`],
        js: [{ code }],
        runAt: "document_idle",
        world: "USER_SCRIPT",
      },
    ]);

    // 保存到 storage
    const { scripts } = (await chrome.storage.local.get("scripts")) as {
      scripts?: ScriptsStore;
    };
    await chrome.storage.local.set({
      scripts: { ...scripts, [name]: { targetUrl, code } },
    });

    // 清空表单
    nameInput.value = "";
    urlInput.value = "";
    codeInput.value = "";

    showStatus(`✓ 脚本 "${name}" 安装成功`);
    await loadScripts();
  } catch (err) {
    showStatus(`安装失败: ${(err as Error).message}`, true);
  } finally {
    installBtn.disabled = false;
  }
});

// ── 删除脚本 ──────────────────────────────────
async function deleteScript(name: string) {
  try {
    await chrome.userScripts.unregister({ ids: [name] });
  } catch {
    // 脚本可能未注册，忽略
  }

  const { scripts } = (await chrome.storage.local.get("scripts")) as {
    scripts?: ScriptsStore;
  };
  const updated = { ...scripts };
  delete updated[name];
  await chrome.storage.local.set({ scripts: updated });

  showStatus(`已删除脚本 "${name}"`);
  await loadScripts();
}

// ── 工具函数 ──────────────────────────────────
function showStatus(msg: string, isError = false) {
  statusMsg.textContent = msg;
  statusMsg.className = isError ? "error" : "";
  if (!isError) setTimeout(() => (statusMsg.textContent = ""), 3000);
}

function escapeHtml(str: string) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── 初始化 ────────────────────────────────────
checkConnectionStatus();
loadScripts();
