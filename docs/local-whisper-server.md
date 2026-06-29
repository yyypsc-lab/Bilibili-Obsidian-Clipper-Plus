# 本地 Whisper 转写服务使用说明

这个项目的无字幕轨转写功能可以使用本地 Whisper，不需要 OpenAI API Key。

## 免费与付费的区别

- `openai-whisper` 开源模型和命令行工具本身是免费的，可以在本机运行。
- OpenAI 托管的 Whisper API 是云服务，通常需要 API Key，并按服务规则计费。
- 本项目默认支持两种方式：本地 HTTP 服务，或云端 Whisper-compatible API。

## 是否会下载视频

插件不会要求用户手动下载视频文件。

实际流程是：

```text
B 站视频页
  -> 插件读取 bvid/cid
  -> 插件后台获取 B 站音频 Blob
  -> 通过 HTTP POST 发送到 http://127.0.0.1:8765/v1/audio/transcriptions
  -> 本地服务写入临时目录并调用本机 Whisper
  -> Whisper 生成 JSON 分段
  -> 本地服务删除临时音频和 JSON
  -> 插件拿到字幕分段并复用现有导出/Obsidian/阅读视图
```

也就是说，不会保存到你的下载目录；服务端只会使用系统临时目录。除非你启动服务时加 `--keep-temp`，否则转写完成会自动清理。

## 启动本地服务

在仓库根目录运行：

```powershell
python scripts\local_whisper_server.py --model base --language zh
```

启动成功后会看到：

```text
Local Whisper server listening on http://127.0.0.1:8765
Endpoint: http://127.0.0.1:8765/v1/audio/transcriptions
```

插件设置中填写：

```text
Whisper-compatible Base URL: http://127.0.0.1:8765/v1
Whisper 模型名: base
Whisper API Key: 留空
默认语言: zh
FFmpeg 预处理: 默认关闭
```

## 如果 Whisper 不在当前 Python 环境

当前系统的默认 `python` 可能没有安装 Whisper。可以用下面命令检查：

```powershell
python -c "import importlib.util; print(importlib.util.find_spec('whisper'))"
where whisper
```

如果 Whisper 装在另一个 Python 环境里，使用那个 Python 启动服务：

```powershell
C:\path\to\python.exe scripts\local_whisper_server.py --model base --language zh
```

如果你有可执行的 whisper 命令，但不在 PATH，可以指定命令路径：

```powershell
python scripts\local_whisper_server.py --whisper-cmd C:\path\to\whisper.exe --model base --language zh
```

## 模型选择

常用模型从小到大：

```text
tiny, base, small, medium, large
```

模型越大，准确率通常越高，但速度更慢，占用也更高。建议先用 `base` 或 `small` 测试流程。

## FFmpeg

本地 Whisper 通常会依赖 FFmpeg 来读取音频格式。这里的 FFmpeg 是 Whisper 命令行内部使用的，不需要在插件里开启“FFmpeg 预处理”。

插件里的 FFmpeg 预处理只适合这些情况：

- 你的 ASR 服务不接受 B 站原始音频格式。
- 需要先压缩、转码或切片。
- 你另有一个专门的 FFmpeg HTTP 服务。

本地 Whisper 服务优先建议保持插件的 FFmpeg 预处理关闭。