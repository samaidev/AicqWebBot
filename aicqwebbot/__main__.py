# console script entry: `aicqwebbot` (defaults to port 8386)
import sys

from . import run


def main():
    port = 8386
    host = "0.0.0.0"
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a in ("-p", "--port") and i + 1 < len(args):
            port = int(args[i + 1])
        elif a in ("--host",) and i + 1 < len(args):
            host = args[i + 1]
        elif a in ("-h", "--help"):
            print("Usage: aicqwebbot [--port 8386] [--host 0.0.0.0]")
            sys.exit(0)
    run(port=port, host=host)


if __name__ == "__main__":
    main()
