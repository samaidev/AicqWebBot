"""
aicq.me 工作流 #11: 发布 pip 包 aicqwebbot
==========================================
触发条件: aicq 仓库 main 分支中 AicqWebBot/ 目录有更新（与 wf10 同路径）
功能:
  1. 拉取 aicq main
  2. 读取 AicqWebBot/pyproject.toml 的版本号
  3. 查询 PyPI 上该版本是否已发布（已发则跳过，幂等）
  4. python -m build + twine upload

安全: 不发 aicq 主仓源码，只发 AicqWebBot/ 文件夹内容。
"""
import sys
import os
import re
import json
import shutil
import urllib.request

sys.path.insert(0, r'd:\samai_ci\_shared')
from common import WorkflowBase, run_cmd, git_fetch_and_pull, git_get_commit, git_get_changed_files, get_cred

PRODUCT = 'aicq.me'
WORKFLOW = 'publish_aicqwebbot_pypi'
PKG = 'aicqwebbot'


def _pypi_latest_version():
    try:
        with urllib.request.urlopen(f'https://pypi.org/pypi/{PKG}/json', timeout=20) as r:
            data = json.loads(r.read().decode('utf-8'))
        return data.get('info', {}).get('version', '')
    except Exception:
        return ''


class PublishAicqWebBotPypi(WorkflowBase):
    def __init__(self):
        super().__init__(PRODUCT, WORKFLOW)

    def execute(self):
        repos_dir = os.path.join(self.paths['ci'], 'repos')
        aicq_repo = os.path.join(repos_dir, 'aicq')
        src = os.path.join(aicq_repo, 'AicqWebBot')

        if not os.path.exists(src):
            self.logger.error('aicq/AicqWebBot/ 不存在')
            return False

        ok, msg = git_fetch_and_pull(aicq_repo, logger=self.logger)
        if not ok:
            self.logger.error(f'拉取 aicq 失败: {msg}')
            return False
        run_cmd('git checkout main && git reset --hard origin/main', cwd=aicq_repo, logger=self.logger)

        # 版本号
        with open(os.path.join(src, 'pyproject.toml'), 'r', encoding='utf-8') as f:
            m = re.search(r'^version\s*=\s*"([^"]+)"', f.read(), re.M)
        if not m:
            self.logger.error('无法从 pyproject.toml 读取版本号')
            return False
        version = m.group(1)
        remote_version = _pypi_latest_version()
        self.logger.info(f'本地版本 {version} / PyPI 最新 {remote_version or "(未发布)"}')
        if version == remote_version:
            self.logger.info('版本已在 PyPI 上，跳过发布')
            return True

        # 清理旧构建产物
        for d in ('dist', 'build'):
            shutil.rmtree(os.path.join(src, d), ignore_errors=True)
        for item in os.listdir(src):
            if item.endswith('.egg-info'):
                shutil.rmtree(os.path.join(src, item), ignore_errors=True)

        # 构建
        rc, out, err = run_cmd(f'python -m build --wheel --sdist "{src}"', logger=self.logger, timeout=600)
        if rc != 0:
            self.logger.error(f'build 失败: {err}')
            return False

        # 上传
        token = get_cred('PYPI_TOKEN')
        rc, out, err = run_cmd(
            f'python -m twine upload --non-interactive '
            f'-u __token__ -p {token} --disable-progress-bar '
            f'"{os.path.join(src, "dist", "*")}"',
            logger=self.logger, timeout=600,
        )
        if rc != 0:
            # File already exists = 版本冲突，视作成功（并发触发）
            combined = (out or '') + (err or '')
            if 'File already exists' in combined or 'already exists' in combined:
                self.logger.warning('PyPI 上已有该版本（视为成功）')
                return True
            self.logger.error(f'twine 上传失败: {err}')
            return False
        self.logger.info(f'pip 发布成功: {PKG}=={version}  (pip install {PKG})')
        return True


if __name__ == '__main__':
    workflow = PublishAicqWebBotPypi()
    success = workflow.run()
    sys.exit(0 if success else 1)
