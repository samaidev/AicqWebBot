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
import re
from pathlib import Path

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

@app.post("/api/v1/agent/llm-proxy")
async def llm_proxy(request: Request):
    """Generic relay: {target_url, method, headers, body, stream} -> upstream.

    The browser agent builds a full OpenAI-compatible request (including the
    user's API key in headers) and posts it here. We forward verbatim and
    stream the response back when asked. The key transits this process in
    memory only — nothing is stored, logged, or sent anywhere else.
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
            return JSONResponse({"status": resp.status_code, "body": text[:20000]})
        return JSONResponse({"status": resp.status_code, "body": text})
    except Exception as e:
        return JSONResponse({"error": f"fetch failure: {type(e).__name__}: {e}"}, status_code=502)


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
