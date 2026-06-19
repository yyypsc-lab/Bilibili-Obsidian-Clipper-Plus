const DEFAULT_SYNC_SETTINGS = {
  noteFolder: "Clippings/Bilibili",
  obsidianApiBaseUrl: "http://127.0.0.1:27123",
  tags: "clippings,bilibili",
  downloadFormat: "srt",
  includeDateInFilename: true,
  includeTimestampInBody: true,
  enableDebugLogs: false,
  readerTheme: "light",
  readerFontScale: "m",
  readerLetterSpacing: "normal",
  readerLineHeight: "tight",
  readerContentWidth: "medium",
  readerChapterVisibility: "show",
  readerTranscriptVisible: true,
  frontmatterFields: [
    "title",
    "url",
    "bvid",
    "cid",
    "author",
    "upload_date",
    "subtitle_lang",
    "created",
    "tags"
  ],
  fixedFrontmatterProperties: [],
  aiSystemPrompt: "结合字幕与评论理解视频，先给结论，再提炼重点，表达简洁，不要输出思考过程或 think 标签。",
  aiPresetPrompts: []
};

const DEFAULT_LOCAL_SETTINGS = {
  obsidianApiKey: ""
};
const EXPECTED_CONTENT_SCRIPT_VERSION = chrome.runtime.getManifest().version || "";

chrome.runtime.onInstalled.addListener(async () => {
  await initializeSettingsStorage();
});

async function ensureReaderContentReady(tabId) {
  if (!chrome.scripting || !tabId) {
    return;
  }

  const loadedVersion = await probeContentScriptVersion(tabId);
  if (loadedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
    return;
  }

  await injectReaderContent(tabId);
  const reinjectedVersion = await probeContentScriptVersion(tabId);
  if (reinjectedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
    return;
  }

  if (loadedVersion && loadedVersion !== EXPECTED_CONTENT_SCRIPT_VERSION) {
    await chrome.tabs.reload(tabId);
    const ready = await waitForTabComplete(tabId);
    if (!ready) {
      throw new Error("扩展更新后页面未及时恢复，请刷新浏览器网页重试");
    }
    await sleep(120);
    await injectReaderContent(tabId);
    const reloadedVersion = await probeContentScriptVersion(tabId);
    if (reloadedVersion === EXPECTED_CONTENT_SCRIPT_VERSION) {
      return;
    }
  }

  throw new Error("扩展脚本未能和当前页面同步，请刷新浏览器网页重试");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeContentScriptVersion(tabId) {
  try {
    const probe = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__BOC_CONTENT_SCRIPT_LOADED__ || ""
    });
    return String(probe?.[0]?.result || "");
  } catch {
    return "";
  }
}

async function injectReaderContent(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content.css"]
  });

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (!message.includes("Identifier 'DEFAULT_SETTINGS' has already been declared")) {
      throw error;
    }
  }
}

async function waitForTabComplete(tabId, retries = 40, delayMs = 250) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") {
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

async function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

async function triggerReaderModeInTab(tabId, readerUrl = "", retries = 12, delayMs = 300) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) {
      await sleep(delayMs);
    }

    try {
      const response = await sendMessageToTab(tabId, {
        type: "popup-trigger-reading-view",
        readerUrl
      });
      if (response?.ok) {
        return true;
      }
    } catch (error) {
      const message = String(error?.message || "");
      if (message.includes("Could not establish connection. Receiving end does not exist.")) {
        try {
          await ensureReaderContentReady(tabId);
        } catch {
          // keep retrying
        }
        continue;
      }
    }
  }

  return false;
}

function isSupportedAiTabUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.hostname !== "www.bilibili.com") {
      return false;
    }
    return (
      parsed.pathname === "/list/watchlater" ||
      parsed.pathname === "/list/watchlater/" ||
      parsed.pathname.startsWith("/video/")
    );
  } catch {
    return false;
  }
}

async function getAiSidepanelState(tabId, { forceRefresh = false } = {}) {
  if (!tabId) {
    throw new Error("缺少标签页信息");
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id || !isSupportedAiTabUrl(tab.url)) {
    throw new Error("请先打开一个 B 站视频页。");
  }

  await ensureReaderContentReady(tab.id);

  let contextResp = await sendMessageToTab(tab.id, { type: "sidepanel-get-context" });
  const hasPayload = Boolean(contextResp?.ok && contextResp?.payload);
  const hasLoadedClip = Boolean(
    contextResp?.payload?.bvid ||
    contextResp?.payload?.aid ||
    contextResp?.payload?.title
  );
  const needsRefresh =
    forceRefresh ||
    !hasPayload ||
    (!hasLoadedClip && (!Array.isArray(contextResp.payload.subtitleBody) || !contextResp.payload.subtitleBody.length));

  if (needsRefresh) {
    const refreshResp = await sendMessageToTab(tab.id, { type: "popup-refresh" });
    if (!refreshResp?.ok) {
      throw new Error(refreshResp?.error || "当前视频上下文加载失败");
    }
    contextResp = await sendMessageToTab(tab.id, { type: "sidepanel-get-context" });
  }

  if (!contextResp?.ok || !contextResp?.payload) {
    throw new Error("当前页面上下文读取失败");
  }

  let hotComments = [];
  try {
    const commentsResp = await sendMessageToTab(tab.id, { type: "sidepanel-get-hot-comments" });
    if (commentsResp?.ok && Array.isArray(commentsResp.comments)) {
      hotComments = commentsResp.comments;
    }
  } catch {
    // 评论失败时静默降级，避免阻断主流程
  }

  return {
    ...contextResp.payload,
    hotComments
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "get-settings") {
    getMergedSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "save-settings") {
    saveSettings(message.settings || {})
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "open-options") {
    chrome.tabs
      .create({ url: chrome.runtime.getURL("options.html") })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "open-reading-view-tab") {
    const url = String(message.url || "").trim();
    const tabId = Number(message.tabId || 0) || 0;
    if (!url) {
      sendResponse({ ok: false, error: "缺少视频地址" });
      return false;
    }
    if (!tabId) {
      sendResponse({ ok: false, error: "缺少标签页信息" });
      return false;
    }

    let readerUrl = "";
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== "www.bilibili.com") {
        throw new Error("当前网页不是 B 站视频页");
      }
      parsed.searchParams.set("boc_reader", "1");
      readerUrl = parsed.toString();
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "阅读视图地址无效" });
      return false;
    }

    ensureReaderContentReady(tabId)
      .then(() => triggerReaderModeInTab(tabId, readerUrl))
      .then((triggered) => {
        if (!triggered) {
          throw new Error("阅读视图触发失败，请刷新浏览器网页重试");
        }
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "fetch-json") {
    const url = typeof message.url === "string" ? message.url : "";
    if (!url) {
      sendResponse({ ok: false, error: "Missing subtitle URL" });
      return false;
    }

    const isBiliRequest = /(?:api\.bilibili\.com|hdslb\.com)/.test(url);
    const headers = new Headers();
    if (isBiliRequest) {
      headers.set("Accept", "application/json, text/plain, */*");
      headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
      headers.set("Cache-Control", "no-cache");
      headers.set("Pragma", "no-cache");
    }

    const fetchOptions = {
      method: "GET",
      credentials: "include",
      cache: "no-store"
    };
    if (headers.size > 0) {
      fetchOptions.headers = headers;
    }
    if (isBiliRequest) {
      fetchOptions.referrer = "https://www.bilibili.com/";
      fetchOptions.referrerPolicy = "strict-origin-when-cross-origin";
    }

    fetch(url, fetchOptions)
      .then(async (response) => {
        if (!response.ok) {
          sendResponse({ ok: false, error: `HTTP ${response.status}` });
          return;
        }

        const text = await response.text();
        try {
          const data = JSON.parse(text);
          sendResponse({ ok: true, data });
        } catch {
          sendResponse({ ok: false, error: "Invalid JSON response" });
        }
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "write-obsidian-note") {
    const baseUrl = String(message.baseUrl || "").trim();
    const apiKey = String(message.apiKey || "").trim();
    const filepath = String(message.filepath || "").trim();
    const content = typeof message.content === "string" ? message.content : "";

    if (!baseUrl || !apiKey || !filepath) {
      sendResponse({ ok: false, error: "缺少 Local REST API 参数" });
      return false;
    }

    const encodedPath = filepath
      .split("/")
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const endpoint = `${baseUrl.replace(/\/+$/g, "")}/vault/${encodedPath}`;

    fetch(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "text/markdown; charset=utf-8"
      },
      body: content
    })
      .then(async (response) => {
        if (!response.ok) {
          const bodyText = await response.text().catch(() => "");
          const detail = bodyText ? ` ${bodyText.slice(0, 200)}` : "";
          sendResponse({ ok: false, error: `HTTP ${response.status}.${detail}` });
          return;
        }
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message.type === "test-obsidian-connection") {
    const baseUrl = String(message.baseUrl || "").trim();
    const apiKey = String(message.apiKey || "").trim();

    if (!baseUrl || !apiKey) {
      sendResponse({ ok: false, error: "缺少 Local REST API 参数" });
      return false;
    }

    const endpoint = `${baseUrl.replace(/\/+$/g, "")}/`;
    fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json, text/plain, */*"
      },
      cache: "no-store"
    })
      .then(async (response) => {
        const bodyText = await response.text().catch(() => "");
        let data = null;
        try {
          data = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          data = null;
        }

        if (!response.ok) {
          const detail = bodyText ? ` ${bodyText.slice(0, 200)}` : "";
          sendResponse({ ok: false, error: `HTTP ${response.status}.${detail}` });
          return;
        }

        if (data && data.authenticated === false) {
          sendResponse({ ok: false, error: "API Key 无效或未授权" });
          return;
        }

        sendResponse({
          ok: true,
          service: typeof data?.service === "string" ? data.service : "Obsidian Local REST API"
        });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: formatConnectionError(error) });
      });

    return true;
  }

  if (message.type === "ai-providers-list") {
    loadAiProviders()
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-providers-save") {
    saveAiProviders(message.providers || [])
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-provider-set-key") {
    saveAiProviderKey(String(message.providerId || ""), String(message.apiKey || ""))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-providers-delete") {
    deleteAiProvider(String(message.providerId || ""))
      .then((items) => sendResponse({ ok: true, providers: items }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-providers-test") {
    const baseUrl = String(message.baseUrl || "").trim();
    const providerId = String(message.providerId || "").trim();
    const model = String(message.model || "").trim();
    if (!baseUrl) {
      sendResponse({ ok: false, error: "请填写 baseUrl" });
      return false;
    }
    Promise.resolve()
      .then(async () => {
        const directApiKey = String(message.apiKey || "").trim();
        if (directApiKey) {
          return directApiKey;
        }
        if (!providerId) {
          return "";
        }
        const keys = await loadAiProviderKeys();
        return String(keys[providerId] || "").trim();
      })
      .then((apiKey) => testAiConnection({ baseUrl, apiKey, model }))
      .then((resp) => sendResponse(resp))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ai-sidepanel-get-state") {
    const tabId = Number(message.tabId || 0) || 0;
    const forceRefresh = message.forceRefresh === true;
    getAiSidepanelState(tabId, { forceRefresh })
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== "sidepanel-chat") {
    return;
  }

  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.action !== "chat") return;

    try {
      const providers = await loadAiProviders();
      const provider = providers.find((p) => p.id === msg.providerId);
      if (!provider) {
        port.postMessage({ type: "error", error: "未找到选中的平台" });
        return;
      }
      const keys = await loadAiProviderKeys();
      const apiKey = keys[provider.id] || "";
      if (provider.requiresKey !== false && !apiKey) {
        port.postMessage({ type: "error", error: "该平台 API Key 未配置" });
        return;
      }
      await streamChat({
        provider: { ...provider, apiKey },
        context: msg.context || {},
        userPrompt: msg.prompt || "",
        history: Array.isArray(msg.history) ? msg.history : [],
        port
      });
    } catch (e) {
      port.postMessage({ type: "error", error: String(e?.message || e) });
    }
  });
});

async function initializeSettingsStorage() {
  const syncCurrent = await chrome.storage.sync.get(DEFAULT_SYNC_SETTINGS);
  const localCurrent = await chrome.storage.local.get(DEFAULT_LOCAL_SETTINGS);

  await chrome.storage.sync.set({ ...DEFAULT_SYNC_SETTINGS, ...syncCurrent });
  await chrome.storage.local.set({
    obsidianApiKey: normalizeApiKey(localCurrent.obsidianApiKey)
  });

  const legacySyncApiKey = normalizeApiKey(syncCurrent.obsidianApiKey);
  const localApiKey = normalizeApiKey(localCurrent.obsidianApiKey);
  if (!localApiKey && legacySyncApiKey) {
    await chrome.storage.local.set({ obsidianApiKey: legacySyncApiKey });
  }

  if ("obsidianApiKey" in syncCurrent) {
    await chrome.storage.sync.remove("obsidianApiKey");
  }
}

async function getMergedSettings() {
  const [syncSettings, localSettings] = await Promise.all([
    chrome.storage.sync.get(DEFAULT_SYNC_SETTINGS),
    chrome.storage.local.get(DEFAULT_LOCAL_SETTINGS)
  ]);

  const merged = { ...DEFAULT_SYNC_SETTINGS, ...syncSettings };
  merged.downloadFormat = normalizeDownloadFormat(merged.downloadFormat);
  merged.readerTheme = normalizeReaderTheme(merged.readerTheme);
  merged.readerFontScale = normalizeReaderFontScale(merged.readerFontScale);
  merged.readerLetterSpacing = normalizeReaderLetterSpacing(merged.readerLetterSpacing ?? merged.readerLineHeight);
  merged.readerLineHeight = normalizeReaderLineHeight(merged.readerLineHeight);
  merged.readerContentWidth = normalizeReaderContentWidth(merged.readerContentWidth);
  merged.readerChapterVisibility = normalizeReaderChapterVisibility(merged.readerChapterVisibility);
  merged.readerTranscriptVisible = normalizeReaderTranscriptVisible(merged.readerTranscriptVisible);
  merged.fixedFrontmatterProperties = normalizeFixedFrontmatterProperties(merged.fixedFrontmatterProperties);
  merged.aiSystemPrompt = normalizeAiSystemPrompt(merged.aiSystemPrompt);
  merged.aiPresetPrompts = normalizeAiPresetPrompts(merged.aiPresetPrompts);
  let apiKey = normalizeApiKey(localSettings.obsidianApiKey);
  const legacySyncApiKey = normalizeApiKey(syncSettings.obsidianApiKey);

  if (!apiKey && legacySyncApiKey) {
    apiKey = legacySyncApiKey;
    await chrome.storage.local.set({ obsidianApiKey: apiKey });
    await chrome.storage.sync.remove("obsidianApiKey");
  }

  return {
    ...merged,
    obsidianApiKey: apiKey
  };
}

async function saveSettings(settings) {
  const payload = settings && typeof settings === "object" ? settings : {};
  const syncPayload = { ...payload };
  delete syncPayload.obsidianApiKey;
  syncPayload.downloadFormat = normalizeDownloadFormat(syncPayload.downloadFormat);
  syncPayload.readerTheme = normalizeReaderTheme(syncPayload.readerTheme);
  syncPayload.readerFontScale = normalizeReaderFontScale(syncPayload.readerFontScale);
  syncPayload.readerLetterSpacing = normalizeReaderLetterSpacing(
    syncPayload.readerLetterSpacing ?? syncPayload.readerLineHeight
  );
  syncPayload.readerLineHeight = normalizeReaderLineHeight(syncPayload.readerLineHeight);
  syncPayload.readerContentWidth = normalizeReaderContentWidth(syncPayload.readerContentWidth);
  syncPayload.readerChapterVisibility = normalizeReaderChapterVisibility(syncPayload.readerChapterVisibility);
  syncPayload.readerTranscriptVisible = normalizeReaderTranscriptVisible(syncPayload.readerTranscriptVisible);
  syncPayload.fixedFrontmatterProperties = normalizeFixedFrontmatterProperties(syncPayload.fixedFrontmatterProperties);
  syncPayload.aiSystemPrompt = normalizeAiSystemPrompt(syncPayload.aiSystemPrompt);
  syncPayload.aiPresetPrompts = normalizeAiPresetPrompts(syncPayload.aiPresetPrompts);

  await Promise.all([
    chrome.storage.sync.set(syncPayload),
    chrome.storage.local.set({
      obsidianApiKey: normalizeApiKey(payload.obsidianApiKey)
    })
  ]);
}

function toString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeApiKey(value) {
  return toString(value).trim().replace(/^Bearer\s+/i, "").trim();
}

function normalizeDownloadFormat(value) {
  return value === "txt" ? "txt" : "srt";
}

function normalizeReaderTheme(value) {
  return value === "dark" || value === "paper" ? value : "light";
}

function normalizeReaderFontScale(value) {
  return ["xs", "s", "m", "l", "xl"].includes(value) ? value : "m";
}

function normalizeReaderLetterSpacing(value) {
  return ["tighter", "tight", "normal", "relaxed", "loose"].includes(value) ? value : "normal";
}

function normalizeReaderLineHeight(value) {
  return ["compact", "tight", "normal", "relaxed", "loose"].includes(value) ? value : "tight";
}

function normalizeReaderContentWidth(value) {
  return ["compact", "narrow", "medium", "wide", "full"].includes(value) ? value : "medium";
}

function normalizeReaderChapterVisibility(value) {
  return value === "hide" || value === "auto" ? value : "show";
}

function normalizeReaderTranscriptVisible(value) {
  return value !== false;
}

function normalizeFixedFrontmatterProperties(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => ({
      key: toString(item?.key).trim(),
      type: normalizeFixedPropertyType(item?.type),
      value: normalizeFixedPropertyValue(item?.type, item?.value)
    }))
    .filter((item) => item.key && !isFixedPropertyRowEffectivelyEmpty(item.type, item.value));
}

function normalizeAiSystemPrompt(value) {
  return toString(value).trim();
}

function normalizeAiPresetPrompts(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => toString(item).trim())
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeFixedPropertyType(value) {
  const type = toString(value).trim().toLowerCase();
  return type === "number" || type === "checkbox" || type === "list" ? type : "text";
}

function normalizeFixedPropertyValue(type, value) {
  const normalizedType = normalizeFixedPropertyType(type);
  if (normalizedType === "checkbox") {
    return toString(value).trim().toLowerCase();
  }
  return toString(value).trim();
}

function isFixedPropertyRowEffectivelyEmpty(type, value) {
  return !toString(value).trim();
}

function formatConnectionError(error) {
  const message = String(error?.message || "").trim();
  if (!message) {
    return "连接失败：未知错误";
  }
  if (message.includes("Failed to fetch")) {
    return "无法连接 Local REST API。请检查地址、HTTP/HTTPS 模式和证书信任。";
  }
  return message;
}

// ===== AI 模型平台存储 =====

const AI_PROVIDER_KEYS_STORAGE = "aiProviderKeys";

function normalizeAiProvider(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  if (!id) return null;
  return {
    id,
    presetId: String(item.presetId || "custom"),
    name: String(item.name || "自定义").trim() || "自定义",
    baseUrl: String(item.baseUrl || "").trim().replace(/\/+$/, ""),
    model: String(item.model || "").trim(),
    temperature: typeof item.temperature === "number" ? item.temperature : 0.7,
    requiresKey: item.requiresKey !== false,
    enabled: item.enabled !== false
  };
}

async function loadAiProviders() {
  const [syncData, keys] = await Promise.all([
    chrome.storage.sync.get(["aiProviders"]),
    loadAiProviderKeys()
  ]);
  const list = Array.isArray(syncData.aiProviders) ? syncData.aiProviders : [];
  return list
    .map(normalizeAiProvider)
    .filter(Boolean)
    .map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
}

async function saveAiProviders(items) {
  const rawList = Array.isArray(items) ? items : [];
  const keys = await loadAiProviderKeys();
  const nextList = [];
  for (const raw of rawList) {
    const normalized = normalizeAiProvider(raw);
    if (!normalized) continue;
    nextList.push(normalized);
    const incomingKey = String(raw?.apiKey || "").trim();
    if (incomingKey) {
      keys[normalized.id] = incomingKey;
    }
  }
  await Promise.all([
    chrome.storage.sync.set({ aiProviders: nextList }),
    chrome.storage.local.set({ [AI_PROVIDER_KEYS_STORAGE]: keys })
  ]);
  // 返回带 hasSavedKey 的列表，方便前端渲染占位
  return nextList.map((p) => ({ ...p, hasSavedKey: Boolean(keys[p.id]) }));
}

async function deleteAiProvider(providerId) {
  const list = await loadAiProviders();
  const next = list.filter((p) => p.id !== providerId);
  await chrome.storage.sync.set({ aiProviders: next });
  const keys = await loadAiProviderKeys();
  if (keys && providerId in keys) {
    delete keys[providerId];
    await chrome.storage.local.set({ [AI_PROVIDER_KEYS_STORAGE]: keys });
  }
  return next;
}

async function loadAiProviderKeys() {
  const localData = await chrome.storage.local.get([AI_PROVIDER_KEYS_STORAGE]);
  const keys = localData?.[AI_PROVIDER_KEYS_STORAGE];
  return keys && typeof keys === "object" ? keys : {};
}

async function saveAiProviderKey(providerId, apiKey) {
  const keys = await loadAiProviderKeys();
  const trimmed = String(apiKey || "").trim();
  if (trimmed) {
    keys[providerId] = trimmed;
  } else {
    delete keys[providerId];
  }
  await chrome.storage.local.set({ [AI_PROVIDER_KEYS_STORAGE]: keys });
  return keys;
}

// ===== AI 调用（内联实现，避免 service worker 跨文件 import） =====

function buildAiMessages({ context, userPrompt, history, systemPrompt }) {
  const ctx = context || {};
  const sections = [
    `你是一个 B 站视频助手。当前用户正在看一个视频，标题：「${ctx.title || "未知"}」`,
    `作者：${ctx.author || "未知"} | 上传日期：${ctx.uploadDate || "未知"}`
  ];
  if (ctx.subtitleMarkdown) {
    sections.push(`以下是视频的字幕全文：\n\n${ctx.subtitleMarkdown}`);
  } else {
    sections.push("（暂无字幕）");
  }
  if (Array.isArray(ctx.hotComments) && ctx.hotComments.length) {
    const block = ctx.hotComments
      .map((c, i) => `${i + 1}. ${c.uname || "匿名"}（赞 ${c.like || 0}）: ${c.message || ""}`)
      .join("\n");
    sections.push(`以下是按热度排序的前 ${ctx.hotComments.length} 条热门评论：\n\n${block}`);
  }
  const customSystemPrompt = normalizeAiSystemPrompt(systemPrompt);
  if (customSystemPrompt) {
    sections.push(`以下是额外系统要求：\n${customSystemPrompt}`);
  }
  return [
    { role: "system", content: sections.join("\n\n") },
    ...(Array.isArray(history) ? history.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") : []),
    { role: "user", content: String(userPrompt || "") }
  ];
}

function clipAiSubtitle(markdown, maxChars = 8000) {
  const text = String(markdown || "");
  if (!text || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n...（字幕过长，已截断）";
}

async function* parseOpenAISSE(response) {
  if (!response || !response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.length ? lines.pop() : "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      if (!data) continue;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content;
        if (delta) yield String(delta);
      } catch {}
    }
  }
}

async function streamChat({ provider, context, userPrompt, history, port }) {
  if (!port) return;
  const baseUrl = String(provider?.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    port.postMessage({ type: "error", error: "baseUrl 未配置" });
    return;
  }
  if (!provider.model) {
    port.postMessage({ type: "error", error: "模型未配置" });
    return;
  }

  const messages = buildAiMessages({
    context: { ...context, subtitleMarkdown: clipAiSubtitle(context?.subtitleMarkdown) },
    userPrompt,
    history,
    systemPrompt: context?.aiSystemPrompt || ""
  });

  const headers = { "Content-Type": "application/json" };
  if (provider.apiKey) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }

  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages,
        stream: true,
        temperature: typeof provider.temperature === "number" ? provider.temperature : 0.7
      })
    });
  } catch (e) {
    port.postMessage({ type: "error", error: `网络错误：${e?.message || e}` });
    return;
  }

  if (!response.ok) {
    let detail = "";
    try { detail = (await response.text()).slice(0, 200); } catch {}
    port.postMessage({ type: "error", error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` });
    return;
  }

  try {
    for await (const token of parseOpenAISSE(response)) {
      port.postMessage({ type: "token", data: token });
    }
    port.postMessage({ type: "done" });
  } catch (e) {
    port.postMessage({ type: "error", error: String(e?.message || e) });
  }
}

async function testAiConnection({ baseUrl, apiKey, model }) {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  const url = `${normalizedBaseUrl}/models`;
  const headers = { Accept: "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  // 401/403 不重试（重试也无意义），其他错误重试一次
  const shouldRetry = (status) => status >= 500 || status === 408 || status === 429;
  const delays = [0, 700];

  let lastError = "";
  for (let i = 0; i < delays.length; i += 1) {
    if (delays[i] > 0) await new Promise((r) => setTimeout(r, delays[i]));
    let response;
    try {
      response = await fetch(url, { method: "GET", headers, cache: "no-store" });
    } catch (e) {
      lastError = `无法连接：${e?.message || e}`;
      continue;
    }
    if (response.ok) {
      let models = [];
      try {
        const data = await response.json();
        if (Array.isArray(data?.data)) models = data.data.map((m) => m?.id).filter(Boolean);
      } catch {}
      return { ok: true, models };
    }
    let detail = "";
    try { detail = (await response.text()).slice(0, 200); } catch {}
    const errText = `HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
    if (!shouldRetry(response.status) || i === delays.length - 1) {
      if (!model) {
        return { ok: false, error: errText };
      }
      const chatProbe = await probeAiChatCompletion({
        baseUrl: normalizedBaseUrl,
        apiKey,
        model,
        headers
      });
      if (chatProbe.ok) {
        return { ok: true, models: [], note: "chat-completions probe" };
      }
      return { ok: false, error: chatProbe.error || errText };
    }
    lastError = errText;
  }
  return { ok: false, error: lastError || "未知错误" };
}

async function probeAiChatCompletion({ baseUrl, apiKey, model, headers }) {
  const requestHeaders = headers || { Accept: "application/json" };
  if (apiKey && !requestHeaders.Authorization) {
    requestHeaders.Authorization = `Bearer ${apiKey}`;
  }
  requestHeaders["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }]
      })
    });
  } catch (error) {
    return { ok: false, error: `无法连接：${error?.message || error}` };
  }

  if (response.ok) {
    return { ok: true };
  }

  let detail = "";
  try {
    detail = (await response.text()).slice(0, 200);
  } catch {}
  return { ok: false, error: `HTTP ${response.status}${detail ? `: ${detail}` : ""}` };
}
