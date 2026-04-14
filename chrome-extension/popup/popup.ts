// ── 类型定义 ──────────────────────────────────
interface ScriptConfig {
  targetUrl: string;
  code: string;
  enabled?: boolean;
}
type ScriptsStore = Record<string, ScriptConfig>;

// ── DOM 引用 ──────────────────────────────────
const badge      = document.getElementById("connection-badge") as HTMLSpanElement;
const scriptList = document.getElementById("script-list")      as HTMLDivElement;
const manageBtn  = document.getElementById("manage-btn")       as HTMLButtonElement;

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

// ── 加载脚本列表（只读展示）─────────────────
async function loadScripts() {
  const { scripts } = await chrome.storage.local.get("scripts") as { scripts?: ScriptsStore };
  const entries = Object.entries(scripts ?? {});

  scriptList.innerHTML = "";

  if (entries.length === 0) {
    const p = document.createElement("p");
    p.id = "no-scripts";
    p.textContent = "暂无脚本";
    scriptList.appendChild(p);
    return;
  }

  for (const [name, config] of entries) {
    const enabled = config.enabled !== false;
    const item = document.createElement("div");
    item.className = `script-item${enabled ? "" : " disabled"}`;
    item.innerHTML = `
      <span class="status-dot${enabled ? "" : " off"}"></span>
      <div class="info">
        <div class="name">${escapeHtml(name)}</div>
        <div class="url" title="${escapeHtml(config.targetUrl)}">${escapeHtml(config.targetUrl)}</div>
      </div>
    `;
    scriptList.appendChild(item);
  }
}

// ── 打开管理页面 ──────────────────────────────
manageBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("manager/manager.html") });
});

// ── 工具函数 ──────────────────────────────────
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
