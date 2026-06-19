// OpenAI 兼容协议常量与平台预设。
// 覆盖 OpenAI / DeepSeek / 智谱 / Moonshot / OpenRouter / Ollama（OpenAI 兼容模式）等。

export const OPENAI_COMPAT = {
  listModels: "/models",
  chatPath: "/chat/completions"
};

export const PRESETS = [
  { id: "openai_compat", name: "OpenAI 兼容", baseUrl: "https://api.openai.com/v1" },
  { id: "deepseek",      name: "DeepSeek",    baseUrl: "https://api.deepseek.com/v1" },
  { id: "zhipu",         name: "智谱 GLM",    baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "moonshot",      name: "Moonshot",    baseUrl: "https://api.moonshot.cn/v1" },
  { id: "openrouter",    name: "OpenRouter",  baseUrl: "https://openrouter.ai/api/v1" },
  { id: "ollama",        name: "Ollama (本地)", baseUrl: "http://localhost:11434/v1" },
  { id: "custom",        name: "自定义",      baseUrl: "" }
];

export function getPresetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

export function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}