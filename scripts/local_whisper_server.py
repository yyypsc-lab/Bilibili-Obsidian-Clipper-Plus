#!/usr/bin/env python3
"""Local Whisper-compatible transcription server for Bilibili Obsidian Clipper.

It exposes POST /v1/audio/transcriptions and /audio/transcriptions, accepts
multipart/form-data with fields compatible with OpenAI Whisper, runs the local
`whisper` command, and returns verbose_json-like segments.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Tuple

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_MODEL = "base"
MAX_UPLOAD_MB = int(os.environ.get("LOCAL_WHISPER_MAX_MB", "256"))
MAX_REMOTE_AUDIO_MB = int(os.environ.get("LOCAL_WHISPER_MAX_REMOTE_AUDIO_MB", "256"))
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CACHE_HOME = PROJECT_ROOT / ".cache"
DEFAULT_AUDIO_CACHE_DIR = PROJECT_ROOT / ".cache" / "bilibili-audio"
os.environ.setdefault("XDG_CACHE_HOME", str(DEFAULT_CACHE_HOME))


def parse_options() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a local Whisper-compatible HTTP server.")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--model", default=os.environ.get("LOCAL_WHISPER_MODEL", DEFAULT_MODEL))
    parser.add_argument("--language", default=os.environ.get("LOCAL_WHISPER_LANGUAGE", "zh"))
    parser.add_argument("--whisper-cmd", default=os.environ.get("LOCAL_WHISPER_CMD", "whisper"))
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--keep-temp", action="store_true", help="Keep temporary files for debugging.")
    return parser.parse_args()


OPTIONS = parse_options()


class RequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class WhisperHandler(BaseHTTPRequestHandler):
    server_version = "BOCLocalWhisper/1.0"

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") in ("", "/health"):
            self.write_json(200, {"ok": True, "service": "local-whisper", "model": OPTIONS.model})
            return
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            self.write_json(200, {"data": [{"id": OPTIONS.model, "object": "model"}]})
            return
        self.write_json(404, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        route = self.path.rstrip("/")
        try:
            if route in ("/v1/audio/transcriptions", "/audio/transcriptions"):
                fields, file_name, file_bytes = self.read_multipart_request()
                result = transcribe_with_local_whisper(fields, file_name, file_bytes)
                self.write_json(200, result)
                return
            if route in ("/v1/bilibili/transcriptions", "/bilibili/transcriptions"):
                payload = self.read_json_request()
                result = transcribe_bilibili_remote_audio(payload)
                self.write_json(200, result)
                return
            if route in ("/v1/bilibili/audio/delete", "/bilibili/audio/delete"):
                payload = self.read_json_request()
                result = delete_cached_audio(payload)
                self.write_json(200, result)
                return
            self.write_json(404, {"error": "Not found"})
        except RequestError as error:
            self.write_json(error.status, {"error": error.message})
        except Exception as error:  # pragma: no cover - server safety net
            self.write_json(500, {"error": str(error)})

    def read_multipart_request(self) -> Tuple[Dict[str, str], str, bytes]:
        content_type = self.headers.get("Content-Type", "")
        boundary = get_boundary(content_type)
        if not boundary:
            raise RequestError(400, "Content-Type must be multipart/form-data with boundary")
        length = int(self.headers.get("Content-Length", "0") or "0")
        max_bytes = MAX_UPLOAD_MB * 1024 * 1024
        if length <= 0:
            raise RequestError(400, "Empty request body")
        if length > max_bytes:
            raise RequestError(413, f"Upload too large: {length} bytes > {max_bytes} bytes")
        body = self.rfile.read(length)
        fields, files = parse_multipart(body, boundary)
        file_item = files.get("file")
        if not file_item:
            raise RequestError(400, "Missing multipart field: file")
        filename, content = file_item
        if not content:
            raise RequestError(400, "Uploaded audio is empty")
        return fields, filename or "audio.m4a", content

    def read_json_request(self) -> Dict:
        content_type = self.headers.get("Content-Type", "")
        if "application/json" not in content_type.lower():
            raise RequestError(400, "Content-Type must be application/json")
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            raise RequestError(400, "Empty request body")
        if length > 1024 * 1024:
            raise RequestError(413, "JSON request too large")
        body = self.rfile.read(length)
        try:
            payload = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError as error:
            raise RequestError(400, f"Invalid JSON: {error}") from error
        if not isinstance(payload, dict):
            raise RequestError(400, "JSON body must be an object")
        return payload
    def write_json(self, status: int, payload: Dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}", file=sys.stderr)


def get_boundary(content_type: str) -> bytes:
    for part in content_type.split(";"):
        part = part.strip()
        if part.startswith("boundary="):
            value = part.split("=", 1)[1].strip().strip('"')
            return value.encode("utf-8")
    return b""


def parse_multipart(body: bytes, boundary: bytes) -> Tuple[Dict[str, str], Dict[str, Tuple[str, bytes]]]:
    delimiter = b"--" + boundary
    fields: Dict[str, str] = {}
    files: Dict[str, Tuple[str, bytes]] = {}
    for raw_part in body.split(delimiter):
        part = raw_part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        if part.endswith(b"--"):
            part = part[:-2].rstrip(b"\r\n")
        header_blob, sep, content = part.partition(b"\r\n\r\n")
        if not sep:
            continue
        headers = parse_part_headers(header_blob)
        disposition = headers.get("content-disposition", "")
        attrs = parse_disposition_attrs(disposition)
        name = attrs.get("name", "")
        filename = attrs.get("filename")
        if not name:
            continue
        content = content.rstrip(b"\r\n")
        if filename is not None:
            files[name] = (sanitize_filename(filename), content)
        else:
            fields[name] = content.decode("utf-8", "replace").strip()
    return fields, files


def parse_part_headers(header_blob: bytes) -> Dict[str, str]:
    headers: Dict[str, str] = {}
    for line in header_blob.decode("utf-8", "replace").split("\r\n"):
        key, sep, value = line.partition(":")
        if sep:
            headers[key.strip().lower()] = value.strip()
    return headers


def parse_disposition_attrs(value: str) -> Dict[str, str]:
    attrs: Dict[str, str] = {}
    for part in value.split(";"):
        part = part.strip()
        if "=" not in part:
            continue
        key, raw = part.split("=", 1)
        attrs[key.strip().lower()] = raw.strip().strip('"')
    return attrs


def sanitize_filename(value: str) -> str:
    name = Path(value or "audio.m4a").name
    safe = "".join(ch if ch.isalnum() or ch in ".-_" else "_" for ch in name).strip("._")
    return safe or "audio.m4a"


def transcribe_bilibili_remote_audio(payload: Dict) -> Dict:
    fields = {
        "model": str(payload.get("model") or "").strip(),
        "language": str(payload.get("language") or OPTIONS.language or "").strip(),
    }
    bvid = str(payload.get("bvid") or "").strip()
    cid = str(payload.get("cid") or "").strip()
    audio_urls = normalize_audio_url_list(payload.get("audio_urls"))
    if not audio_urls:
        audio_urls = fetch_bilibili_audio_urls(bvid, cid, str(payload.get("aid") or "").strip())
    if not audio_urls:
        raise RequestError(400, "Missing Bilibili audio URLs")
    keep_audio = bool(payload.get("keep_audio"))
    cache_dir = str(payload.get("audio_cache_dir") or "").strip()
    filename, content, audio_path = download_bilibili_audio(audio_urls, bvid, keep_audio, cache_dir)
    result = transcribe_with_local_whisper(fields, filename, content)
    if audio_path:
        result["audio_path"] = audio_path
    return result


def normalize_audio_url_list(value) -> List[str]:
    urls: List[str] = []
    seen = set()
    items = value if isinstance(value, list) else []
    for item in items:
        url = ""
        if isinstance(item, str):
            url = item.strip()
        elif isinstance(item, dict):
            url = str(item.get("url") or "").strip()
        if not url or url in seen:
            continue
        if not is_allowed_bilibili_audio_url(url):
            continue
        seen.add(url)
        urls.append(url)
    return urls


def is_allowed_bilibili_audio_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return False
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and (
        host.endswith(".bilivideo.com") or host.endswith(".hdslb.com")
    )


def fetch_bilibili_audio_urls(bvid: str, cid: str, aid: str = "") -> List[str]:
    if not bvid or not cid:
        return []
    query = urllib.parse.urlencode({
        "bvid": bvid,
        "cid": cid,
        "fnval": "16",
        "fourk": "1",
        **({"avid": aid} if aid else {}),
    })
    request = urllib.request.Request(
        f"https://api.bilibili.com/x/player/playurl?{query}",
        headers=build_bilibili_headers(f"https://www.bilibili.com/video/{bvid}/"),
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8", "replace"))
    if payload.get("code") != 0:
        raise RequestError(502, str(payload.get("message") or "Bilibili playurl failed"))
    urls: List[str] = []
    seen = set()
    audio_items = (((payload.get("data") or {}).get("dash") or {}).get("audio") or [])
    audio_items = sorted(audio_items, key=lambda item: abs(int(item.get("bandwidth") or 0) - 64000))
    for item in audio_items:
        for key in ("baseUrl", "base_url"):
            add_audio_url(urls, seen, item.get(key))
        backups = item.get("backupUrl") or item.get("backup_url") or []
        if isinstance(backups, list):
            for backup in backups:
                add_audio_url(urls, seen, backup)
    return urls


def add_audio_url(urls: List[str], seen: set, value) -> None:
    url = str(value or "").strip()
    if url and url not in seen and is_allowed_bilibili_audio_url(url):
        seen.add(url)
        urls.append(url)


def build_bilibili_headers(referer: str) -> Dict[str, str]:
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Origin": "https://www.bilibili.com",
        "Referer": referer or "https://www.bilibili.com/",
    }


def download_bilibili_audio(audio_urls: List[str], bvid: str, keep_audio: bool = False, cache_dir: str = "") -> Tuple[str, bytes, str]:
    errors: List[str] = []
    max_bytes = MAX_REMOTE_AUDIO_MB * 1024 * 1024
    referer = f"https://www.bilibili.com/video/{bvid}/" if bvid else "https://www.bilibili.com/"
    for url in audio_urls:
        try:
            request = urllib.request.Request(url, headers=build_bilibili_headers(referer))
            with urllib.request.urlopen(request, timeout=120) as response:
                length = int(response.headers.get("Content-Length") or "0")
                if length and length > max_bytes:
                    raise RequestError(413, f"Remote audio too large: {length} bytes > {max_bytes} bytes")
                content = response.read(max_bytes + 1)
                if len(content) > max_bytes:
                    raise RequestError(413, f"Remote audio too large: > {max_bytes} bytes")
                if not content:
                    raise RequestError(502, "Remote audio is empty")
                filename = build_audio_filename(bvid, url)
                audio_path = save_cached_audio(filename, content, cache_dir) if keep_audio else ""
                return filename, content, audio_path
        except urllib.error.HTTPError as error:
            host = urllib.parse.urlparse(url).hostname or "audio"
            errors.append(f"{host}: HTTP {error.code}")
        except Exception as error:
            host = urllib.parse.urlparse(url).hostname or "audio"
            errors.append(f"{host}: {trim_text(str(error), 180)}")
    raise RequestError(502, "Audio download failed: " + "; ".join(errors))


def build_audio_filename(bvid: str, url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    ext = Path(parsed.path).suffix.lower()
    if ext not in (".m4s", ".m4a", ".mp3", ".aac", ".wav", ".webm", ".ogg"):
        ext = ".m4s"
    return sanitize_filename(f"bilibili-{bvid or uuid.uuid4().hex}-{uuid.uuid4().hex[:8]}{ext}")


def resolve_audio_cache_dir(cache_dir: str) -> Path:
    raw = (cache_dir or "").strip()
    target = Path(raw).expanduser() if raw else DEFAULT_AUDIO_CACHE_DIR
    if not target.is_absolute():
        target = PROJECT_ROOT / target
    target.mkdir(parents=True, exist_ok=True)
    return target.resolve()


def save_cached_audio(filename: str, content: bytes, cache_dir: str) -> str:
    target_dir = resolve_audio_cache_dir(cache_dir)
    target_path = (target_dir / sanitize_filename(filename)).resolve()
    target_path.write_bytes(content)
    return str(target_path)


def delete_cached_audio(payload: Dict) -> Dict:
    raw_path = str(payload.get("audio_path") or "").strip()
    if not raw_path:
        raise RequestError(400, "Missing audio_path")
    path = Path(raw_path).expanduser().resolve()
    if not path.exists():
        return {"ok": True, "deleted": False, "path": str(path)}
    if not path.is_file():
        raise RequestError(400, "audio_path is not a file")
    if path.suffix.lower() not in (".m4s", ".m4a", ".mp3", ".aac", ".wav", ".webm", ".ogg"):
        raise RequestError(400, "Refusing to delete non-audio file")
    path.unlink()
    return {"ok": True, "deleted": True, "path": str(path)}

def transcribe_with_local_whisper(fields: Dict[str, str], filename: str, file_bytes: bytes) -> Dict:
    requested_model = (fields.get("model") or "").strip()
    model = requested_model if requested_model and requested_model != "whisper-1" else OPTIONS.model
    language = (fields.get("language") or OPTIONS.language or "").strip()
    temp_root = tempfile.mkdtemp(prefix="boc-whisper-")
    try:
        temp_dir = Path(temp_root)
        input_path = temp_dir / sanitize_filename(filename)
        input_path.write_bytes(file_bytes)
        cmd = build_whisper_command(input_path, temp_dir, model, language)
        completed = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if completed.returncode != 0:
            raise RequestError(500, trim_text(completed.stderr or completed.stdout or "Whisper command failed"))
        output_path = input_path.with_suffix(".json")
        if not output_path.exists():
            candidates = list(temp_dir.glob("*.json"))
            if candidates:
                output_path = candidates[0]
        if not output_path.exists():
            raise RequestError(500, "Whisper finished but did not produce JSON output")
        raw = json.loads(output_path.read_text(encoding="utf-8"))
        return normalize_whisper_json(raw, language)
    finally:
        if OPTIONS.keep_temp:
            print(f"Kept temp files: {temp_root}", file=sys.stderr)
        else:
            shutil.rmtree(temp_root, ignore_errors=True)


def build_whisper_command(input_path: Path, output_dir: Path, model: str, language: str) -> list[str]:
    cmd = [
        OPTIONS.whisper_cmd,
        str(input_path),
        "--model", model,
        "--output_format", "json",
        "--output_dir", str(output_dir),
        "--task", "transcribe",
        "--fp16", "False",
    ]
    if language:
        cmd.extend(["--language", language])
    if shutil.which(OPTIONS.whisper_cmd):
        return cmd
    return [OPTIONS.python, "-m", "whisper", *cmd[1:]]


def normalize_whisper_json(raw: Dict, fallback_language: str) -> Dict:
    segments = []
    for segment in raw.get("segments") or []:
        text = str(segment.get("text") or "").strip()
        if not text:
            continue
        segments.append({
            "start": float(segment.get("start") or 0),
            "end": float(segment.get("end") or 0),
            "text": text,
        })
    return {
        "text": str(raw.get("text") or "").strip(),
        "language": str(raw.get("language") or fallback_language or "").strip(),
        "segments": segments,
    }


def trim_text(value: str, limit: int = 2000) -> str:
    text = str(value or "").strip()
    return text if len(text) <= limit else text[:limit] + "..."


def main() -> None:
    server = ThreadingHTTPServer((OPTIONS.host, OPTIONS.port), WhisperHandler)
    print(f"Local Whisper server listening on http://{OPTIONS.host}:{OPTIONS.port}")
    print(f"Endpoint: http://{OPTIONS.host}:{OPTIONS.port}/v1/audio/transcriptions")
    print(f"Default model: {OPTIONS.model}; language: {OPTIONS.language or 'auto'}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping local Whisper server")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()