// ── 类型定义 ──────────────────────────────────
interface ScriptConfig {
  targetUrl: string;
  code: string;
  enabled?: boolean;       // 缺失时视为 true（向后兼容）
  createdAt?: number;
  updatedAt?: number;
}
type ScriptsStore = Record<string, ScriptConfig>;

// ── DOM 引用 ──────────────────────────────────
const badge        = document.getElementById("connection-badge") as HTMLSpanElement;
const scriptList   = document.getElementById("script-list")      as HTMLDivElement;
const newBtn       = document.getElementById("new-btn")          as HTMLButtonElement;
const overlay      = document.getElementById("editor-overlay")   as HTMLDivElement;
const editorTitle  = document.getElementById("editor-title")     as HTMLHeadingElement;
const inputName    = document.getElementById("input-name")       as HTMLInputElement;
const inputUrl     = document.getElementById("input-url")        as HTMLInputElement;
const inputCode    = document.getElementById("input-code")       as HTMLTextAreaElement;
const saveBtn      = document.getElementById("save-btn")         as HTMLButtonElement;
const cancelBtn    = document.getElementById("cancel-btn")       as HTMLButtonElement;
const statusMsg    = document.getElementById("status-msg")       as HTMLParagraphElement;

// 编辑时记录原始名称（新建时为 null）
let editingName: string | null = null;

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

// ── 读取所有脚本 ──────────────────────────────
async function getScripts(): Promise<ScriptsStore> {
  const { scripts } = await chrome.storage.local.get("scripts") as { scripts?: ScriptsStore };
  return scripts ?? {};
}

// ── 渲染列表 ──────────────────────────────────
async function loadScripts() {
  const scripts = await getScripts();
  const entries = Object.entries(scripts);
  scriptList.innerHTML = "";

  if (entries.length === 0) {
    const p = document.createElement("p");
    p.id = "no-scripts";
    p.textContent = "暂无脚本，点击右上角「新建脚本」开始添加";
    scriptList.appendChild(p);
    return;
  }

  for (const [name, config] of entries) {
    const enabled = config.enabled !== false;
    const updatedAt = config.updatedAt
      ? new Date(config.updatedAt).toLocaleDateString("zh-CN")
      : "—";

    const card = document.createElement("div");
    card.className = `script-card${enabled ? "" : " disabled"}`;
    card.innerHTML = `
      <div class="card-info">
        <div class="card-name">${escapeHtml(name)}</div>
        <div class="card-url" title="${escapeHtml(config.targetUrl)}">${escapeHtml(config.targetUrl)}</div>
        <div class="card-meta">最后更新：${updatedAt}</div>
      </div>
      <div class="card-actions">
        <button class="btn-toggle ${enabled ? "enabled" : ""}" data-name="${escapeHtml(name)}">
          ${enabled ? "已启用" : "已禁用"}
        </button>
        <button class="btn-edit" data-name="${escapeHtml(name)}">编辑</button>
        <button class="btn-delete" data-name="${escapeHtml(name)}">删除</button>
      </div>
    `;

    card.querySelector(".btn-toggle")!.addEventListener("click", () => toggleEnabled(name));
    card.querySelector(".btn-edit")!.addEventListener("click",   () => openEditor(name, config));
    card.querySelector(".btn-delete")!.addEventListener("click", () => deleteScript(name));

    scriptList.appendChild(card);
  }
}

// ── 启用/禁用切换 ─────────────────────────────
async function toggleEnabled(name: string) {
  const scripts = await getScripts();
  if (!scripts[name]) return;

  const current = scripts[name].enabled !== false;
  const next = !current;

  if (!next) {
    // 禁用：注销 userScript
    try {
      await chrome.userScripts.unregister({ ids: [name] });
    } catch { /* 未注册也没关系 */ }
  }
  // 启用时不需要立即重新注册，background 在下次调用时会自动 ensureUserScriptRegistered

  scripts[name] = { ...scripts[name], enabled: next, updatedAt: Date.now() };
  await chrome.storage.local.set({ scripts });
  await loadScripts();
}

// ── 打开编辑器 ────────────────────────────────
function openEditor(name?: string, config?: ScriptConfig) {
  editingName = name ?? null;
  editorTitle.textContent = name ? "编辑脚本" : "新建脚本";
  inputName.value = name ?? "";
  inputName.disabled = !!name;        // 编辑时名称不可改，防止 key 变动
  inputUrl.value = config?.targetUrl ?? "";
  inputCode.value = config?.code ?? "";
  statusMsg.textContent = "";
  statusMsg.className = "";
  overlay.classList.add("open");
  (name ? inputUrl : inputName).focus();
}

function closeEditor() {
  overlay.classList.remove("open");
  editingName = null;
}

// ── 保存脚本 ──────────────────────────────────
async function saveScript() {
  const name      = editingName ?? inputName.value.trim();
  const targetUrl = inputUrl.value.trim();
  const code      = inputCode.value.trim();

  // 校验
  if (!name || !targetUrl || !code) {
    showStatus("请填写所有字段", true); return;
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    showStatus("工具名称只能包含字母、数字和下划线", true); return;
  }
  let origin: string;
  try { origin = new URL(targetUrl).origin; }
  catch { showStatus("目标网址格式不正确", true); return; }

  saveBtn.disabled = true;
  showStatus("正在保存...");

  try {
    // 注销旧版 userScript（若存在）
    try { await chrome.userScripts.unregister({ ids: [name] }); } catch { /* 忽略 */ }

    // 重新注册（enabled 默认 true）
    await chrome.userScripts.register([{
      id: name,
      matches: [`${origin}/*`],
      js: [{ code }],
      runAt: "document_idle",
      world: "USER_SCRIPT",
    }]);

    // 持久化到 storage
    const scripts = await getScripts();
    const now = Date.now();
    scripts[name] = {
      targetUrl,
      code,
      enabled: scripts[name]?.enabled !== false,  // 保留已有 enabled 状态
      createdAt: scripts[name]?.createdAt ?? now,
      updatedAt: now,
    };
    await chrome.storage.local.set({ scripts });

    closeEditor();
    await loadScripts();
  } catch (err) {
    showStatus(`保存失败: ${(err as Error).message}`, true);
  } finally {
    saveBtn.disabled = false;
  }
}

// ── 删除脚本 ──────────────────────────────────
async function deleteScript(name: string) {
  if (!confirm(`确定要删除脚本 "${name}" 吗？`)) return;

  try { await chrome.userScripts.unregister({ ids: [name] }); } catch { /* 忽略 */ }

  const scripts = await getScripts();
  delete scripts[name];
  await chrome.storage.local.set({ scripts });
  await loadScripts();
}

// ── 工具函数 ──────────────────────────────────
function showStatus(msg: string, isError = false) {
  statusMsg.textContent = msg;
  statusMsg.className = isError ? "error" : "";
}

function escapeHtml(str: string) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── 事件绑定 ──────────────────────────────────
newBtn.addEventListener("click", () => openEditor());
cancelBtn.addEventListener("click", closeEditor);
saveBtn.addEventListener("click", saveScript);

// 点击遮罩关闭
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closeEditor();
});

// ── 初始化 ────────────────────────────────────
checkConnectionStatus();
loadScripts();

export {};
