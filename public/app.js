const LS_TOKEN_KEY = "sait_auth_token";
const LS_THEME_KEY = "sait_theme";
const LS_PROXY_KEY = "sait_ai_proxy";
const LS_PROXY_PANEL_HIDDEN_KEY = "sait_proxy_panel_hidden";

const state = {
  me: null,
  token: null,
  users: [],
  active: { type: "global", target: null },
  ws: null,
  currentMessages: [],
  unreadByChatKey: {},
  proxyUrl: "",
  filePreviewUrl: null,
  selectedFile: null,
  selectedFileSource: null,
  isSending: false
};

const els = {
  loginView: document.getElementById("loginView"),
  chatView: document.getElementById("chatView"),
  loginForm: document.getElementById("loginForm"),
  nicknameInput: document.getElementById("nicknameInput"),
  loginError: document.getElementById("loginError"),
  fixedChats: document.getElementById("fixedChats"),
  userChats: document.getElementById("userChats"),
  chatTitle: document.getElementById("chatTitle"),
  chatSubtitle: document.getElementById("chatSubtitle"),
  youLabel: document.getElementById("youLabel"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  messageInput: document.getElementById("messageInput"),
  fileWrap: document.getElementById("fileWrap"),
  fileInput: document.getElementById("fileInput"),
  fileLabel: document.getElementById("fileLabel"),
  selectedFileInfo: document.getElementById("selectedFileInfo"),
  selectedFilePreview: document.getElementById("selectedFilePreview"),
  selectedFileName: document.getElementById("selectedFileName"),
  selectedFileSize: document.getElementById("selectedFileSize"),
  clearFileBtn: document.getElementById("clearFileBtn"),
  submitBtn: document.querySelector("#composer button[type='submit']"),
  themeSelect: document.getElementById("themeSelect"),
  aiProxyBar: document.getElementById("aiProxyBar"),
  proxyInput: document.getElementById("proxyInput"),
  saveProxyBtn: document.getElementById("saveProxyBtn"),
  hideProxyBarBtn: document.getElementById("hideProxyBarBtn"),
  showProxyBarBtn: document.getElementById("showProxyBarBtn"),
  modelInfoBar: document.getElementById("modelInfoBar"),
  modelInfoText: document.getElementById("modelInfoText"),
  pasteHint: document.getElementById("pasteHint")
};

const fixed = [
  { type: "global", target: null, label: "Общий чат" },
  { type: "favorite", target: null, label: "Избранное" },
  { type: "ai", target: "openai", label: "AI: ChatGPT", icon: "/assets/openai.svg" },
  { type: "ai", target: "gemini", label: "AI: Gemini", icon: "/assets/gemini.svg" }
];

function setToken(token) {
  state.token = token || null;
  if (state.token) localStorage.setItem(LS_TOKEN_KEY, state.token);
  else localStorage.removeItem(LS_TOKEN_KEY);
}

function resetAuthState() {
  setToken(null);
  state.me = null;
  state.users = [];
  state.currentMessages = [];
  state.unreadByChatKey = {};
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  els.chatView.classList.add("hidden");
  els.loginView.classList.remove("hidden");
}

function applyTheme(theme) {
  const selected = ["light", "dark", "glass"].includes(theme) ? theme : "light";
  document.body.setAttribute("data-theme", selected);
  localStorage.setItem(LS_THEME_KEY, selected);
  els.themeSelect.value = selected;
}

function initTheme() {
  applyTheme(localStorage.getItem(LS_THEME_KEY) || "light");
  els.themeSelect.addEventListener("change", () => applyTheme(els.themeSelect.value));
}

function initProxy() {
  state.proxyUrl = (localStorage.getItem(LS_PROXY_KEY) || "").trim();
  els.proxyInput.value = state.proxyUrl;
  els.saveProxyBtn.addEventListener("click", () => {
    state.proxyUrl = els.proxyInput.value.trim();
    if (state.proxyUrl) localStorage.setItem(LS_PROXY_KEY, state.proxyUrl);
    else localStorage.removeItem(LS_PROXY_KEY);
    els.saveProxyBtn.textContent = "Сохранено";
    setTimeout(() => {
      els.saveProxyBtn.textContent = "Сохранить прокси";
    }, 900);
    refreshOpenAIModelInfo();
  });

  els.hideProxyBarBtn.addEventListener("click", () => {
    localStorage.setItem(LS_PROXY_PANEL_HIDDEN_KEY, "1");
    refreshProxyBarVisibility();
  });

  els.showProxyBarBtn.addEventListener("click", () => {
    localStorage.removeItem(LS_PROXY_PANEL_HIDDEN_KEY);
    refreshProxyBarVisibility();
  });
}

function refreshProxyBarVisibility() {
  const hiddenByUser = localStorage.getItem(LS_PROXY_PANEL_HIDDEN_KEY) === "1";
  const isOpenAIChat = state.active.type === "ai" && state.active.target === "openai";
  const isAnyAiChat = state.active.type === "ai";

  els.aiProxyBar.classList.toggle("hidden", !isAnyAiChat || hiddenByUser);
  els.showProxyBarBtn.classList.toggle("hidden", !isOpenAIChat || !hiddenByUser);
}

async function api(url, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 401 && url !== "/api/login") resetAuthState();
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function chatEquals(a, b) {
  return a.type === b.type && (a.target || "") === (b.target || "");
}

function dmChat(user) {
  return { type: "dm", target: user };
}

function chatKeyByInput(type, target = null) {
  if (!state.me) return "";
  if (type === "global") return "global";
  if (type === "favorite") return `favorite::${state.me}`;
  if (type === "dm") {
    const [a, b] = [state.me, target].sort((x, y) => x.localeCompare(y));
    return `dm::${a}::${b}`;
  }
  if (type === "ai") return `ai::${state.me}::${target}`;
  return "";
}

function unreadCount(type, target = null) {
  return state.unreadByChatKey[chatKeyByInput(type, target)] || 0;
}

function markRead(type, target = null) {
  const key = chatKeyByInput(type, target);
  if (key && state.unreadByChatKey[key]) delete state.unreadByChatKey[key];
}

function incrementUnreadByChatKey(chatKey) {
  if (!chatKey) return;
  state.unreadByChatKey[chatKey] = (state.unreadByChatKey[chatKey] || 0) + 1;
}

function setActive(type, target = null) {
  state.active = { type, target };
  markRead(type, target);
  renderSidebar();
  loadHistory();
}

function buildChatButton(item, labelText) {
  const btn = document.createElement("button");
  btn.className = "chat-item" + (chatEquals(state.active, item) ? " active" : "");
  btn.onclick = () => setActive(item.type, item.target);

  const left = document.createElement("div");
  left.style.display = "flex";
  left.style.alignItems = "center";
  left.style.gap = "8px";

  if (item.icon) {
    const icon = document.createElement("img");
    icon.className = "chat-icon";
    icon.src = item.icon;
    icon.alt = labelText;
    left.appendChild(icon);
  }

  const label = document.createElement("span");
  label.className = "chat-item-label";
  label.textContent = labelText;
  left.appendChild(label);
  btn.appendChild(left);

  const unread = unreadCount(item.type, item.target);
  if (unread > 0) {
    const badge = document.createElement("span");
    badge.className = "unread-badge";
    badge.textContent = `🔔 ${unread}`;
    btn.appendChild(badge);
  }

  return btn;
}

function renderSidebar() {
  els.fixedChats.innerHTML = "";
  for (const item of fixed) els.fixedChats.appendChild(buildChatButton(item, item.label));

  els.userChats.innerHTML = "";
  for (const user of state.users) {
    if (user.nickname === state.me) continue;
    els.userChats.appendChild(buildChatButton(dmChat(user.nickname), user.nickname));
  }
}

function getActiveMeta() {
  if (state.active.type === "global") return { title: "Общий чат", subtitle: "Все пользователи сайта" };
  if (state.active.type === "favorite") return { title: "Избранное", subtitle: "Только вы" };
  if (state.active.type === "dm") return { title: `Личная переписка: ${state.active.target}`, subtitle: "Личный чат" };
  if (state.active.type === "ai") {
    return {
      title: state.active.target === "gemini" ? "AI чат: Gemini" : "AI чат: ChatGPT",
      subtitle: "Ваш персональный помощник"
    };
  }
  return { title: "", subtitle: "" };
}

function formatTime(ts) {
  const d = new Date(ts.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showPasteHint(show) {
  els.pasteHint.classList.toggle("show", Boolean(show));
}

function clearFileSelection() {
  if (state.filePreviewUrl) {
    URL.revokeObjectURL(state.filePreviewUrl);
    state.filePreviewUrl = null;
  }
  state.selectedFile = null;
  state.selectedFileSource = null;
  els.fileInput.value = "";
  els.selectedFileInfo.classList.add("hidden");
  els.selectedFileName.textContent = "";
  els.selectedFileSize.textContent = "";
  els.selectedFilePreview.src = "";
  els.selectedFilePreview.classList.add("hidden");
  showPasteHint(false);
}

function createContextMenu() {
  const menu = document.createElement("div");
  menu.className = "msg-context-menu hidden";
  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "Удалить";
  del.onclick = async () => {
    const id = Number.parseInt(menu.dataset.messageId || "", 10);
    closeContextMenu();
    if (!Number.isInteger(id)) return;
    try {
      await deleteMessage(id);
    } catch (err) {
      const systemMsg = {
        sender: "System",
        createdAt: new Date().toISOString(),
        content: `Ошибка удаления: ${err.message}`,
        format: "plain"
      };
      state.currentMessages.push(systemMsg);
      appendMessage(systemMsg, true);
    }
  };
  menu.appendChild(del);
  document.body.appendChild(menu);
  return menu;
}

const contextMenu = createContextMenu();

function openContextMenu(x, y, messageId) {
  contextMenu.dataset.messageId = String(messageId);
  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
  contextMenu.classList.remove("hidden");
}

function closeContextMenu() {
  contextMenu.classList.add("hidden");
  contextMenu.dataset.messageId = "";
}

function renderSelectedFile(file) {
  if (!file) {
    clearFileSelection();
    return;
  }

  els.selectedFileInfo.classList.remove("hidden");
  els.selectedFileName.textContent = file.name;
  els.selectedFileSize.textContent = `${formatBytes(file.size)}${file.type ? ` • ${file.type}` : ""}`;

  if (file.type.startsWith("image/")) {
    if (state.filePreviewUrl) URL.revokeObjectURL(state.filePreviewUrl);
    state.filePreviewUrl = URL.createObjectURL(file);
    els.selectedFilePreview.src = state.filePreviewUrl;
    els.selectedFilePreview.classList.remove("hidden");
  } else {
    els.selectedFilePreview.classList.add("hidden");
    els.selectedFilePreview.src = "";
  }
}

function setSelectedFile(file, source = "picker") {
  state.selectedFile = file || null;
  state.selectedFileSource = file ? source : null;
  if (file) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      els.fileInput.files = dt.files;
    } catch {
      // Some browsers may block programmatic assignment.
    }
  }
  renderSelectedFile(file);
  showPasteHint(source === "paste");
}

function updateFileSelectionUI() {
  const file = els.fileInput.files?.[0] || null;
  setSelectedFile(file, "picker");
}

function guessExtensionFromMime(mimeType) {
  const map = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp"
  };
  return map[mimeType] || "png";
}

function handlePasteImage(e) {
  const items = Array.from(e.clipboardData?.items || []);
  const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
  if (!imageItem) return;

  const blob = imageItem.getAsFile();
  if (!blob) return;

  const ext = guessExtensionFromMime(blob.type);
  const filename = `screenshot-${Date.now()}.${ext}`;
  const file = new File([blob], filename, { type: blob.type || "image/png", lastModified: Date.now() });

  setSelectedFile(file, "paste");
  e.preventDefault();
}

function activeChatIdentity() {
  return {
    chatType: state.active.type,
    chatKey: chatKeyByInput(state.active.type, state.active.target)
  };
}

function attachmentNode(msg) {
  const attachment = msg.meta?.attachment;
  if (!attachment?.dataUrl) return null;

  const wrap = document.createElement("div");
  wrap.className = "attachment";

  if ((attachment.mimeType || "").startsWith("image/")) {
    const img = document.createElement("img");
    img.className = "attachment-image";
    img.src = attachment.dataUrl;
    img.alt = attachment.name || "image";
    wrap.appendChild(img);
  }

  const link = document.createElement("a");
  link.href = attachment.dataUrl;
  link.download = attachment.name || "file";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = `Скачать: ${attachment.name || "file"}`;
  wrap.appendChild(link);

  return wrap;
}

function normalizeMathBlocks(text) {
  const raw = (text || "").toString();
  const lines = raw.split("\n");
  const out = [];
  let inBlock = false;
  let buf = [];

  for (const line of lines) {
    const t = line.trim();
    if (!inBlock && (t === "[" || t === "\\[")) {
      inBlock = true;
      buf = [];
      continue;
    }
    if (inBlock && (t === "]" || t === "\\]")) {
      out.push(`$$\n${buf.join("\n")}\n$$`);
      inBlock = false;
      buf = [];
      continue;
    }
    if (inBlock) buf.push(line);
    else out.push(line);
  }

  if (inBlock) {
    out.push("[");
    out.push(...buf);
  }
  return out.join("\n");
}

function renderMarkdownContent(target, text) {
  const prepared = normalizeMathBlocks(text);
  const mathBlocks = [];
  const withTokens = (prepared || "").replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
    const token = `@@MATH_BLOCK_${mathBlocks.length}@@`;
    mathBlocks.push((expr || "").trim());
    return token;
  });

  let html = marked.parse(withTokens, { breaks: true, gfm: true });
  html = DOMPurify.sanitize(html);

  if (mathBlocks.length && typeof window.katex?.renderToString === "function") {
    html = html.replace(/@@MATH_BLOCK_(\d+)@@/g, (_, idxRaw) => {
      const idx = Number.parseInt(idxRaw, 10);
      const expr = mathBlocks[idx] || "";
      return window.katex.renderToString(expr, {
        displayMode: true,
        throwOnError: false
      });
    });
  }
  target.innerHTML = html;

  if (typeof window.renderMathInElement === "function") {
    window.renderMathInElement(target, {
      delimiters: [{ left: "$", right: "$", display: false }],
      throwOnError: false
    });
  }
}

function upsertMessages(messages) {
  const normalized = messages.filter((m) => Number.isInteger(m.id));
  if (!normalized.length) return;

  const byId = new Map(state.currentMessages.filter((m) => Number.isInteger(m.id)).map((m) => [m.id, m]));
  let hasUpdatedExisting = false;
  const toAppend = [];

  for (const msg of normalized.sort((a, b) => a.id - b.id)) {
    if (byId.has(msg.id)) {
      byId.set(msg.id, msg);
      hasUpdatedExisting = true;
    } else {
      byId.set(msg.id, msg);
      toAppend.push(msg);
    }
  }

  if (hasUpdatedExisting) {
    state.currentMessages = Array.from(byId.values()).sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return aTime - bTime || (a.id || 0) - (b.id || 0);
    });
    renderMessages(state.currentMessages);
    return;
  }

  for (const msg of toAppend) {
    state.currentMessages.push(msg);
    appendMessage(msg);
  }
}

async function deleteMessage(id) {
  await api(`/api/message/${id}`, { method: "DELETE" });
}

function renderMessages(list) {
  state.currentMessages = list;
  els.messages.innerHTML = "";

  for (const msg of list) {
    const node = createMessageNode(msg, false);
    els.messages.appendChild(node);
  }

  els.messages.scrollTop = els.messages.scrollHeight;
}

function createMessageNode(msg, animate = true) {
  const box = document.createElement("div");
  box.className = "msg" + (msg.sender === state.me ? " me" : "");
  if (!Number.isInteger(msg.id)) box.classList.add("pending");
  if (animate) box.classList.add("msg-enter");
  if (Number.isInteger(msg.id)) box.dataset.id = String(msg.id);

  const head = document.createElement("div");
  head.className = "head";

  const meta = document.createElement("div");
  meta.className = "meta";
  const modelSuffix = msg.sender === "ChatGPT" && msg.meta?.modelUsed ? ` • ${msg.meta.modelUsed}` : "";
  meta.textContent = `${msg.sender} • ${formatTime(msg.createdAt)}${modelSuffix}`;
  head.appendChild(meta);

  if (msg.sender === state.me && Number.isInteger(msg.id)) {
    box.classList.add("own-message");
    box.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, msg.id);
    });
  }

  const text = document.createElement("div");
  if (msg.format === "markdown") {
    text.className = "text markdown";
    renderMarkdownContent(text, msg.content || "");
  } else {
    text.className = "text";
    text.textContent = msg.content || "";
  }

  box.appendChild(head);
  box.appendChild(text);
  const attach = attachmentNode(msg);
  if (attach) box.appendChild(attach);

  return box;
}

function appendMessage(msg, isSystem = false) {
  const node = createMessageNode(msg, true);
  if (isSystem) node.classList.remove("pending");
  els.messages.appendChild(node);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function belongsToActive(msg) {
  const t = state.active.type;
  if (t !== msg.chatType) return false;
  if (t === "global") return msg.chatKey === "global";
  if (t === "favorite") return msg.chatKey === `favorite::${state.me}`;
  if (t === "dm") {
    const [a, b] = [state.me, state.active.target].sort((x, y) => x.localeCompare(y));
    return msg.chatKey === `dm::${a}::${b}`;
  }
  if (t === "ai") return msg.chatKey === `ai::${state.me}::${state.active.target}`;
  return false;
}

async function refreshOpenAIModelInfo() {
  if (state.active.type !== "ai" || state.active.target !== "openai") {
    els.modelInfoBar.classList.add("hidden");
    return;
  }

  els.modelInfoBar.classList.remove("hidden");
  els.modelInfoText.textContent = "Модель ChatGPT (из API): проверка...";
  refreshProxyBarVisibility();

  try {
    const query = new URLSearchParams();
    if (state.proxyUrl) query.set("proxyUrl", state.proxyUrl);
    const data = await api(`/api/ai/openai-model${query.toString() ? `?${query.toString()}` : ""}`);

    if (data.ok) {
      els.modelInfoText.textContent = `Модель ChatGPT (из API): ${data.apiModel}`;
    } else {
      els.modelInfoText.textContent = `Модель ChatGPT (из API): ошибка (${data.error || "unknown"})`;
    }
  } catch (err) {
    els.modelInfoText.textContent = `Модель ChatGPT (из API): ошибка (${err.message})`;
  }
}

async function loadHistory() {
  const params = new URLSearchParams({ type: state.active.type });
  if (state.active.target) params.set("target", state.active.target);

  const meta = getActiveMeta();
  els.chatTitle.textContent = meta.title;
  els.chatSubtitle.textContent = meta.subtitle;
  els.youLabel.textContent = `Вы: ${state.me}`;

  els.fileWrap.classList.remove("hidden");
  refreshProxyBarVisibility();
  if (state.active.type === "ai") {
    els.fileLabel.textContent = "Изображение";
    els.fileInput.accept = "image/*";
    els.proxyInput.value = state.proxyUrl;
  } else {
    els.fileLabel.textContent = "Файл/Картинка";
    els.fileInput.accept = "image/*,.pdf,.txt,.doc,.docx,.xls,.xlsx,.zip,.rar,.7z,.csv,.json";
  }

  clearFileSelection();
  markRead(state.active.type, state.active.target);
  renderSidebar();

  try {
    const data = await api(`/api/history?${params.toString()}`);
    renderMessages(data.messages);
  } catch (err) {
    renderMessages([
      {
        sender: "System",
        createdAt: new Date().toISOString(),
        content: `Ошибка загрузки: ${err.message}`,
        format: "plain"
      }
    ]);
  }

  refreshOpenAIModelInfo();
}

function connectWs() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);

    if (msg.event === "users:update") {
      state.users = msg.payload.users || [];
      renderSidebar();
      return;
    }

    if (msg.event === "message:new" && msg.payload?.message) {
      const node = msg.payload.message;
      const isMine = node.sender === state.me;
      const isActive = belongsToActive(node);

      if (!isMine && !isActive) {
        incrementUnreadByChatKey(node.chatKey);
        renderSidebar();
      }

      if (isActive) upsertMessages([node]);
      return;
    }

    if (msg.event === "message:delete" && msg.payload) {
      const active = activeChatIdentity();
      if (msg.payload.chatType === active.chatType && msg.payload.chatKey === active.chatKey) {
        state.currentMessages = state.currentMessages.filter((item) => item.id !== msg.payload.id);
        const node = els.messages.querySelector(`.msg[data-id="${msg.payload.id}"]`);
        if (node) node.remove();
      }
    }
  };

  ws.onclose = () => {
    state.ws = null;
    if (state.me) setTimeout(connectWs, 1200);
  };
}

function enterChat(user, users) {
  state.me = user.nickname;
  state.users = users || [];
  els.loginView.classList.add("hidden");
  els.chatView.classList.remove("hidden");
  renderSidebar();
  loadHistory();
  connectWs();
}

async function login(nickname) {
  const data = await api("/api/login", {
    method: "POST",
    body: JSON.stringify({ nickname })
  });
  setToken(data.token);
  enterChat(data.user, data.users);
}

async function restoreSession() {
  const stored = localStorage.getItem(LS_TOKEN_KEY);
  if (!stored) return false;

  setToken(stored);
  try {
    const data = await api("/api/me", { method: "GET" });
    enterChat(data.user, data.users);
    return true;
  } catch {
    resetAuthState();
    return false;
  }
}

els.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.loginError.textContent = "";
  const nick = els.nicknameInput.value.trim();
  if (!nick) {
    els.loginError.textContent = "Введите ник";
    return;
  }
  try {
    await login(nick);
  } catch (err) {
    els.loginError.textContent = err.message;
  }
});

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function resizeComposer() {
  els.messageInput.style.height = "auto";
  els.messageInput.style.height = `${Math.min(els.messageInput.scrollHeight, 170)}px`;
}

els.messageInput.addEventListener("input", resizeComposer);
els.messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});
els.messageInput.addEventListener("paste", handlePasteImage);
els.fileInput.addEventListener("change", updateFileSelectionUI);
els.clearFileBtn.addEventListener("click", clearFileSelection);
resizeComposer();

els.composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.me || state.isSending) return;
  closeContextMenu();

  const text = els.messageInput.value.trim();
  const file = state.selectedFile || els.fileInput.files?.[0] || null;
  if (!text && !file) return;

  els.messageInput.value = "";
  resizeComposer();
  const sendFile = file;
  const sendText = text;
  state.isSending = true;

  try {
    els.submitBtn.disabled = true;
    els.submitBtn.textContent = "Отправка...";
    els.submitBtn.classList.add("sending");

    if (state.active.type === "ai") {
      let imageDataUrl = null;
      if (sendFile) {
        if (!sendFile.type.startsWith("image/")) throw new Error("Для AI-чата можно отправлять только изображения");
        imageDataUrl = await fileToDataUrl(sendFile);
      }

      await api("/api/ai/send", {
        method: "POST",
        body: JSON.stringify({
          provider: state.active.target,
          text: sendText,
          imageDataUrl,
          proxyUrl: state.proxyUrl || null
        })
      });
    } else {
      let attachmentDataUrl = null;
      if (sendFile) attachmentDataUrl = await fileToDataUrl(sendFile);

      await api("/api/message", {
        method: "POST",
        body: JSON.stringify({
          type: state.active.type,
          target: state.active.target,
          content: sendText,
          attachmentDataUrl,
          attachmentName: sendFile?.name || null,
          attachmentMimeType: sendFile?.type || null
        })
      });
    }

    clearFileSelection();
  } catch (err) {
    const systemMsg = {
      sender: "System",
      createdAt: new Date().toISOString(),
      content: `Ошибка отправки: ${err.message}`,
      format: "plain"
    };
    state.currentMessages.push(systemMsg);
    appendMessage(systemMsg, true);
  } finally {
    state.isSending = false;
    els.submitBtn.disabled = false;
    els.submitBtn.textContent = "Отправить";
    els.submitBtn.classList.remove("sending");
  }
});

document.addEventListener("click", (e) => {
  if (!contextMenu.contains(e.target)) closeContextMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeContextMenu();
});

initTheme();
initProxy();
restoreSession();
