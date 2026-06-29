# 本地 Whisper 服务使用说明

本项目的“无字幕轨视频转写字幕”功能依赖本地 Whisper 服务。只有当 B 站视频没有字幕轨、需要插件自动转写音频时，才需要启动该服务。

如果视频本身已经有 B 站字幕轨，插件可以直接抓取字幕，不需要启动 Whisper 服务。

## 1. 启动服务

在 PowerShell 中执行：

```powershell
cd E:\project\Obsidian-Clipper-Greater\Bilibili-Obsidian-Clipper
python scripts\local_whisper_server.py --model tiny --language zh
```

启动后保持这个 PowerShell 窗口不要关闭。插件会调用：

```text
http://127.0.0.1:8765/v1/audio/transcriptions
```

## 2. 检查服务是否正常

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/health
```

如果返回类似下面内容，说明服务可用：

```json
{"ok": true, "service": "local-whisper", "model": "tiny"}
```

## 3. 停止服务

如果服务运行在当前 PowerShell 窗口中，按：

```text
Ctrl + C
```

如果服务在后台运行，可以用端口查找并停止：

```powershell
$pid = (Get-NetTCPConnection -LocalPort 8765 -State Listen).OwningProcess
Stop-Process -Id $pid -Force
```

## 4. 模型选择

默认建议先用 `tiny`：

```powershell
python scripts\local_whisper_server.py --model tiny --language zh
```

特点：速度快，显存占用低，但专业词汇准确率一般。

如果想提高准确率，可以改用 `small`：

```powershell
python scripts\local_whisper_server.py --model small --language zh
```

特点：准确率更好，速度更慢，占用更多 GPU 显存。

你的 RTX 4060 Laptop GPU 可以优先尝试 `small`。如果显存或速度不理想，再切回 `tiny`。

## 5. 插件使用流程

1. 启动本地 Whisper 服务。
2. 打开 B 站视频页。
3. 如果视频没有字幕轨，打开插件面板。
4. 点击“生成转写字幕”。
5. 等待转写完成后，可以复制、下载或保存到 Obsidian。
6. 不再需要转写时，停止本地 Whisper 服务。

## 6. 常见问题

### 是否每次都要启动 Whisper 服务？

只有需要“无字幕轨视频转写”时才需要。普通字幕抓取不需要。

### Whisper 是免费的吗？

本地 `openai-whisper` 是开源软件，本身免费。你本地运行时主要消耗的是自己的 CPU/GPU、电量和时间。

如果使用 OpenAI 或其他云端 Whisper API，则通常需要 API Key，并按服务商规则计费。

### 插件会永久下载视频吗？

不会。插件会临时获取 B 站音频流并提交给本地 Whisper 服务处理。服务端脚本会使用临时文件完成转写，默认处理后清理临时文件。
## 7. 当前插件的音频下载方式

新版插件在使用本地 Whisper 地址时，会优先调用本地服务的 B 站专用接口：

```text
http://127.0.0.1:8765/v1/bilibili/transcriptions
```

这样做是因为 Chrome 扩展后台直接请求 `*.bilivideo.com` 音频流时，可能被 B 站防盗链策略返回 `HTTP 403`。本地 Python 服务会使用正常的浏览器 `User-Agent` 和 `Referer` 临时下载音频，转写完成后清理临时文件。

如果修改了 `scripts/local_whisper_server.py`，需要先停止旧服务，再重新启动，否则 Chrome 仍会调用旧接口。
## 8. 保留音频缓存和删除音频

默认情况下，本地 Whisper 服务只会临时下载 B 站音频流，转写结束后删除临时文件。

如果希望保留音频，可以在扩展设置页开启：

```text
保留转写音频缓存
```

并填写音频缓存目录，例如：

```text
E:\BilibiliAudioCache
```

开启后，插件会把该设置传给本地 Whisper 服务。服务会把本次转写使用的音频文件保存到指定目录，并把路径返回给插件。弹窗中会显示“删除本地音频”按钮，用于删除当前转写结果对应的音频文件。

注意：这里保留的是音频缓存，不是完整视频文件。

## 9. Obsidian 保存校验

新版保存逻辑会先通过 Local REST API 写入笔记，然后再次读取同一路径进行校验。只有读取到的内容与待保存内容一致时，才会提示保存成功。这样可以避免“接口返回成功但 Obsidian 实际没有写入”的误判。