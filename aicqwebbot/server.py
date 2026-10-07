# ═══════════════ aicqwebbot/server.py ═══════════════
# Thin local relay for the browser agent.
#
# The agent brain runs entirely in the browser (agent-engine.js + WASM
# sandbox + IndexedDB). This server only does what a browser page cannot:
#   1. /api/v1/agent/llm-proxy    relay to any OpenAI-compatible LLM API
#                                 (bypasses browser CORS, keeps request
#                                  semantics identical to aicq.me)
#   2. /api/v1/agent/search-proxy web search -> structured results
#   3. /api/v1/agent/web-proxy    fetch any web page / raw HTTP API
#   4. /static/agent/*            the web agent bundle (zero-modification
#                                 copy of aicq.me's agent runtime)
#   5. /                          config page + chat page
#
# Stateless by design: no database, no auth, no sessions on this side.
# All agent state lives in the browser (IndexedDB). Restart safe.

import json
import os
import re
import time
import io as _io
import tarfile
import base64 as _b64
from pathlib import Path
from urllib.parse import quote as _urlquote

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles

try:                                   # source tree → __version__; PyPI wheel → metadata
    from . import __version__ as PKG_VERSION
except Exception:                      # pragma: no cover — flat import fallback
    try:
        from importlib.metadata import version as _pkg_version
        PKG_VERSION = _pkg_version("aicqwebbot")
    except Exception:
        PKG_VERSION = "dev"

app = FastAPI(title="AicqWebBot", docs_url=None, redoc_url=None)

WEB_DIR = Path(__file__).parent / "web"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# ═══════════════ 1. LLM proxy (mirror of aicq.me's /api/v1/agent/llm-proxy) ═══════════════

# ── [2026-09-29] OpenCode Zen 免费档客户端指纹保障（0.4.10 恢复）─────────────
# 上游 2026-09 起对免费档加客户端指纹闸门（"free tier can only be used from
# within OpenCode" → FreeTierError）。口径与 samaidev/teambot
# core/free_model_hub.py (v1.56.45) 实测一致：
#   ① User-Agent 必须形如 opencode 客户端（浏览器 fetch 的 UA 不可靠 → 服务端强制）；
#   ② x-opencode-session = "ses_"+26位、x-opencode-request = "msg_"+26位；
#     26位 = 12位小写hex（毫秒<<12 截断 48bit）+ 14位 base62（13位 hex 会被拒）；
#   ③ 请求体恒 stream:true（非流式一律 FreeTierError）；
#   ④ body.tools 必须含 11 个 opencode 工具名（只看名字，描述/参数任意）。
# 仅对 target 为 opencode.ai（含子域名）的请求生效，其他供应商零影响。
# ⚠ 范围：本中继跑在【用户自己电脑】上 → opencode.ai 看到的是客户端 IP；
#   服务器侧（aicq.me）不得接入本逻辑。
_OC_HOST_SUFFIX = "opencode.ai"
_OC_CLIENT_UA = "opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14"
_OC_TOOL_NAMES = ("bash", "edit", "glob", "grep", "read", "skill", "task",
                  "todowrite", "webfetch", "websearch", "write")
_OC_A62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_oc_last_ms = 0
_oc_counter = 0


def _is_opencode_target(url: str) -> bool:
    try:
        from urllib.parse import urlparse
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    return host == _OC_HOST_SUFFIX or host.endswith("." + _OC_HOST_SUFFIX)


def _oc_make_id(prefix: str) -> str:
    """opencode 兼容 ID：prefix_ + 12位hex(48bit) + 14位base62。
    对齐 packages/opencode/src/id/id.ts：48bit 截断是必要的（13位hex被拒）。"""
    global _oc_last_ms, _oc_counter
    import time as _time
    ms = int(_time.time() * 1000)
    if ms != _oc_last_ms:
        _oc_last_ms = ms
        _oc_counter = 0
    _oc_counter += 1
    now = (ms << 12) & ((1 << 48) - 1)
    rand = "".join(_OC_A62[b % 62] for b in os.urandom(14))
    return f"{prefix}_{now:012x}{rand}"


def _oc_decoy_tool(name: str, responses_format: bool) -> dict:
    fn = {"name": name, "description": "x", "parameters": {"type": "object", "properties": {}}}
    return {"type": "function", **fn} if responses_format else {"type": "function", "function": fn}


def _oc_enforce_headers_and_body(target_url: str, headers: dict, body) -> tuple:
    """opencode.ai 定向：强制 UA/身份头 + body 恒流式 + 指纹工具名补齐。
    返回 (headers, body_bytes)。非 JSON body / 解析失败时原样透传。"""
    headers = dict(headers or {})
    headers["User-Agent"] = _OC_CLIENT_UA                      # 指纹①：客户端 UA（强制覆盖）
    headers.setdefault("x-opencode-client", "cli")
    headers.setdefault("x-opencode-project", "global")
    sess = str(headers.get("x-opencode-session") or "")
    # 指纹②：ses_ + 26 位格式校验，不合法就地重生成（会话粘性尽力保留）
    if not (sess.startswith("ses_") and len(sess) == 30):
        sess = _oc_make_id("ses")
        headers["x-opencode-session"] = sess
    headers["x-opencode-request"] = _oc_make_id("msg")          # msg_ 每请求刷新
    if not str(headers.get("Authorization") or "").strip():
        headers["Authorization"] = "Bearer public"              # 镜像真客户端（匿名免费）
    # 指纹③④：body 恒流式 + 工具名补齐（/responses 用 responses 格式，其余按 chat）
    if body:
        try:
            obj = json.loads(body) if isinstance(body, (str, bytes)) else None
        except Exception:
            obj = None
        if isinstance(obj, dict):
            obj["stream"] = True
            is_responses = target_url.rstrip("/").endswith("/responses")
            tools = obj.get("tools")
            names = set()
            if isinstance(tools, list):
                for t in tools:
                    if isinstance(t, dict):
                        fn = t.get("function") if isinstance(t.get("function"), dict) else t
                        if isinstance(fn, dict) and fn.get("name"):
                            names.add(fn["name"])
                missing = [n for n in _OC_TOOL_NAMES if n not in names]
                obj["tools"] = tools + [_oc_decoy_tool(n, is_responses) for n in missing]
            else:
                obj["tools"] = [_oc_decoy_tool(n, is_responses) for n in _OC_TOOL_NAMES]
                obj.setdefault("tool_choice", "auto")
            if not is_responses:
                obj.setdefault("stream_options", {"include_usage": True})
            body = json.dumps(obj)
    return headers, body


@app.post("/api/v1/agent/llm-proxy")
async def llm_proxy(request: Request):
    """Generic relay: {target_url, method, headers, body, stream} -> upstream.

    The browser agent builds a full OpenAI-compatible request (including the
    user's API key in headers) and posts it here. We forward verbatim and
    stream the response back when asked. The key transits this process in
    memory only — nothing is stored, logged, or sent anywhere else.
    [2026-09-29] opencode.ai targets get the free-tier client-fingerprint
    enforcement (UA + ses_/msg_ identity headers + forced stream + tool-name
    set) — see _oc_enforce_headers_and_body above. All egress happens from
    the USER'S machine (this relay), never from any server.
    """
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)

    target_url = payload.get("target_url") or ""
    if not re.match(r"^https?://", target_url):
        return JSONResponse({"error": "target_url must be http(s)"}, status_code=400)

    method = (payload.get("method") or "POST").upper()
    headers = payload.get("headers") or {}
    body = payload.get("body")
    want_stream = bool(payload.get("stream"))
    if isinstance(body, (dict, list)):
        body = json.dumps(body)

    # [2026-09-29] opencode.ai 免费档指纹保障（仅此 host；浏览器侧已带身份头，
    # 此处统一兜底强制 —— UA 等头浏览器端不可靠，出口以本地中继为准）
    if _is_opencode_target(target_url):
        headers, body = _oc_enforce_headers_and_body(target_url, headers, body)

    timeout = httpx.Timeout(300.0, connect=20.0)
    try:
        if want_stream:
            upstream = httpx.AsyncClient(timeout=timeout)
            try:
                req = upstream.build_request(method, target_url, headers=headers, content=body or None)
                resp = await upstream.send(req, stream=True)
            except Exception:
                await upstream.aclose()
                raise
            media = resp.headers.get("content-type", "text/event-stream")
            async def gen():
                try:
                    async for chunk in resp.aiter_bytes():
                        yield chunk
                finally:
                    await resp.aclose()
                    await upstream.aclose()
            return StreamingResponse(gen(), status_code=resp.status_code, media_type=media)
        else:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.request(method, target_url, headers=headers, content=body or None)
            return _passthrough(resp)
    except httpx.HTTPStatusError as e:
        return JSONResponse({"error": f"upstream HTTP {e.response.status_code}"}, status_code=502)
    except Exception as e:
        return JSONResponse({"error": f"proxy failure: {type(e).__name__}: {e}"}, status_code=502)


def _passthrough(resp: httpx.Response) -> JSONResponse:
    """Mirror aicq.me behavior: relay upstream status + body as-is when it is
    JSON-ish; wrap raw text minimally. The frontend expects upstream JSON
    (OpenAI responses) or a JSON error body."""
    content_type = resp.headers.get("content-type", "")
    if "application/json" in content_type or _looks_json(resp.content):
        return JSONResponse(json.loads(resp.content), status_code=resp.status_code)
    # non-JSON upstream: wrap as text payload (kept for exotic providers)
    text = resp.content.decode("utf-8", "replace")
    if resp.status_code >= 400:
        return JSONResponse({"error": text[:2000]}, status_code=resp.status_code)
    return JSONResponse({"body": text, "status": resp.status_code})


def _looks_json(b: bytes) -> bool:
    s = b.lstrip()[:1]
    return s in (b"{", b"[")


# ═══════════════ 2. Search proxy ═══════════════

@app.post("/api/v1/agent/search-proxy")
async def search_proxy(request: Request):
    """{query, engine?} -> {results: [{title, url, summary}]}.

    MVP engines: DuckDuckGo HTML (default, keyless), Bing HTML fallback.
    Engine list kept compatible with aicq.me's contract (engine param accepted,
    auto-selection by default).
    """
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)
    query = (payload.get("query") or "").strip()
    engine = (payload.get("engine") or "").strip().lower()
    if not query:
        return JSONResponse({"error": "query required"}, status_code=400)

    try:
        results = []
        engines = []
        if engine in ("bing",):
            engines = [_search_bing, _search_bing_cn]
        elif engine in ("baidu",):
            engines = [_search_baidu]
        elif engine in ("duckduckgo", "ddg"):
            engines = [_search_ddg]
        else:  # auto: ddg -> ddg-lite -> bing -> cn.bing -> baidu（后两档保证中国大陆容器可用）
            engines = [_search_ddg, _search_ddg_lite, _search_bing, _search_bing_cn, _search_baidu]
        for fn in engines:
            try:
                results = await fn(query)
            except Exception:
                results = []
            if results:
                break
        return JSONResponse({"results": results})
    except Exception as e:
        return JSONResponse({"error": f"search failure: {type(e).__name__}: {e}"}, status_code=502)


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or "")).strip()


async def _search_ddg(query: str) -> list:
    async with httpx.AsyncClient(timeout=25, headers={"User-Agent": UA}, follow_redirects=True) as c:
        r = await c.post("https://html.duckduckgo.com/html/", data={"q": query})
    results = []
    # [FIX 2026-09-06] 先切结果块再在块内抽摘要——旧正则的贪婪/可选组组合导致 summary 恒为空
    for block in re.finditer(r'<div[^>]+class="[^"]*result[^"]*"[^"]*>.*?(?=<div[^>]+class="[^"]*result|<div class="nav-link")', r.text, re.S):
        b = block.group(0)
        a = re.search(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', b, re.S)
        if not a:
            continue
        url = a.group(1)
        # DDG wraps links through a redirector — unwrap
        if "uddg=" in url:
            from urllib.parse import urlparse, parse_qs, unquote
            try:
                url = unquote(parse_qs(urlparse(url).query).get("uddg", [url])[0])
            except Exception:
                pass
        snip = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', b, re.S)
        results.append({"title": _clean(a.group(2)), "url": url, "summary": _clean(snip.group(1)) if snip else ""})
        if len(results) >= 10:
            break
    return results


async def _search_ddg_lite(query: str) -> list:
    """DDG lite endpoint — lighter markup, more tolerant of rapid requests."""
    async with httpx.AsyncClient(timeout=25, headers={"User-Agent": UA}, follow_redirects=True) as c:
        r = await c.get("https://lite.duckduckgo.com/lite/", params={"q": query})
    results = []
    # lite layout: <a rel="nofollow" href="URL" class='result-link'>TITLE</a>
    links = re.findall(r"<a[^>]+href=\"(http[^\"]+)\"[^>]*class=['\"]result-link['\"][^>]*>(.*?)</a>", r.text, re.S)
    snippets = re.findall(r"class=['\"]result-snippet['\"]>(.*?)</td>", r.text, re.S)
    for i, (url, title) in enumerate(links):
        results.append({"title": _clean(title), "url": url,
                        "summary": _clean(snippets[i]) if i < len(snippets) else ""})
        if len(results) >= 10:
            break
    return results


def _parse_bing_algo(html: str) -> list:
    """b_algo 块解析——www.bing.com 与 cn.bing.com 通用（[FIX 2026-09-06]）。"""
    results = []
    for block in re.finditer(r'<li class="b_algo"[^>]*>(.*?)(?=<li class="b_algo|<li class="b_msg|</ol>)', html, re.S):
        b = block.group(1)
        a = re.search(r'<h2[^>]*><a[^>]+href="(http[^"]+)"[^>]*>(.*?)</a>', b, re.S)
        if not a:
            continue
        snip = re.search(r'<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>(.*?)</p>|<div[^>]*class="b_caption"[^>]*>.*?<p[^>]*>(.*?)</p>', b, re.S)
        summary = ""
        if snip:
            summary = snip.group(1) or snip.group(2) or ""
        results.append({"title": _clean(a.group(2)), "url": a.group(1), "summary": _clean(summary)})
        if len(results) >= 10:
            break
    return results


async def _search_bing(query: str) -> list:
    async with httpx.AsyncClient(timeout=25, headers={"User-Agent": UA}, follow_redirects=True) as c:
        r = await c.get("https://www.bing.com/search", params={"q": query, "count": "10"})
    # 新版 b_algo 解析；空则回退旧 h2 正则
    results = _parse_bing_algo(r.text)
    if not results:
        for m in re.finditer(
                r'<h2><a href="(http[^"]+)"[^>]*>(.*?)</a></h2>.*?<p[^>]*>(.*?)</p>',
                r.text, re.S):
            results.append({"title": _clean(m.group(2)), "url": m.group(1), "summary": _clean(m.group(3))})
            if len(results) >= 10:
                break
    return results


async def _search_bing_cn(query: str) -> list:
    """cn.bing.com —— 中国大陆可达（[FIX 2026-09-06] 国内容器搜索失败的兜底）。"""
    async with httpx.AsyncClient(timeout=25, headers={"User-Agent": UA}, follow_redirects=True) as c:
        r = await c.get("https://cn.bing.com/search", params={"q": query, "count": "10"})
    return _parse_bing_algo(r.text)


async def _search_baidu(query: str) -> list:
    """百度网页搜索 —— 中国大陆最稳的免 key 引擎（[FIX 2026-09-06] 新增）。"""
    async with httpx.AsyncClient(timeout=25, headers={"User-Agent": UA}, follow_redirects=True) as c:
        r = await c.get("https://www.baidu.com/s", params={"wd": query, "rn": "10"})
    results = []
    for block in re.finditer(r'<div[^>]+class="result[^"]*c-container[^"]*"[^>]*>(.*?)(?=<div[^>]+class="result|<div id="page")', r.text, re.S):
        b = block.group(1)
        a = re.search(r'<h3[^>]*>\s*<a[^>]+href="(http[^"]+)"[^>]*>(.*?)</a>', b, re.S)
        if not a:
            continue
        snip = (re.search(r'class="[^"]*c-abstract[^"]*"[^>]*>(.*?)</div>', b, re.S)
                or re.search(r'class="[^"]*content-right[^"]*"[^>]*>(.*?)</span>', b, re.S)
                or re.search(r'<span[^>]*class="[^"]*"[^>]*>([^<]{30,}?)</span>', b, re.S))
        results.append({"title": _clean(a.group(2)), "url": a.group(1),
                        "summary": _clean(snip.group(1)) if snip else ""})
        if len(results) >= 10:
            break
    return results


# ═══════════════ 3. Web proxy ═══════════════

@app.post("/api/v1/agent/web-proxy")
async def web_proxy(request: Request):
    """{url, mode: html|raw, method?, headers?, body?} -> {status, body}.

    Mirrors aicq.me: html mode returns the page source (frontend parses it);
    raw mode passes through API responses verbatim for the url-read tool.
    """
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)
    url = (payload.get("url") or "").strip()
    if not re.match(r"^https?://", url):
        return JSONResponse({"error": "url must be http(s)"}, status_code=400)
    mode = (payload.get("mode") or "html").lower()
    method = (payload.get("method") or "GET").upper()
    headers = dict(payload.get("headers") or {})
    headers.setdefault("User-Agent", UA)
    body = payload.get("body")
    if isinstance(body, (dict, list)):
        body = json.dumps(body)

    try:
        async with httpx.AsyncClient(timeout=45, headers=headers, follow_redirects=True) as c:
            resp = await c.request(method, url, content=body if method not in ("GET", "HEAD") else None)
        text = resp.text
        if mode == "raw":
            out = {"status": resp.status_code, "body": text[:20000]}
            # [ADD 2026-10-07] binary:true → body_b64 (base64 of the raw bytes) —
            # JSON text mangles non-UTF-8 bytes, binary payloads (PNG etc.) must
            # be consumed from body_b64. Mirrors apishare.cc's Go web-proxy.
            if payload.get("binary") and len(resp.content) <= 2 * 1024 * 1024:
                out["body_b64"] = _b64.b64encode(resp.content).decode()
            return JSONResponse(out)
        return JSONResponse({"status": resp.status_code, "body": text})
    except Exception as e:
        return JSONResponse({"error": f"fetch failure: {type(e).__name__}: {e}"}, status_code=502)


# ═══════════════ 3b. Git clone relay ═══════════════
# [ADD 2026-10-07] Mirrors apishare.cc's Go relay: the browser agent has no git
# binary and codeload.github.com sends no CORS headers, so the relay downloads
# the GitHub tarball, unpacks it in memory and returns a bounded manifest.
# The agent's git-clone tool writes every file into the virtual FS (IndexedDB)
# under /repos/{owner}/{repo}/{branch}/ — visible in the file manager (folder
# button). Bounds: tarball 80MB, 2000 files, 1MB/text file, 384KB/binary,
# 24MB total payload; per-IP 6 clones / 10 min.
_gitclone_rate = {}


@app.post("/api/v1/agent/git-clone")
async def git_clone_proxy(request: Request):
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)
    url = (payload.get("url") or "").strip()
    branch = ((payload.get("branch") or "").strip())
    m = re.match(r"^https?://(?:www\.)?github\.com/([A-Za-z0-9._-]{1,100})/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:/tree/([^/]+))?/?$", url)
    if not m:
        return JSONResponse({"error": "only github.com repository URLs are supported"}, status_code=400)
    owner, repo, url_branch = m.group(1), m.group(2), m.group(3)
    branch = branch or url_branch or ""
    branch = branch.replace("refs/heads/", "").strip()
    if any(ch in branch for ch in ("..", "?", "#")):
        return JSONResponse({"error": "invalid branch name"}, status_code=400)

    # per-IP fixed-window rate limit (6 / 10 min)
    ip = request.client.host if request.client else "?"
    now = time.time()
    win = _gitclone_rate.get(ip)
    if win is None or now - win[0] >= 600:
        if len(_gitclone_rate) > 4096:
            _gitclone_rate.clear()
        _gitclone_rate[ip] = (now, 1)
    elif win[1] >= 6:
        return JSONResponse({"error": "rate limit: 6 clones per 10 minutes, try again later"}, status_code=429)
    else:
        _gitclone_rate[ip] = (win[0], win[1] + 1)

    headers = {"User-Agent": UA}
    if not branch:
        try:
            async with httpx.AsyncClient(timeout=20, headers=headers, follow_redirects=True) as c:
                r = await c.get(f"https://api.github.com/repos/{owner}/{repo}")
            if r.status_code == 200:
                branch = (r.json() or {}).get("default_branch") or "main"
        except Exception:
            pass
        branch = branch or "main"

    raw = None
    for tu in (f"https://codeload.github.com/{owner}/{repo}/tar.gz/refs/heads/{_urlquote(branch, safe='')}",
               f"https://codeload.github.com/{owner}/{repo}/tar.gz/{_urlquote(branch, safe='')}"):
        try:
            async with httpx.AsyncClient(timeout=45, headers=headers, follow_redirects=True) as c:
                r = await c.get(tu)
        except Exception as e:
            return JSONResponse({"error": f"github fetch failure: {type(e).__name__}: {e}"}, status_code=502)
        if r.status_code == 200:
            raw = r.content
            break
        if r.status_code == 404:
            continue
        return JSONResponse({"error": f"codeload returned {r.status_code}"}, status_code=502)
    if raw is None:
        return JSONResponse({"error": f"repository or branch not found: {owner}/{repo}@{branch}"}, status_code=404)
    if len(raw) > 80 * 1024 * 1024:
        return JSONResponse({"error": "tarball too large (>80MB)"}, status_code=413)

    MAX_FILES, MAX_FILE, MAX_BIN, MAX_TOTAL = 2000, 1 << 20, 384 << 10, 24 << 20
    files, skipped, skipped_count, total, truncated = [], [], 0, 0, False
    try:
        with tarfile.open(fileobj=_io.BytesIO(raw), mode="r:gz") as tf:
            for member in tf:
                if len(files) >= MAX_FILES:
                    truncated = True
                    break
                if not member.isfile():
                    continue
                parts = member.name.split("/", 1)
                rel = (parts[1] if len(parts) == 2 else "").replace("\\", "/")
                if not rel or ".." in rel.split("/"):
                    continue
                if member.size > MAX_FILE:
                    skipped_count += 1
                    if len(skipped) < 40:
                        skipped.append({"path": rel, "reason": "file too large (>1MB)"})
                    continue
                try:
                    fobj = tf.extractfile(member)
                    data = fobj.read() if fobj else b""
                except Exception:
                    continue
                binary = b"\x00" in data[:8000]
                if binary and member.size > MAX_BIN:
                    skipped_count += 1
                    if len(skipped) < 40:
                        skipped.append({"path": rel, "reason": "binary file too large (>384KB)"})
                    continue
                if total + member.size > MAX_TOTAL:
                    truncated = True
                    break
                files.append({
                    "path": rel, "size": member.size, "binary": binary,
                    "encoding": "base64" if binary else "utf8",
                    "content": _b64.b64encode(data).decode() if binary else data.decode("utf-8", "replace"),
                })
                total += member.size
    except tarfile.TarError as e:
        return JSONResponse({"error": f"tar parse failure: {type(e).__name__}: {e}"}, status_code=502)
    if not files:
        return JSONResponse({"error": "clone produced no files (repository empty or unsupported ref)"}, status_code=502)
    return JSONResponse({
        "ok": True, "repo": f"{owner}/{repo}", "branch": branch,
        "file_count": len(files), "total_bytes": total, "truncated": truncated,
        "skipped_count": skipped_count, "skipped": skipped, "files": files,
    })


# ═══════════════ 3c. Git push relay ═══════════════
# [ADD 2026-10-07] Mirrors apishare.cc's Go relay (bot_gitpush.go): the browser
# agent has no git binary, so the relay performs a real atomic commit through
# the GitHub Git Data API — blobs → tree (based on the branch head's tree) →
# commit → ref update (force=false, non-fast-forward fails safely). The user's
# GitHub token (fine-grained PAT with Contents: read+write) is used for the
# upstream calls only and never stored server-side. Bounds: ≤200 files/commit,
# ≤2MB/file, ≤8MB total raw, ≤24MB body; per-IP 10 pushes / 10 min.
_gitpush_rate = {}


async def _gh_call(method: str, endpoint: str, token: str, payload=None, timeout: int = 30):
    """One token-authenticated api.github.com call. Returns (status, body)."""
    headers = {"User-Agent": UA, "Accept": "application/vnd.github+json",
               "Authorization": f"Bearer {token}"}
    try:
        async with httpx.AsyncClient(timeout=timeout, headers=headers, follow_redirects=True) as c:
            if payload is not None:
                r = await c.request(method, f"https://api.github.com{endpoint}", json=payload)
            else:
                r = await c.request(method, f"https://api.github.com{endpoint}")
    except Exception as e:
        return 0, {"message": f"github unreachable: {type(e).__name__}: {e}"}
    try:
        body = r.json() if (r.content and r.headers.get("content-type", "").startswith("application/json")) else {"message": r.text[:2000]}
    except Exception:
        body = {"message": (r.text or "")[:2000]}
    return r.status_code, body


def _gh_err_text(status: int, body, prefix: str) -> str:
    detail = str(body.get("message", ""))[:300] if isinstance(body, dict) else str(body)[:300]
    if status == 0:
        return f"{prefix}: {detail}"
    if status == 401:
        return "github rejected the token (401 unauthorized) — check the token value"
    if status == 403:
        return "github refused the operation (403) — the token likely lacks Contents: read and write on this repository, or the API rate limit was hit"
    if status == 404:
        return f"{prefix} (404 not found) — check the repository/branch and that the token can access it"
    return f"{prefix} (github status {status}): {detail}"


def _push_clean_path(p: str) -> str:
    p = (p or "").strip().replace("\\", "/")
    p = re.sub(r"/+", "/", p).strip("/")
    if not p or p == "." or ".." in p.split("/") or len(p) > 512:
        return ""
    return p


@app.post("/api/v1/agent/git-push")
async def git_push_proxy(request: Request):
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)

    token = (payload.get("token") or "").strip()
    if not token:
        return JSONResponse({"error": "github token required — create a fine-grained PAT at github.com/settings/personal-access-tokens/new with Contents: read and write on the target repository"}, status_code=400)
    message = (payload.get("message") or "").strip()
    if not message:
        return JSONResponse({"error": "commit message required"}, status_code=400)

    url = (payload.get("url") or "").strip()
    m = re.match(r"^https?://(?:www\.)?github\.com/([A-Za-z0-9._-]{1,100})/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:/tree/([^/]+))?/?$", url)
    if not m:
        return JSONResponse({"error": "only github.com repository URLs are supported"}, status_code=400)
    owner, repo = m.group(1), m.group(2)
    branch = ((payload.get("branch") or m.group(3) or "").strip()).replace("refs/heads/", "")
    if not branch or any(ch in branch for ch in ("..", "?", "#")):
        return JSONResponse({"error": "branch required for git-push"}, status_code=400)

    # per-IP fixed-window rate limit (10 / 10 min)
    ip = request.client.host if request.client else "?"
    now = time.time()
    win = _gitpush_rate.get(ip)
    if win is None or now - win[0] >= 600:
        if len(_gitpush_rate) > 4096:
            _gitpush_rate.clear()
        _gitpush_rate[ip] = (now, 1)
    elif win[1] >= 10:
        return JSONResponse({"error": "rate limit: 10 pushes per 10 minutes, try again later"}, status_code=429)
    else:
        _gitpush_rate[ip] = (win[0], win[1] + 1)

    # validate + normalize the changed-file set before touching github
    MAX_FILES, MAX_FILE, MAX_TOTAL = 200, 2 << 20, 8 << 20
    changes, total = [], 0
    for f in (payload.get("files") or [])[:MAX_FILES + 1]:
        if len(changes) >= MAX_FILES:
            return JSONResponse({"error": f"too many files in one commit (max {MAX_FILES})"}, status_code=400)
        p = _push_clean_path(f.get("path") or "")
        if not p:
            return JSONResponse({"error": f"invalid file path: {f.get('path')}"}, status_code=400)
        enc = (f.get("encoding") or "utf8").strip().lower()
        if enc not in ("utf8", "base64"):
            return JSONResponse({"error": f"encoding must be utf8 or base64 (path {p})"}, status_code=400)
        content = f.get("content") or ""
        raw = len(content) * 3 // 4 if enc == "base64" else len(content)
        if raw > MAX_FILE:
            return JSONResponse({"error": f"file too large (max 2MB): {p}"}, status_code=400)
        total += raw
        if total > MAX_TOTAL:
            return JSONResponse({"error": "total changed content too large (max 8MB per commit)"}, status_code=400)
        changes.append({"path": p, "content": content, "encoding": enc, "is_delete": False})
    deletions, seen = [], set()
    for d in (payload.get("deletions") or []):
        p = _push_clean_path(d)
        if not p:
            return JSONResponse({"error": f"invalid deletion path: {d}"}, status_code=400)
        if p in seen:
            continue
        seen.add(p)
        deletions.append(p)
    if not changes and not deletions:
        return JSONResponse({"error": "nothing to commit — provide files and/or deletions"}, status_code=400)

    created_branch = False
    # 1. resolve the branch head (optionally create the branch first)
    st, body = await _gh_call("GET", f"/repos/{owner}/{repo}/git/ref/heads/{branch}", token)
    if st != 200:
        if st == 404 and payload.get("create"):
            st2, meta = await _gh_call("GET", f"/repos/{owner}/{repo}", token)
            default_branch = (meta or {}).get("default_branch", "main") if st2 == 200 else "main"
            st3, dref = await _gh_call("GET", f"/repos/{owner}/{repo}/git/ref/heads/{default_branch}", token)
            if st3 != 200:
                return JSONResponse({"error": _gh_err_text(st3, dref, "cannot read default branch")}, status_code=400)
            st4, cbody = await _gh_call("POST", f"/repos/{owner}/{repo}/git/refs", token,
                                        payload={"ref": f"refs/heads/{branch}", "sha": (dref or {}).get("object", {}).get("sha")})
            if st4 not in (200, 201):
                return JSONResponse({"error": _gh_err_text(st4, cbody, f"cannot create branch {branch}")}, status_code=400)
            st, body = await _gh_call("GET", f"/repos/{owner}/{repo}/git/ref/heads/{branch}", token)
            created_branch = True
        else:
            return JSONResponse({"error": _gh_err_text(st, body, f"cannot read branch {branch} (does it exist? token valid / repo accessible?)")}, status_code=400)
    base_sha = (body or {}).get("object", {}).get("sha")

    # 2. base tree of the branch head
    st, bcommit = await _gh_call("GET", f"/repos/{owner}/{repo}/git/commits/{base_sha}", token)
    if st != 200:
        return JSONResponse({"error": _gh_err_text(st, bcommit, "cannot read base commit")}, status_code=502)
    base_tree = (bcommit or {}).get("tree", {}).get("sha")

    # 3. blobs for every changed file
    tree_entries, n_files, n_dels = [], 0, 0
    for c in changes:
        if c["is_delete"]:
            tree_entries.append({"path": c["path"], "mode": "100644", "type": "blob", "sha": None})
            n_dels += 1
            continue
        st, blob = await _gh_call("POST", f"/repos/{owner}/{repo}/git/blobs", token,
                                  payload={"content": c["content"], "encoding": c["encoding"]})
        if st not in (200, 201):
            return JSONResponse({"error": _gh_err_text(st, blob, f"cannot create blob for {c['path']}")}, status_code=502)
        tree_entries.append({"path": c["path"], "mode": "100644", "type": "blob", "sha": blob.get("sha")})
        n_files += 1
    for p in deletions:
        tree_entries.append({"path": p, "mode": "100644", "type": "blob", "sha": None})
        n_dels += 1

    # 4. one atomic tree on top of the branch's current tree
    st, tree = await _gh_call("POST", f"/repos/{owner}/{repo}/git/trees", token,
                              payload={"base_tree": base_tree, "tree": tree_entries})
    if st not in (200, 201):
        return JSONResponse({"error": _gh_err_text(st, tree, "cannot create tree")}, status_code=502)

    # 5. commit it
    st, commit = await _gh_call("POST", f"/repos/{owner}/{repo}/git/commits", token,
                                payload={"message": message, "tree": tree.get("sha"), "parents": [base_sha]})
    if st not in (200, 201):
        return JSONResponse({"error": _gh_err_text(st, commit, "cannot create commit")}, status_code=502)

    # 6. move the branch ref (force=false → fail instead of clobbering)
    st, ref = await _gh_call("PATCH", f"/repos/{owner}/{repo}/git/refs/heads/{branch}", token,
                             payload={"sha": commit.get("sha"), "force": False})
    if st != 200:
        if st == 422:
            return JSONResponse({"error": "branch moved since it was read (non-fast-forward) — run git-pull to refresh your copy, then push again"}, status_code=409)
        return JSONResponse({"error": _gh_err_text(st, ref, f"cannot update ref {branch}")}, status_code=502)

    return JSONResponse({
        "ok": True, "repo": f"{owner}/{repo}", "branch": branch,
        "commit": commit.get("sha"), "html_url": commit.get("html_url"),
        "files": n_files, "deletions": n_dels, "created_branch": created_branch,
    })


# ═══════════════ 4/5. Frontend static hosting ═══════════════
# /static/app.js|app.css  — shell UI
# /static/agent/*         — agent bundle (identical paths to aicq.me so the
#                           engine's internal dynamic imports work unmodified)
app.mount("/static", StaticFiles(directory=str(WEB_DIR / "static")), name="static")


# [2026-09-06] 防陈旧壳：shell 资源（index.html / app.js / app.css）必须每次刷新
# 向服务器重新验证，否则浏览器可能继续跑旧版 UI（用户看不到新功能还以为没实现）。
# bundle 文件走 AGENT_VER=Date.now() 动态参数，本身不缓存；这里兜底 index 与 /static。
@app.middleware("http")
async def _no_shell_cache(request: Request, call_next):
    resp = await call_next(request)
    p = request.url.path
    if p == "/" or p.endswith(".html") or p.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


@app.get("/", response_class=HTMLResponse)
async def index():
    return FileResponse(str(WEB_DIR / "index.html"))


@app.get("/healthz")
async def healthz():
    return {"ok": True, "version": PKG_VERSION}
