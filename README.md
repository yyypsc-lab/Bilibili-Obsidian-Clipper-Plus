<div align="center">

# Bilibili Obsidian Clipper Plus

Bilibili subtitle clipper for Obsidian, with local Whisper transcription for Bilibili videos without subtitle tracks.

[中文](README.zh-CN.md) | English

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](#installation)
[![Obsidian](https://img.shields.io/badge/Obsidian-Local%20REST%20API-7C3AED)](#obsidian-setup)
[![Whisper](https://img.shields.io/badge/Whisper-Local%20ASR-0F766E)](#local-whisper-transcription)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

## Overview

`Bilibili Obsidian Clipper Plus` is an enhanced fork of [haixiong1997/Bilibili-Obsidian-Clipper](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper).

The original extension captures existing Bilibili subtitle tracks and saves them to Obsidian. This Plus version adds local Whisper transcription for videos that do not provide subtitle tracks, so you can still generate subtitles, copy them, download them, or save them to Obsidian.

## Features

- Capture native Bilibili subtitle tracks.
- Generate local Whisper transcriptions when subtitle tracks are unavailable.
- Cache generated subtitle text in `chrome.storage.local` to avoid repeated transcription.
- Do not save full video files; temporary audio is cleaned by default.
- Optional audio cache for debugging or manual reuse.
- Save notes to Obsidian through Local REST API, with write-after-read verification.
- Manage subtitle cache from the extension options page.
- Keep the original AI side panel and reading view capabilities.

## Workflow

```text
Video with subtitle track
Bilibili page -> Extension reads subtitle track -> Preview / Copy / Download / Save to Obsidian

Video without subtitle track
Bilibili page -> Generate transcription -> Local Whisper service processes temporary audio -> Return subtitle -> Cache text -> Preview / Copy / Download / Save to Obsidian
```

Default behavior:

```text
First transcription -> temporary audio -> Whisper -> subtitle text cached in chrome.storage.local -> temporary audio removed -> next open restores cached subtitle
```

## Installation

1. Download or clone this repository.
2. Open Chrome extensions page:

```text
chrome://extensions/
```

3. Enable Developer mode.
4. Click `Load unpacked`.
5. Select the `extension` folder in this repository.
6. If the Chrome Web Store version of the original extension is installed, disable it to avoid duplicate content scripts.

After updating the extension, click the reload button on the extension card and refresh opened Bilibili video tabs.

## Obsidian Setup

This extension writes notes through Obsidian Local REST API.

1. Install and enable `Local REST API with MCP` in Obsidian.
2. Enable the HTTP server in that plugin.
3. Copy the API Key.
4. Open this extension's options page and configure:

```text
Local REST API URL: http://127.0.0.1:27123
Local REST API Key: copied from Obsidian
Note folder: for example, Clippings/Bilibili
```

## Local Whisper Transcription

Only videos without subtitle tracks need the local Whisper service. Videos with native subtitle tracks do not need it.

### Install Dependencies

Python 3.10+ is recommended.

```powershell
pip install openai-whisper
```

FFmpeg is also recommended:

```powershell
ffmpeg -version
```

For GPU acceleration, install a PyTorch build that matches your CUDA environment. CPU works too, but long videos will be much slower.

### Start the Service

Run this from the repository root:

```powershell
python scripts\local_whisper_server.py --model tiny --language zh
```

Default service URL:

```text
http://127.0.0.1:8765/v1
```

Health check:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/health
```

### Model Selection

```powershell
python scripts\local_whisper_server.py --model tiny --language zh
python scripts\local_whisper_server.py --model small --language zh
```

`tiny` is faster and lighter. `small` is usually more accurate but slower. In the extension options, the model name can stay as `whisper-1`; the actual local model is controlled by the `--model` argument when starting the service.

### Stop the Service

If it is running in the current PowerShell window, press:

```text
Ctrl + C
```

If it is running in the background:

```powershell
$pid = (Get-NetTCPConnection -LocalPort 8765 -State Listen).OwningProcess
Stop-Process -Id $pid -Force
```

## Recommended Extension Settings

```text
Enable no-subtitle transcription: On
Whisper-compatible Base URL: http://127.0.0.1:8765/v1
Whisper model name: whisper-1
Default language: zh
Max video duration: 3600
Keep transcription audio cache: Off
FFmpeg preprocessing: Off
```

Enable audio cache only when you need to debug or manually reuse the audio. It stores audio only, not full video.

## Cache Model

| Type | Location | Default | Purpose |
| --- | --- | --- | --- |
| Subtitle text cache | `chrome.storage.local` | On | Avoid repeated transcription |
| Audio cache | User-specified directory | Off | Debugging or manual reuse |
| Full video | Not saved | Not supported | This project does not save video frames |

The options page includes subtitle cache statistics and cleanup buttons. Clearing subtitle cache does not delete Obsidian notes, API keys, or local audio files.

## Usage

1. Open a Bilibili video page.
2. Click the extension icon.
3. If the video has subtitle tracks, subtitles are captured directly.
4. If not, click `Generate transcription`.
5. Wait for the local Whisper service to finish.
6. Copy, download, read, or save the result to Obsidian.
7. The next time you open the same video, cached transcription subtitles are restored first.

## FAQ

### Does `Service Worker inactive` matter?

Usually no. Manifest V3 service workers are suspended by Chrome when idle and wake up when extension events happen.

### Do I need an OpenAI API Key?

No for local `openai-whisper`. You only need an API Key if you use a remote Whisper-compatible service.

### Does the extension download full videos?

No. It temporarily processes audio only. Temporary audio is cleaned by default. Optional audio cache stores audio streams only.

### Why does a transcribed video not need transcription again?

The generated subtitle text is saved in `chrome.storage.local` under the current video and transcription settings. The extension restores it before calling Whisper again.

## Development Checks

```powershell
node --check extension\background.js
node --check extension\content.js
node --check extension\popup.js
node --check extension\options.js
node scripts\tests\transcription_normalize.test.mjs
python -c "import ast, pathlib; ast.parse(pathlib.Path('scripts/local_whisper_server.py').read_text(encoding='utf-8')); print('server ast ok')"
```

## Project Structure

```text
extension/                       Chrome extension source
extension/transcription/          Whisper result normalization
scripts/local_whisper_server.py   Local Whisper-compatible service
scripts/tests/                    Lightweight tests
docs/                             Design and usage notes
```

## Credits

This project is based on [haixiong1997/Bilibili-Obsidian-Clipper](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper). Thanks to the original author for the open-source foundation.

The Plus version focuses on local Whisper transcription, subtitle text caching, cache management, Obsidian write verification, and local-service adaptation.

## Disclaimer

This tool is intended for personal subtitle organization on Bilibili pages that the user is authorized to access. Please follow Bilibili's terms, copyright rules, and applicable laws.

This project does not provide features for bypassing access control, bulk redistribution, or video content distribution. Users are responsible for their own usage.