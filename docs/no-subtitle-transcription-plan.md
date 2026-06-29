# 无字幕轨视频转写字幕技术方案

> 审查状态：待确认。本文只描述方案，不包含代码实现。

## 结论

在现有开源代码基础上补充“无字幕轨视频获取字幕”功能是可行的，但技术本质不是继续调用 B 站字幕接口，而是在字幕轨为空时走“视频音频提取 + 语音识别转写 + 转成现有字幕 body”的备用链路。

推荐实现方式：优先保留当前“官方字幕轨”流程；当 `x/player/wbi/v2` 或 `x/player/v2` 返回 `subtitle.subtitles = []` 时，提供一个明确的“生成转写字幕”入口。插件不要求用户手动下载视频文件，而是在扩展后台临时获取音频 Blob，直接提交给 Whisper-compatible ASR；FFmpeg 仅作为可选预处理能力，用于转码、压缩或长视频切片。转写结果统一转换为现有的字幕数组格式：

```js
[
  { from: 0.0, to: 3.2, content: "字幕文本" }
]
```

这样可以复用现有 Markdown、SRT、TXT、阅读视图、Obsidian 写入、AI 侧边栏上下文和缓存逻辑。

## 当前代码现状

项目是原生浏览器扩展，核心逻辑集中在 `extension/content.js` 和 `extension/background.js`。

当前字幕链路：

1. `extension/content.js` 中 `refreshClip()` 获取 `bvid/aid/cid/pageIndex/videoDuration`。
2. `fetchSubtitleBundle()` 调用 `https://api.bilibili.com/x/player/wbi/v2`，失败时回退 `https://api.bilibili.com/x/player/v2`。
3. `mapSubtitleTracks()` 从 `payload.data.subtitle.subtitles` 提取 `subtitle_url`。
4. 如果字幕轨为空，当前直接 `applyNoSubtitleState()` 并展示“当前视频无字幕”。
5. 有字幕轨时，`loadSubtitle()` 下载字幕 JSON，校验时长后写入 `state.subtitleBody`。
6. `buildMarkdown()`、`buildSrt()`、`buildTxt()`、阅读视图和 popup 都依赖 `state.subtitleBody`。

后台能力：

1. `extension/background.js` 已有 `fetch-json` 消息，用于绕过内容脚本跨域限制获取 JSON。
2. `extension/manifest.json` 已有较宽的 `host_permissions`，包括 `https://api.bilibili.com/*`、`https://*.hdslb.com/*` 和通用 HTTP/HTTPS。
3. 目前没有 npm 构建链路，也没有大型依赖管理。新增方案应尽量保持纯扩展实现，或者只引入可审计的独立 worker/wasm 资源。

## 可行路线比较

### 路线 A：本地浏览器内转写

使用扩展内置 Web Worker + WASM/模型文件，在用户浏览器本地完成 ASR。

优点：

- 不上传音频，隐私最好。
- 不依赖第三方 API Key。
- 适合开源扩展的长期独立运行。

缺点：

- 模型体积大，可能不适合直接打进浏览器商店包。
- 首次加载慢，低配机器转写慢。
- Chrome/Firefox 扩展对 WASM、worker、模型资源打包和 CSP 有兼容成本。

结论：可作为高级模式或后续增强，不建议作为第一阶段默认方案。

### 路线 B：用户自配置 Whisper-compatible ASR API

复用项目已有 AI 平台配置思路，新增“转写服务”配置。插件负责在后台获取音频 Blob，并上传给用户配置的 Whisper 或 Whisper-compatible 语音识别接口，拿到分段文本后转为字幕 body。

优点：

- 开发量和包体最可控。
- 识别质量、速度由用户选择的服务决定。
- 与项目已有 AI provider 设置风格一致。

缺点：

- 需要 API Key 或本地服务。
- 音频可能上传到第三方，必须在 UI 中明确提示。
- 不同 ASR 服务返回格式不同，需要做适配层。

结论：推荐作为第一阶段落地方案。

### 路线 C：调用 B 站内部 AI 字幕生成能力

尝试寻找或调用 B 站未公开的自动字幕生成接口。

优点：

- 如果存在且可用，体验接近官方字幕。

缺点：

- 稳定性、权限、风控和合规风险都高。
- 很可能依赖登录态、创作者权限或内部接口签名。
- 开源项目长期维护成本不可控。

结论：不推荐。

## 推荐总体架构

新增一个“字幕来源”抽象，而不是把转写逻辑塞进现有字幕轨逻辑。

```text
refreshClip()
  -> 获取视频元信息
  -> fetchSubtitleBundle()
       -> 有官方字幕轨：保持现有流程
       -> 无官方字幕轨：进入 no-subtitle 状态，显示“生成转写字幕”
  -> 用户点击生成
       -> resolveAudioSource()
       -> transcribeAudio()
       -> normalizeTranscriptionSegments()
       -> applyGeneratedSubtitle()
       -> 复用现有导出、阅读、Obsidian、AI 上下文
```

核心原则：

- 官方字幕轨优先，转写只作为 fallback。
- 转写必须由用户显式触发，避免自动下载/上传大音频。
- 转写结果必须标记来源，例如 `generated-asr`。
- `subtitle_lang` 不再只表示 B 站轨道语言，生成字幕建议写成 `zh-CN (转写生成)` 或 `asr:zh-CN`。
- 缓存 key 必须与官方字幕轨分离，避免污染原字幕缓存。

## 关键实现点

### 1. 状态模型扩展

建议在 `extension/content.js` 的 `state` 中新增：

```js
subtitleSource: "official", // official | generated-asr | none
generatedSubtitleStatus: "idle", // idle | resolving-audio | transcribing | ready | error
generatedSubtitleError: "",
generatedSubtitleProvider: ""
```

官方字幕流程成功时设置 `subtitleSource = "official"`。

字幕轨为空时设置：

```js
subtitleSource = "none";
generatedSubtitleStatus = "idle";
```

转写成功后设置：

```js
subtitleSource = "generated-asr";
selectedSubtitleId = "generated-asr";
selectedSubtitleUrl = "";
selectedSubtitleLang = "zh-CN (转写生成)";
subtitleBody = normalizedSegments;
```

### 2. 音频来源解析

优先使用 B 站公开播放信息接口解析音频流地址，而不是录制页面播放器。

建议新增函数：

```js
async function fetchPlayUrlAudioCandidates({ bvid, cid }) {}
function pickAudioCandidate(playUrlPayload) {}
```

候选接口：

```text
https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&fnval=16&fourk=1
```

需要兼容 DASH：

```js
payload.data.dash.audio[]
```

选择策略：

1. 优先选择体积/码率适中的音频流，避免默认最高码率导致上传过大。
2. 记录 `baseUrl` 和 `backupUrl`。
3. 使用后台脚本 fetch 音频 blob，带 `Referer: https://www.bilibili.com/`。

风险：

- 部分视频音频 URL 有防盗链、登录态、有效期限制。
- MV3 service worker 对大文件 fetch 和内存有压力。
- 长视频需要限制时长或分片处理。

第一阶段建议加限制：

- 默认只支持 60 分钟内视频。
- 单次音频下载超过 100MB 时提示用户使用本地 ASR 服务或降低模式。
- 下载失败时给出可读错误，不回退到不稳定内部接口。

### 3. 转写 Provider 抽象

新增模块建议：

```text
extension/transcription/providers.js
extension/transcription/client.js
extension/transcription/normalize.js
```

第一阶段支持两类 provider：

1. Whisper-compatible audio transcription：用户配置 `baseUrl`、`apiKey`、`model`，默认调用 `/audio/transcriptions`。
2. Local ASR HTTP service：用户本机服务，例如 `http://127.0.0.1:9000/transcribe`。

FFmpeg 不作为必需依赖，而作为可选预处理 provider：

```js
{
  enabled: false,
  endpoint: "http://127.0.0.1:9000/ffmpeg/convert",
  outputFormat: "mp3",
  maxDurationSeconds: 3600
}
```

当 ASR 服务能直接接收 B 站音频 Blob 时跳过 FFmpeg；只有格式不兼容、音频过大或需要切片时才启用 FFmpeg。

统一输入：

```js
{
  audioBlob,
  filename,
  language,
  videoDuration,
  provider
}
```

统一输出：

```js
{
  language: "zh-CN",
  segments: [
    { from: 0, to: 2.4, content: "..." }
  ],
  provider: "openai-compatible"
}
```

### 4. 分段归一化

新增 `normalizeTranscriptionSegments(raw, videoDuration)`：

规则：

- `from/to` 转为秒。
- 缺少 `to` 时用下一段 `from` 或 `from + 3` 补齐。
- 丢弃空文本。
- 合并过短空白段。
- 调用现有 `validateSubtitleByDuration()`，避免明显错位。

输出格式必须与 B 站字幕 body 一致，这样 `buildMarkdown()`、`buildSrt()`、`buildTxt()` 不需要大改。

### 5. UI 交互

Popup 和阅读视图在无字幕轨时不能只显示“暂无字幕”，需要展示一个操作入口：

```text
暂无字幕轨
[生成转写字幕]
```

生成过程中展示：

```text
正在解析音频...
正在转写，可能需要几分钟...
```

转写完成后，字幕选择框增加虚拟选项：

```text
转写生成 [ASR]
```

注意：不要把它渲染成 B 站官方 AI 字幕，避免误导。

### 6. 设置页

在 `extension/options.html/js/css` 增加“转写字幕”设置区：

- 是否启用无字幕轨转写功能。
- Provider 类型：Whisper-compatible / Local ASR。
- Base URL。
- Model。
- API Key。
- 默认语言。
- 最大视频时长。
- 可选 FFmpeg 预处理服务地址。
- FFmpeg 输出格式，例如 `mp3`、`wav` 或 `m4a`。
- 隐私提示：启用远程 provider 会上传音频。

API Key 继续使用 `chrome.storage.local`，不要进入 `sync`。

### 7. 缓存策略

生成字幕缓存 key 与官方字幕分开：

```js
boc_generated_subtitle_cache_{bvid}_{cid}_{providerId}_{model}_{language}
```

缓存内容：

```js
{
  body,
  provider,
  model,
  language,
  createdAt,
  videoDuration
}
```

缓存命中后仍走 `validateSubtitleByDuration()`。

建议提供“重新生成”按钮，绕过缓存。

## 建议改动文件

第一阶段建议修改：

- `extension/content.js`：接入无字幕轨状态、生成入口、转写结果应用、缓存、阅读视图同步。
- `extension/background.js`：新增音频 fetch、ASR provider 调用、设置存取。
- `extension/options.html`：新增转写设置区。
- `extension/options.js`：保存和校验转写设置。
- `extension/options.css`：设置区样式。
- `extension/popup.html`：无字幕轨时显示生成按钮。
- `extension/popup.js`：触发生成、展示状态、重新生成。
- `extension/popup.css`：按钮和状态样式。
- `extension/manifest.json`：如需 worker/wasm 或额外资源，再补 `web_accessible_resources`。

建议新增：

- `extension/transcription/client.js`
- `extension/transcription/providers.js`
- `extension/transcription/normalize.js`
- `extension/transcription/audio.js`

## 分阶段实施计划

### 阶段 1：Whisper-compatible ASR Provider 版本

目标：最小可用闭环。

任务：

1. 增加转写设置模型和设置页。
2. 增加音频 URL 解析与后台下载。
3. 增加 ASR provider 抽象和一个 Whisper-compatible 适配器。
4. 增加无字幕轨 UI 入口。
5. 把 ASR segments 转为现有 subtitle body。
6. 复用 Markdown/SRT/TXT/Obsidian/阅读视图。
7. 增加缓存和重新生成。
8. 增加可选 FFmpeg 预处理配置，默认关闭。

验收：

- 有官方字幕轨的视频仍默认抓官方字幕。
- 无字幕轨视频显示“生成转写字幕”。
- 转写成功后可预览、复制 Markdown、下载 SRT/TXT、写入 Obsidian。
- AI 侧边栏能使用生成字幕作为上下文。
- 刷新页面后可从缓存恢复生成字幕。

### 阶段 2：更好的长视频处理

目标：降低长视频失败率。

任务：

1. 增加视频时长和音频大小限制提示。
2. 支持按时间或字节分片上传。
3. 合并多个分片的 segments。
4. 增加失败续跑或重试。

### 阶段 3：可选本地 WASM 转写

目标：增强隐私和离线能力。

任务：

1. 引入 worker-based 本地 ASR。
2. 模型文件外置或按需下载。
3. 增加模型管理和进度提示。
4. 评估 Chrome/Firefox 包体和商店审核影响。

## 主要风险

1. B 站音频流下载可能受登录态、防盗链、URL 过期影响。
2. 长视频转写耗时长，MV3 service worker 可能中途休眠。
3. 远程 ASR 有隐私风险，必须显式提示用户。
4. Whisper-compatible 接口对分段时间戳返回格式并不完全统一，适配层要允许不同响应格式。
5. 当前源码中中文在 PowerShell 默认读取时出现乱码，实际编辑时要保持 UTF-8，避免 manifest/options 文案编码漂移。

## 推荐决策

建议批准阶段 1，不建议一开始做本地 WASM。FFmpeg 能力可以在阶段 1 作为“可选外部预处理服务”加入，但不作为默认必需链路。

阶段 1 的核心价值是快速验证：

- 能否稳定拿到 B 站音频。
- 用户是否接受“配置自己的转写服务/API Key”。
- 现有导出和阅读体验是否能自然复用生成字幕。

如果阶段 1 验证通过，再做阶段 2 的长视频和阶段 3 的本地转写。
