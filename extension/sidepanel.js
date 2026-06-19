import { buildSuggestedPrompts } from "./ai/context.js";

const SELECTED_PROVIDER_KEY = "boc_ai_selected_provider";

const els = {
  contextChip: document.getElementById("spContextChip"),
  refreshBtn: document.getElementById("spRefreshBtn"),
  modelSelect: document.getElementById("spModelSelect"),
  settingsBtn: document.getElementById("spSettingsBtn"),
  newChatBtn: document.getElementById("spNewChatBtn"),
  presetBtn: document.getElementById("spPresetBtn"),
  presetPopover: document.getElementById("spPresetPopover"),
  presetList: document.getElementById("spPresetList"),
  presetInput: document.getElementById("spPresetInput"),
  presetAddBtn: document.getElementById("spPresetAddBtn"),
  messages: document.getElementById("spMessages"),
  input: document.getElementById("spInput"),
};

const DEFAULT_AI_PREFS = {
  aiSystemPrompt: "",
  aiPresetPrompts: []
};

let contextData = null;
let currentContextKey = "";
let providers = [];
let activePort = null;
let activeAssistantNode = null;
let activeUserPrompt = "";
let chatHistory = [];
let suggestionsNode = null;
let aiPrefs = { ...DEFAULT_AI_PREFS };

init().catch((err) => {
  resetConversationView(`初始化失败：${escapeHtml(err?.message || err)}`);
});

async function init() {
  bindEvents();
  await loadProvidersAndPrefs();
  await loadContextState();
  renderInitialState();
  autosizeInput();
}

function bindEvents() {
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  els.input.addEventListener("input", autosizeInput);
  els.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.newChatBtn.addEventListener("click", () => restartChat());
  els.refreshBtn.addEventListener("click", () => refreshContextManually());
  els.presetBtn.addEventListener("click", togglePresetPopover);
  els.presetAddBtn.addEventListener("click", addPresetPrompt);
  els.presetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      addPresetPrompt();
    }
  });
  els.modelSelect.addEventListener("change", () => {
    if (els.modelSelect.value) {
      localStorage.setItem(SELECTED_PROVIDER_KEY, els.modelSelect.value);
    }
  });
  document.addEventListener("click", handleDocumentClick);
}

function autosizeInput() {
  els.input.style.height = "auto";
  const next = Math.min(els.input.scrollHeight, 320);
  els.input.style.height = `${Math.max(next, 94)}px`;
}

async function loadProvidersAndPrefs() {
  const [providersResp, settingsResp] = await Promise.all([
    sendRuntimeMessage({ type: "ai-providers-list" }),
    sendRuntimeMessage({ type: "get-settings" }).catch(() => ({ ok: false }))
  ]);
  providers = Array.isArray(providersResp?.providers)
    ? providersResp.providers.filter((p) => p.enabled)
    : [];
  aiPrefs = {
    aiSystemPrompt: String(settingsResp?.settings?.aiSystemPrompt || "").trim(),
    aiPresetPrompts: Array.isArray(settingsResp?.settings?.aiPresetPrompts)
      ? settingsResp.settings.aiPresetPrompts.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12)
      : []
  };
  renderModelSelect();
  renderPresetPrompts();
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

  const savedProviderId = localStorage.getItem(SELECTED_PROVIDER_KEY) || "";
  const matchedProvider = providers.find((item) => item.id === savedProviderId) || providers[0];
  els.modelSelect.value = matchedProvider?.id || "";
  els.modelSelect.disabled = false;
}

async function loadContextState({ forceRefresh = false, silent = false } = {}) {
  const tab = await getActiveTab();
  if (!tab?.id) {
    contextData = null;
    updateContextChip();
    if (!silent) {
      resetConversationView("找不到当前标签页。");
    }
    return false;
  }

  const resp = await sendRuntimeMessage({
    type: "ai-sidepanel-get-state",
    tabId: tab.id,
    forceRefresh
  }).catch((error) => ({ ok: false, error: error.message }));

  if (!resp?.ok || !resp.payload) {
    contextData = null;
    currentContextKey = "";
    updateContextChip();
    if (!silent) {
      resetConversationView(resp?.error || "当前页面上下文读取失败。");
    }
    return false;
  }

  applyContextPayload(resp.payload);
  return true;
}

function applyContextPayload(payload) {
  const nextContext = payload && typeof payload === "object" ? payload : null;
  const nextKey = buildContextKey(nextContext);
  const contextChanged = Boolean(currentContextKey && nextKey && nextKey !== currentContextKey);

  contextData = nextContext;
  currentContextKey = nextKey;
  updateContextChip();

  if (contextChanged) {
    restartChat({ keepContext: true });
  } else {
    renderSuggestions();
  }
}

function buildContextKey(payload) {
  if (!payload) {
    return "";
  }
  return [payload.bvid || "", payload.cid || "", payload.url || ""].join("|");
}

function updateContextChip() {
  if (!contextData) {
    els.contextChip.textContent = "无上下文";
    els.contextChip.title = "";
    return;
  }

  const shortTitle = contextData.title ? truncate(contextData.title, 11) : "未知视频";
  els.contextChip.textContent = shortTitle;
  els.contextChip.title = contextData.title || "";
}

function renderInitialState() {
  if (!contextData) {
    resetConversationView("当前页面不是 B 站视频页，无法读取视频信息。");
    return;
  }
  if (!providers.length) {
    resetConversationView('还没有配置 AI 平台，<a href="#" id="spOpenSettings">前往设置</a>');
    document.getElementById("spOpenSettings")?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    return;
  }
  resetConversationView("");
}

function resetConversationView(stateHtml = "") {
  els.messages.innerHTML = "";
  if (stateHtml) {
    const stateNode = document.createElement("div");
    stateNode.className = "sp-center-error";
    stateNode.innerHTML = stateHtml;
    els.messages.appendChild(stateNode);
  }
  suggestionsNode = document.createElement("div");
  suggestionsNode.className = "sp-suggestions";
  suggestionsNode.id = "spSuggestions";
  els.messages.appendChild(suggestionsNode);
  renderSuggestions();
  renderPresetPrompts();
  scrollToBottom();
}

function renderSuggestions() {
  if (!suggestionsNode) {
    return;
  }
  if (!contextData || !providers.length || chatHistory.length) {
    suggestionsNode.innerHTML = "";
    return;
  }
  const prompts = buildSuggestedPrompts(contextData);
  suggestionsNode.innerHTML = prompts
    .map((prompt) => `<button type="button" class="sp-chip">${escapeHtml(prompt)}</button>`)
    .join("");
  suggestionsNode.querySelectorAll(".sp-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.input.value = btn.textContent || "";
      autosizeInput();
      sendMessage();
    });
  });
}

function renderPresetPrompts() {
  if (!els.presetList) {
    return;
  }
  const prompts = Array.isArray(aiPrefs.aiPresetPrompts) ? aiPrefs.aiPresetPrompts : [];
  if (!prompts.length) {
    els.presetList.innerHTML = '<span class="sp-preset-empty">还没有预设提示词</span>';
    return;
  }
  els.presetList.innerHTML = prompts
    .map((prompt, index) => `
      <span class="sp-preset-item">
        <button type="button" class="sp-preset-chip" data-index="${index}" title="${escapeHtml(prompt)}">${escapeHtml(prompt)}</button>
        <button type="button" class="sp-preset-remove" data-index="${index}" aria-label="删除预设提示词">×</button>
      </span>
    `)
    .join("");
  els.presetList.querySelectorAll(".sp-preset-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const index = Number(btn.getAttribute("data-index") || -1);
      insertPresetPrompt(prompts[index] || "");
      hidePresetPopover();
    });
  });
  els.presetList.querySelectorAll(".sp-preset-remove").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const index = Number(btn.getAttribute("data-index") || -1);
      await removePresetPrompt(index);
    });
  });
}

function insertPresetPrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text) {
    return;
  }
  const current = els.input.value.trim();
  els.input.value = current ? `${current}\n${text}` : text;
  els.input.focus();
  autosizeInput();
}

function togglePresetPopover(event) {
  event?.stopPropagation();
  const willShow = els.presetPopover.hidden;
  els.presetPopover.hidden = !willShow;
  if (willShow) {
    renderPresetPrompts();
    els.presetInput.value = "";
    els.presetInput.focus();
  }
}

function hidePresetPopover() {
  els.presetPopover.hidden = true;
}

function handleDocumentClick(event) {
  if (els.presetPopover.hidden) {
    return;
  }
  if (!(event.target instanceof Element)) {
    hidePresetPopover();
    return;
  }
  if (event.target.closest("#spPresetPopover") || event.target.closest("#spPresetBtn")) {
    return;
  }
  hidePresetPopover();
}

async function addPresetPrompt() {
  const text = String(els.presetInput.value || "").trim();
  if (!text) {
    return;
  }
  const nextPrompts = [...(aiPrefs.aiPresetPrompts || [])];
  if (!nextPrompts.includes(text)) {
    nextPrompts.push(text);
  }
  aiPrefs.aiPresetPrompts = nextPrompts.slice(0, 12);
  await persistAiPresetPrompts();
  els.presetInput.value = "";
  renderPresetPrompts();
}

async function removePresetPrompt(index) {
  if (index < 0) {
    return;
  }
  aiPrefs.aiPresetPrompts = (aiPrefs.aiPresetPrompts || []).filter((_, itemIndex) => itemIndex !== index);
  await persistAiPresetPrompts();
  renderPresetPrompts();
}

async function persistAiPresetPrompts() {
  const settingsResp = await sendRuntimeMessage({ type: "get-settings" }).catch(() => ({ ok: false }));
  if (!settingsResp?.ok || !settingsResp.settings) {
    return;
  }
  const nextSettings = {
    ...settingsResp.settings,
    aiPresetPrompts: (aiPrefs.aiPresetPrompts || []).slice(0, 12)
  };
  await sendRuntimeMessage({ type: "save-settings", settings: nextSettings }).catch(() => null);
}

async function refreshContextManually() {
  if (els.refreshBtn.disabled) {
    return;
  }
  setRefreshing(true);
  try {
    const ok = await loadContextState({ forceRefresh: true });
    if (ok) {
      if (!contextData || !providers.length || !chatHistory.length) {
        renderInitialState();
      } else {
        renderSuggestions();
      }
    }
  } finally {
    setRefreshing(false);
  }
}

function setRefreshing(isRefreshing) {
  els.refreshBtn.disabled = isRefreshing;
  els.refreshBtn.textContent = isRefreshing ? "…" : "↻";
}

async function ensureCurrentContextForSend() {
  const previousKey = currentContextKey;
  const ok = await loadContextState({ forceRefresh: false, silent: true });
  if (!ok || !contextData) {
    resetConversationView("当前页面上下文读取失败。");
    return false;
  }
  if (previousKey && currentContextKey && previousKey !== currentContextKey) {
    restartChat({ keepContext: true });
  }
  return true;
}

async function sendMessage() {
  const text = els.input.value.trim();
  if (!text || activePort) {
    return;
  }

  const providerId = els.modelSelect.value;
  if (!providerId) {
    resetConversationView("请先在设置页配置并启用一个 AI 平台。");
    return;
  }

  const hasContext = await ensureCurrentContextForSend();
  if (!hasContext) {
    return;
  }

  if (activePort) {
    try {
      activePort.disconnect();
    } catch {}
    activePort = null;
  }

  suggestionsNode?.remove();
  suggestionsNode = null;
  removeCenteredState();

  appendUserMessage(text);
  els.input.value = "";
  autosizeInput();
  els.input.disabled = true;
  activeUserPrompt = text;
  activeAssistantNode = appendAssistantPlaceholder();

  activePort = chrome.runtime.connect({ name: "sidepanel-chat" });
  activePort.onMessage.addListener((msg) => {
    if (!msg) {
      return;
    }
    if (msg.type === "token") {
      appendToken(activeAssistantNode, msg.data);
    } else if (msg.type === "done") {
      finalizeAssistant(activeAssistantNode);
    } else if (msg.type === "error") {
      showAssistantError(activeAssistantNode, msg.error || "未知错误");
    }
  });
  activePort.onDisconnect.addListener(() => {
    els.input.disabled = false;
    activePort = null;
  });

  activePort.postMessage({
    action: "chat",
    providerId,
    context: {
      ...contextData,
      aiSystemPrompt: aiPrefs.aiSystemPrompt
    },
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
  if (!node) {
    return;
  }
  const raw = (node.dataset.raw || "") + String(token || "");
  node.dataset.raw = raw;
  node.innerHTML = renderMarkdown(raw) + '<span class="sp-msg-cursor"></span>';
  scrollToBottom();
}

function finalizeAssistant(node) {
  if (!node) {
    return;
  }
  const raw = node.dataset.raw || "";
  renderAssistantMessage(node, raw);
  if (activeUserPrompt && raw) {
    chatHistory.push({ role: "user", content: activeUserPrompt });
    chatHistory.push({ role: "assistant", content: raw });
    activeUserPrompt = "";
  }
  if (activePort) {
    try {
      activePort.disconnect();
    } catch {}
    activePort = null;
  }
  els.input.disabled = false;
  els.input.focus();
  scrollToBottom();
}

function showAssistantError(node, error) {
  if (!node) {
    return;
  }
  node.innerHTML = "";
  const err = document.createElement("div");
  err.className = "sp-msg-error";
  err.textContent = `错误：${error}`;
  node.appendChild(err);
  activeUserPrompt = "";
  if (activePort) {
    try {
      activePort.disconnect();
    } catch {}
    activePort = null;
  }
  els.input.disabled = false;
  els.input.focus();
  scrollToBottom();
}

function renderAssistantMessage(node, raw) {
  if (!node) {
    return;
  }
  node.innerHTML = "";
  const cleanedRaw = stripThinkBlocks(raw);

  const content = document.createElement("div");
  content.className = "sp-msg-assistant-body";
  content.innerHTML = renderMarkdown(cleanedRaw);
  node.appendChild(content);

  const actions = document.createElement("div");
  actions.className = "sp-msg-actions";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "sp-msg-copy-btn";
  copyBtn.setAttribute("aria-label", "复制回复");
  copyBtn.setAttribute("title", "复制回复");
  copyBtn.innerHTML = `
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <rect x="9" y="9" width="10" height="10" rx="2"></rect>
      <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1"></path>
    </svg>
  `;
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(cleanedRaw);
      copyBtn.disabled = true;
      window.setTimeout(() => {
        copyBtn.disabled = false;
      }, 500);
    } catch {
      copyBtn.disabled = true;
      window.setTimeout(() => {
        copyBtn.disabled = false;
      }, 500);
    }
  });
  actions.appendChild(copyBtn);
  node.appendChild(actions);
}

function restartChat({ keepContext = false } = {}) {
  if (activePort) {
    try {
      activePort.disconnect();
    } catch {}
    activePort = null;
  }

  activeAssistantNode = null;
  activeUserPrompt = "";
  chatHistory = [];
  if (!keepContext) {
    currentContextKey = buildContextKey(contextData);
  }
  resetConversationView("");
  els.input.disabled = false;
  els.input.value = "";
  autosizeInput();
}

function removeCenteredState() {
  els.messages.querySelectorAll(".sp-center-error").forEach((node) => node.remove());
}

function renderMarkdown(text) {
  let escaped = escapeHtml(stripThinkBlocks(text));
  const codeBlocks = [];
  escaped = escaped.replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return `\u0001BOC_CODE_${codeBlocks.length - 1}\u0001`;
  });

  const lines = escaped.split("\n");
  const out = [];
  let listType = "";
  let listStartNumber = 1;
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${renderInline(paraBuf.join(" "))}</p>`);
      paraBuf = [];
    }
  };
  const closeList = () => {
    if (!listType) {
      return;
    }
    out.push(listType === "ul" ? "</ul>" : "</ol>");
    listType = "";
    listStartNumber = 1;
  };
  const openList = (nextType, startNumber = 1) => {
    if (listType === nextType && (nextType !== "ol" || listStartNumber === startNumber)) {
      return;
    }
    closeList();
    listType = nextType;
    listStartNumber = nextType === "ol" ? startNumber : 1;
    if (nextType === "ul") {
      out.push("<ul>");
      return;
    }
    out.push(startNumber > 1 ? `<ol start="${startNumber}">` : "<ol>");
  };
  const getNextListType = (startIndex) => {
    for (let index = startIndex; index < lines.length; index += 1) {
      const nextLine = lines[index].trim();
      if (!nextLine) {
        continue;
      }
      if (/^[-*+]\s+(.+)$/.test(nextLine)) {
        return "ul";
      }
      if (/^\d+\.\s+(.+)$/.test(nextLine)) {
        return "ol";
      }
      break;
    }
    return "";
  };
  const isTableSeparatorLine = (value) => /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(value);
  const isTableRowLine = (value) => /^\|.+\|$/.test(value);
  const splitTableCells = (value) =>
    value
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => renderInline(cell.trim()));

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    const codeMatch = line.match(/^\u0001BOC_CODE_(\d+)\u0001$/);
    if (codeMatch) {
      flushPara();
      closeList();
      out.push(`<pre><code>${codeBlocks[Number(codeMatch[1])]}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length + 2;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (
      isTableRowLine(line) &&
      index + 1 < lines.length &&
      isTableSeparatorLine(lines[index + 1].trim())
    ) {
      flushPara();
      closeList();
      const headers = splitTableCells(line);
      const bodyRows = [];
      index += 2;
      while (index < lines.length) {
        const tableLine = lines[index].trim();
        if (!isTableRowLine(tableLine)) {
          index -= 1;
          break;
        }
        bodyRows.push(splitTableCells(tableLine));
        index += 1;
      }
      out.push(
        `<table><thead><tr>${headers.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${
          bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")
        }</tbody></table>`
      );
      continue;
    }

    const ul = line.match(/^[-*+]\s+(.+)$/);
    if (ul) {
      flushPara();
      openList("ul");
      out.push(`<li>${renderInline(ul[1])}</li>`);
      continue;
    }

    const ol = line.match(/^(\d+)\.\s+(.+)$/);
    if (ol) {
      flushPara();
      const orderNumber = Number(ol[1]) || 1;
      openList("ol", orderNumber);
      out.push(`<li>${renderInline(ol[2])}</li>`);
      continue;
    }

    if (!line) {
      flushPara();
      if (listType && getNextListType(index + 1) === listType) {
        continue;
      }
      closeList();
      continue;
    }

    paraBuf.push(line);
  }

  flushPara();
  closeList();
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

function stripThinkBlocks(text) {
  return String(text || "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<\/think>/gi, "")
    .replace(/^\s*<\/?think\b[^>]*>\s*$/gim, "")
    .trim();
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
  return s.length > max ? s.slice(0, max) + "..." : s;
}
