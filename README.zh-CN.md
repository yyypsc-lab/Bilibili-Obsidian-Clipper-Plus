<div align="center">

# Bilibili Obsidian Clipper Plus

B 站字幕抓取与 Obsidian 保存插件，支持无字幕轨视频通过本地 Whisper 生成转写字幕。

中文 | [English](README.md)

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](#安装插件)
[![Obsidian](https://img.shields.io/badge/Obsidian-Local%20REST%20API-7C3AED)](#obsidian-配置)
[![Whisper](https://img.shields.io/badge/Whisper-Local%20ASR-0F766E)](#本地-whisper-转写)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

## 项目简介

`Bilibili Obsidian Clipper Plus` 是基于 [haixiong1997/Bilibili-Obsidian-Clipper](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper) 二次开发的增强版浏览器插件。

原项目可以抓取 B 站播放器已有的字幕轨，并保存到 Obsidian。本增强版在此基础上补充了一个核心能力：当视频没有字幕轨时，可以临时获取音频并调用本地 Whisper 服务生成转写字幕，再继续复制、下载或保存到 Obsidian。

## 功能亮点

- 抓取 B 站原生字幕轨，支持字幕预览、复制、下载。
- 无字幕轨视频可通过本地 Whisper 生成转写字幕。
- 转写后的字幕文本会缓存到 `chrome.storage.local`，下次打开同一视频可直接恢复。
- 默认不保存完整视频画面，也默认不长期保存音频文件。
- 可选保留音频缓存，并在插件中删除对应音频。
- 支持保存到 Obsidian，并在写入后进行读取校验。
- 设置页提供字幕缓存统计和清理入口。
- 保留原有 AI 侧边栏、阅读视图等能力。

## 工作流程

```text
有字幕轨视频
B 站视频页 -> 插件读取字幕轨 -> 预览 / 复制 / 下载 / 保存到 Obsidian

无字幕轨视频
B 站视频页 -> 生成转写字幕 -> 本地 Whisper 服务临时处理音频 -> 返回字幕 -> 缓存字幕文本 -> 预览 / 复制 / 下载 / 保存到 Obsidian
```

默认流程不会保存视频画面：

```text
首次转写 -> 临时获取音频 -> Whisper 转写 -> 字幕文本写入 chrome.storage.local -> 临时音频清理 -> 下次打开直接恢复字幕
```

## 安装插件

1. 下载或克隆本仓库。
2. 打开 Chrome 扩展管理页：

```text
chrome://extensions/
```

3. 开启右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择本仓库中的 `extension` 目录。
6. 如果已安装 Chrome 商店版原插件，建议先禁用，避免两个扩展同时注入页面。

扩展更新后，建议点击扩展卡片上的刷新按钮，并刷新已打开的 B 站视频页。

## Obsidian 配置

本插件通过 Obsidian 的 Local REST API 写入笔记。

1. 在 Obsidian 社区插件市场安装并启用 `Local REST API with MCP`。
2. 在该插件设置中开启 HTTP 服务。
3. 复制 API Key。
4. 打开浏览器扩展的设置页，填写：

```text
Local REST API 地址：http://127.0.0.1:27123
Local REST API Key：从 Obsidian 插件复制
笔记目录：例如 Clippings/Bilibili
```

如果弹窗提示保存成功但 Obsidian 中看不到文件，请先确认插件设置中的笔记目录和你在 Obsidian 侧边栏查看的目录一致。

## 本地 Whisper 转写

无字幕轨视频需要本地 Whisper 服务。已有字幕轨的视频不需要启动该服务。

### 1. 安装依赖

建议使用 Python 3.10 或更新版本。

```powershell
pip install openai-whisper
```

如果需要 GPU 加速，请根据你的 CUDA 环境安装对应版本的 PyTorch。CPU 也可以运行，但长视频会明显更慢。

FFmpeg 是 Whisper 常用依赖，建议安装并确保命令可用：

```powershell
ffmpeg -version
```

### 2. 启动服务

在仓库根目录执行：

```powershell
python scripts\local_whisper_server.py --model tiny --language zh
```

服务默认地址：

```text
http://127.0.0.1:8765/v1
```

检查服务是否可用：

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/health
```

### 3. 模型选择

```powershell
python scripts\local_whisper_server.py --model tiny --language zh
python scripts\local_whisper_server.py --model small --language zh
```

`tiny` 速度快，占用低，准确率一般；`small` 准确率更好，但更慢、占用更高。插件设置里的模型名可以保持 `whisper-1`，实际本地模型由启动服务时的 `--model` 参数决定。

### 4. 停止服务

如果服务运行在当前 PowerShell 窗口，按：

```text
Ctrl + C
```

如果服务在后台运行，可按端口停止：

```powershell
$pid = (Get-NetTCPConnection -LocalPort 8765 -State Listen).OwningProcess
Stop-Process -Id $pid -Force
```

## 插件推荐设置

在扩展设置页中：

```text
启用无字幕轨转写：开启
Whisper-compatible Base URL：http://127.0.0.1:8765/v1
Whisper 模型名：whisper-1
默认语言：zh
最大视频时长：3600
保留转写音频缓存：关闭
FFmpeg 预处理：关闭
```

只有需要调试、复查音频或手动复用音频时，才建议开启“保留转写音频缓存”。该缓存只保存音频流，不保存完整视频画面。

## 缓存说明

| 类型 | 位置 | 默认 | 用途 |
| --- | --- | --- | --- |
| 字幕文本缓存 | `chrome.storage.local` | 开启 | 避免重复转写 |
| 音频缓存 | 用户指定目录 | 关闭 | 调试或复查音频 |
| 完整视频画面 | 不保存 | 不支持 | 本项目不保存视频画面 |

设置页提供“字幕缓存管理”，可以查看缓存数量，并清理转写字幕缓存或全部字幕缓存。清理字幕缓存不会删除 Obsidian 笔记、API Key 或本地音频文件。

## 使用方式

1. 打开 B 站视频页。
2. 点击浏览器工具栏中的插件图标。
3. 如果视频有字幕轨，插件会直接抓取。
4. 如果视频没有字幕轨，点击“生成转写字幕”。
5. 等待本地 Whisper 服务完成转写。
6. 转写完成后可复制、下载、阅读或保存到 Obsidian。
7. 下次打开同一视频时，插件会优先恢复已缓存的转写字幕。

## 常见问题

### Service Worker 显示“无效”是否有影响？

通常没有影响。Chrome Manifest V3 扩展的后台 Service Worker 会在空闲时被浏览器挂起，触发插件操作时会自动唤醒。

### 需要 GitHub 或 OpenAI API Key 吗？

本地 `openai-whisper` 是开源软件，本地运行不需要 OpenAI API Key。只有使用远程 Whisper-compatible 服务时，才可能需要对应服务商的 API Key。

### 插件会下载完整视频吗？

不会。本项目默认只临时处理音频流，转写完成后清理临时文件。可选音频缓存也只保存音频，不保存视频画面。

### 为什么已经转写过的视频下次不需要重新转写？

转写成功后，字幕文本会写入 Chrome 扩展的 `chrome.storage.local`。下次打开同一 `bvid + cid + model + language` 的视频时，插件会优先恢复这份字幕缓存。

## 开发验证

常用检查命令：

```powershell
node --check extension\background.js
node --check extension\content.js
node --check extension\popup.js
node --check extension\options.js
node scripts\tests\transcription_normalize.test.mjs
python -c "import ast, pathlib; ast.parse(pathlib.Path('scripts/local_whisper_server.py').read_text(encoding='utf-8')); print('server ast ok')"
```

## 项目结构

```text
extension/                       Chrome 扩展源码
extension/transcription/          Whisper 结果归一化逻辑
scripts/local_whisper_server.py   本地 Whisper-compatible 服务
scripts/tests/                    轻量测试脚本
docs/                             技术方案和使用文档
```

## 来源说明

本项目基于 [haixiong1997/Bilibili-Obsidian-Clipper](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper) 二次开发，感谢原作者提供的基础能力和开源工作。

本仓库的增强重点是：无字幕轨视频的本地 Whisper 转写、字幕文本缓存、缓存管理、Obsidian 写入校验和本地服务适配。

## 免责声明

本工具仅用于在用户已登录且有权限访问的 B 站页面中辅助整理字幕内容。请遵守 B 站用户协议、内容版权规则以及当地法律法规。

本项目不会提供绕过权限、批量搬运或分发视频内容的能力。使用本工具产生的后果由使用者自行承担。