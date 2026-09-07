# ═══════════════ aicqwebbot/__init__.py ═══════════════
# AicqWebBot — Your browser is the agent's container.
#
#   import aicqwebbot
#   aicqwebbot.run(8386)
#
# Starts a local HTTP server that:
#   - serves the web agent frontend (config page + chat page)
#   - provides same-origin proxies the browser agent needs:
#       POST /api/v1/agent/llm-proxy     -> any OpenAI-compatible LLM API
#       POST /api/v1/agent/search-proxy  -> web search
#       POST /api/v1/agent/web-proxy     -> web page fetch
#
# The agent brain (LLM loop, tool calls, WASM sandbox, memory) runs
# ENTIRELY in your browser. The local server is a thin stateless relay.

__version__ = "0.4.8"

_BANNER = r"""
  ╔══════════════════════════════════════════════════════╗
  ║   AicqWebBot — your browser is the agent's container ║
  ║                                                      ║
  ║   Open:  http://localhost:{port:<4}                        ║
  ║   Configure your model key, then chat.               ║
  ╚══════════════════════════════════════════════════════╝
"""


def run(port: int = 8386, host: str = "0.0.0.0"):
    """Start the AicqWebBot local server.

    Args:
        port: HTTP port to listen on (default 8386).
        host: Bind address (default 0.0.0.0 so HF/containers can expose it).
    """
    import uvicorn

    print(_BANNER.format(port=port))
    uvicorn.run("aicqwebbot.server:app", host=host, port=port, log_level="warning")
