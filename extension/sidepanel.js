import { buildSuggestedPrompts } from "./ai/context.js";

const els = {
  contextChip: document.getElementById("spContextChip"),
  modelSelect: document.getElementById("spModelSelect"),
  settingsBtn: document.getElementById("spSettingsBtn"),
  newChatBtn: document.getElementById("spNewChatBtn"),
  messages: document.getElementById("spMessages"),
  suggestions: document.getElementById("spSuggestions"),
  input: document.getElementById("spInput"),
  sendBtn: document.getElementById("spSendBtn")
};

let contextData = null;
let providers = [];
let activePort = null;
let activeAssistantNode = null;
let activeUserPrompt = "";
let chatHistory = []; // 多轮上下文：[{role, content}, ...]

init().catch((err) => {
  showCenterError(`初始化失败：${err?.message || err}`);
});

async function init() {
  bindEvents();
  await loadProvidersAndPrefs();
  await fetchContext();
  await fetchComments();
  renderSuggestions();
  if (!contextData) {
    showCenterError("当前页面不是 B 站视频页，无法读取视频信息。");
  } else if (!providers.length) {
    showCenterError(
      '还没有配置 AI 平台，<a href="#" id="spOpenSettings">前往设置 →</a>'
    );
    document.getElementById("spOpenSettings")?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }
}

function bindEvents() {
  els.sendBtn.addEventListener("click", sendMessage);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  els.input.addEventListener("input", autosizeInput);
  els.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.newChatBtn.addEventListener("click", restartChat);
}

function autosizeInput() {
  els.input.style.height = "auto";
  const next = Math.min(els.input.scrollHeight, 200);
  els.input.style.height = `${next}px`;
}

async function fetchContext() {
  const tab = await getActiveTab();
  if (!tab) return;
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "sidepanel-get-context" });
    if (resp?.ok && resp.payload) {
      contextData = resp.payload;
      updateContextChip();
    }
  } catch {
    // 非 B 站页或 content script 未注入
    contextData = null;
  }
}

async function fetchComments() {
  if (!contextData) return;
  const tab = await getActiveTab();
  if (!tab) return;
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "sidepanel-get-hot-comments" });
    if (resp?.ok && Array.isArray(resp.comments) && contextData) {
      contextData.hotComments = resp.comments;
      updateContextChip();
      renderSuggestions();
    }
  } catch {
    // 静默降级
  }
}

function updateContextChip() {
  if (!contextData) {
    els.contextChip.textContent = "无上下文";
    return;
  }
  const title = contextData.title ? truncate(contextData.title, 26) : "未知视频";
  const commentNote = contextData.hotComments?.length
    ? ` · ${contextData.hotComments.length} 条评论`
    : "";
  els.contextChip.textContent = `${title}${commentNote}`;
  els.contextChip.title = contextData.title || "";
}

function showCenterError(html) {
  const node = document.createElement("div");
  node.className = "sp-center-error";
  node.innerHTML = html;
  els.messages.appendChild(node);
  scrollToBottom();
}

function renderSuggestions() {
  if (!contextData || !els.suggestions) return;
  const prompts = buildSuggestedPrompts(contextData);
  els.suggestions.innerHTML = prompts
    .map((p) => `<button type="button" class="sp-chip">${escapeHtml(p)}</button>`)
    .join("");
  els.suggestions.querySelectorAll(".sp-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.input.value = btn.textContent;
      sendMessage();
    });
  });
}

async function loadProvidersAndPrefs() {
  const providersResp = await sendRuntimeMessage({ type: "ai-providers-list" });
  providers = Array.isArray(providersResp?.providers)
    ? providersResp.providers.filter((p) => p.enabled)
    : [];
  renderModelSelect();
}

function renderModelSelect() {
  if (!providers.length) {
    els.modelSelect.innerHTML = '<option value="">未配置平台</option>';
    els.modelSelect.disabled = true;
    return;
  }
  els.modelSelect.innerHTML = providers
    .map((p) => {
      const label = String(p.model || p.name || "").trim();
      return `<option value="${escapeHtml(p.id)}">${escapeHtml(label)}</option>`;
    })
    .join("");
  els.modelSelect.disabled = false;
}

async function sendMessage() {
  const text = els.input.value.trim();
  if (!text || els.sendBtn.disabled) return;
  const providerId = els.modelSelect.value;
  if (!providerId) {
    showCenterError("请先在设置页配置 AI 平台。");
    return;
  }
  if (!contextData) {
    showCenterError("请先打开一个 B 站视频页。");
    return;
  }

  if (activePort) {
    try { activePort.disconnect(); } catch {}
    activePort = null;
  }
  els.suggestions?.remove();

  appendUserMessage(text);
  els.input.value = "";
  autosizeInput();
  els.sendBtn.disabled = true;
  activeUserPrompt = text;
  activeAssistantNode = appendAssistantPlaceholder();

  activePort = chrome.runtime.connect({ name: "sidepanel-chat" });
  activePort.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "token") {
      appendToken(activeAssistantNode, msg.data);
    } else if (msg.type === "done") {
      finalizeAssistant(activeAssistantNode);
    } else if (msg.type === "error") {
      showAssistantError(activeAssistantNode, msg.error || "未知错误");
    }
  });
  activePort.onDisconnect.addListener(() => {
    els.sendBtn.disabled = false;
    activePort = null;
  });

  activePort.postMessage({
    action: "chat",
    providerId,
    context: contextData,
    prompt: text,
    history: chatHistory
  });
}

function appendUserMessage(text) {
  const node = document.createElement("div");
  node.className = "sp-msg sp-msg-user";
  node.textContent = text;
  els.messages.appendChild(node);
  scrollToBottom();
}

function appendAssistantPlaceholder() {
  const node = document.createElement("div");
  node.className = "sp-msg sp-msg-assistant";
  node.dataset.raw = "";
  const cursor = document.createElement("span");
  cursor.className = "sp-msg-cursor";
  node.appendChild(cursor);
  els.messages.appendChild(node);
  scrollToBottom();
  return node;
}

function appendToken(node, token) {
  if (!node) return;
  const raw = (node.dataset.raw || "") + String(token || "");
  node.dataset.raw = raw;
  // 边流边渲染：已确认字符走 markdown 解析，未确认尾巴用纯文本 + 光标
  // 简化：直接把 raw 全文做 markdown 渲染，再把光标挂在末尾
  node.innerHTML = renderMarkdown(raw) + '<span class="sp-msg-cursor"></span>';
  scrollToBottom();
}

function finalizeAssistant(node) {
  if (!node) return;
  const raw = node.dataset.raw || "";
  node.innerHTML = renderMarkdown(raw);
  // 把这一轮问答写入上下文，供下一轮拼接
  if (activeUserPrompt) {
    chatHistory.push({ role: "user", content: activeUserPrompt });
    chatHistory.push({ role: "assistant", content: raw });
    activeUserPrompt = "";
  }
  els.sendBtn.disabled = false;
  scrollToBottom();
}

function showAssistantError(node, error) {
  if (!node) return;
  const cursor = node.querySelector(".sp-msg-cursor");
  if (cursor) cursor.remove();
  const err = document.createElement("div");
  err.className = "sp-msg-error";
  err.textContent = `错误：${error}`;
  node.innerHTML = "";
  node.appendChild(err);
  // 错误也写入上下文：用户问过 + 助手报错，避免下次又重发同样的失败请求
  if (activeUserPrompt) {
    chatHistory.push({ role: "user", content: activeUserPrompt });
    chatHistory.push({ role: "assistant", content: `[错误] ${error}` });
    activeUserPrompt = "";
  }
  els.sendBtn.disabled = false;
  scrollToBottom();
}

function restartChat() {
  if (activePort) {
    try { activePort.disconnect(); } catch {}
    activePort = null;
  }
  activeAssistantNode = null;
  activeUserPrompt = "";
  chatHistory = [];
  // 清空消息流，只保留建议 chip 区
  els.messages.innerHTML = '<div class="sp-suggestions" id="spSuggestions"></div>';
  els.suggestions = document.getElementById("spSuggestions");
  renderSuggestions();
  els.sendBtn.disabled = false;
  els.input.value = "";
  autosizeInput();
}

function renderMarkdown(text) {
  // 小型 markdown 渲染：代码块、标题、列表、段落 + 行内 粗体/斜体/code/链接
  // 1) 先 escape，并把代码块抽出来用占位符保留
  let escaped = escapeHtml(text);
  const codeBlocks = [];
  escaped = escaped.replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return `BOC_CODE_${codeBlocks.length - 1}`;
  });

  const lines = escaped.split("\n");
  const out = [];
  const listStack = []; // "ul" | "ol"
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${renderInline(paraBuf.join(" "))}</p>`);
      paraBuf = [];
    }
  };
  const closeLists = () => {
    while (listStack.length) {
      const t = listStack.pop();
      out.push(t === "ul" ? "</ul>" : "</ol>");
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // 代码块占位
    const codeMatch = line.match(/^BOC_CODE_(\d+)$/);
    if (codeMatch) {
      flushPara();
      closeLists();
      out.push(`<pre><code>${codeBlocks[Number(codeMatch[1])]}</code></pre>`);
      continue;
    }

    // 标题（# / ## / ###）
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushPara();
      closeLists();
      const level = heading[1].length + 2; // # -> h3, ## -> h4, ### -> h5
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    // 无序列表
    const ul = line.match(/^[-*+]\s+(.+)$/);
    if (ul) {
      flushPara();
      if (listStack[listStack.length - 1] !== "ul") {
        listStack.push("ul");
        out.push("<ul>");
      }
      out.push(`<li>${renderInline(ul[1])}</li>`);
      continue;
    }

    // 有序列表
    const ol = line.match(/^\d+\.\s+(.+)$/);
    if (ol) {
      flushPara();
      if (listStack[listStack.length - 1] !== "ol") {
        listStack.push("ol");
        out.push("<ol>");
      }
      out.push(`<li>${renderInline(ol[1])}</li>`);
      continue;
    }

    // 空行：闭合段落和列表
    if (!line) {
      flushPara();
      closeLists();
      continue;
    }

    paraBuf.push(line);
  }

  flushPara();
  closeLists();

  return out.join("");
}

function renderInline(text) {
  return text
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre, c) => `${pre}<em>${c}</em>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
      const safeUrl = /^(https?:|mailto:|#)/i.test(u) ? u : "#";
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    });
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncate(value, max) {
  const s = String(value || "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}