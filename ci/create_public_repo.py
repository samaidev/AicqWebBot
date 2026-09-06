"""One-shot: create public repo samaidev/AicqWebBot (idempotent)."""
import json
import sys

sys.path.insert(0, r'd:\samai_ci\_shared')
from common import get_cred
import urllib.request

token = get_cred('GITHUB_TOKEN')
data = json.dumps({
    "name": "AicqWebBot",
    "description": "Your browser is the agent's container. Browser-native AI agent runtime (pip install aicqwebbot).",
    "homepage": "https://aicq.me",
    "private": False,
    "has_wiki": False,
    "has_projects": False,
}).encode()
req = urllib.request.Request(
    'https://api.github.com/user/repos', data=data,
    headers={'Authorization': f'token {token}', 'Accept': 'application/vnd.github+json',
             'User-Agent': 'samai-ci'})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print('CREATED:', r.status)
except urllib.error.HTTPError as e:
    body = e.read().decode('utf-8', 'replace')
    if e.code == 422:
        print('ALREADY_EXISTS')
    else:
        print('ERROR:', e.code, body[:300])
        sys.exit(1)
