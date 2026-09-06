"""
aicq.me 工作流 #10: 同步 AicqWebBot 到公开仓 samaidev/AicqWebBot
==============================================================
触发条件: aicq 仓库 main 分支中 AicqWebBot/ 目录有更新
功能:
  1. 拉取 aicq 仓库 main 分支
  2. 拉取(或克隆) AicqWebBot 公开仓
  3. 用 aicq/AicqWebBot/ 内容覆盖公开仓（保留 .git/.github）
  4. commit + push

独立性: 与 aicqSDK / pluginAICQ 同步工作流完全独立
"""
import sys
import os
import shutil

sys.path.insert(0, r'd:\samai_ci\_shared')
from common import WorkflowBase, run_cmd, git_fetch_and_pull, git_get_commit, git_get_changed_files, get_cred

PRODUCT = 'aicq.me'
WORKFLOW = 'sync_aicqwebbot_to_public'

class SyncAicqWebBotToPublic(WorkflowBase):
    def __init__(self):
        super().__init__(PRODUCT, WORKFLOW)

    def execute(self):
        repos_dir = os.path.join(self.paths['ci'], 'repos')
        aicq_repo = os.path.join(repos_dir, 'aicq')
        public_repo = os.path.join(repos_dir, 'AicqWebBot')

        if not os.path.exists(aicq_repo):
            self.logger.error('aicq 仓库不存在')
            return False

        if not os.path.exists(public_repo):
            self.logger.info('克隆 samaidev/AicqWebBot 公开仓...')
            token = get_cred('GITHUB_TOKEN')
            url = f'https://{token}@github.com/samaidev/AicqWebBot.git'
            rc, _, err = run_cmd(f'git clone {url} "{public_repo}"', logger=self.logger, timeout=300)
            if rc != 0:
                self.logger.error(f'克隆 AicqWebBot 公开仓失败（仓是否已创建？）: {err}')
                return False

        # 获取上次处理的 commit
        state = self.get_state({})
        last_commit = state.get('aicq_main_commit', '')

        # 拉取 aicq main
        self.logger.info('拉取 aicq main 分支...')
        ok, msg = git_fetch_and_pull(aicq_repo, logger=self.logger)
        if not ok:
            self.logger.error(f'拉取 aicq 失败: {msg}')
            return False
        rc, _, err = run_cmd('git checkout main && git reset --hard origin/main',
                             cwd=aicq_repo, logger=self.logger)
        if rc != 0:
            self.logger.error(f'切换 main 失败: {err}')
            return False

        current_commit = git_get_commit(aicq_repo, logger=self.logger)
        self.logger.info(f'aicq main: {current_commit[:8]} (上次: {last_commit[:8] if last_commit else "none"})')

        # 检查 AicqWebBot/ 是否变化
        if last_commit:
            changed = git_get_changed_files(aicq_repo, last_commit, logger=self.logger)
            bot_changed = [f for f in changed if f.startswith('AicqWebBot/')]
            if not bot_changed:
                self.logger.info('AicqWebBot/ 无变化，跳过')
                state['aicq_main_commit'] = current_commit
                self.set_state(state)
                return True
            self.logger.info(f'AicqWebBot/ 修改了 {len(bot_changed)} 个文件')

        # 拉取公开仓
        self.logger.info('拉取 AicqWebBot 公开仓...')
        ok, msg = git_fetch_and_pull(public_repo, logger=self.logger)
        if not ok:
            self.logger.warning(f'拉取公开仓失败（继续尝试）: {msg}')
        run_cmd('git checkout main', cwd=public_repo, logger=self.logger)

        # 清空公开仓（保留 .git/.github）
        for item in os.listdir(public_repo):
            if item in ('.git', '.github'):
                continue
            full_path = os.path.join(public_repo, item)
            if os.path.isdir(full_path):
                shutil.rmtree(full_path, ignore_errors=True)
            else:
                try:
                    os.remove(full_path)
                except:
                    pass

        # 复制 aicq/AicqWebBot/ 到公开仓（排除构建产物）
        src_bot = os.path.join(aicq_repo, 'AicqWebBot')
        if not os.path.exists(src_bot):
            self.logger.error('aicq/AicqWebBot/ 不存在')
            return False

        self.logger.info('同步 AicqWebBot 内容到公开仓...')
        for root, dirs, files in os.walk(src_bot):
            rel = os.path.relpath(root, src_bot)
            # 过滤目录
            dirs[:] = [d for d in dirs if d not in (
                '.git', '.github', '__pycache__', 'node_modules', 'dist',
                'build', '.venv', 'venv') and not d.endswith('.egg-info')]
            dst_root = public_repo if rel == '.' else os.path.join(public_repo, rel)
            os.makedirs(dst_root, exist_ok=True)
            for f in files:
                if f.endswith(('.pyc', '.log')) or f == 'docs-chat.png':
                    continue
                shutil.copy2(os.path.join(root, f), os.path.join(dst_root, f))

        # 提交并推送
        run_cmd('git add -A', cwd=public_repo, logger=self.logger)
        rc, _, _ = run_cmd('git diff --staged --quiet', cwd=public_repo, logger=self.logger)
        if rc == 0:
            self.logger.info('公开仓无变化')
        else:
            self.logger.info('提交并推送...')
            rc, _, err = run_cmd(
                f'git commit -m "sync: from samaidev/aicq main @ {current_commit[:8]}"',
                cwd=public_repo, logger=self.logger
            )
            if rc != 0:
                self.logger.error(f'提交失败: {err}')
                return False
            rc, _, err = run_cmd('git push origin main', cwd=public_repo, logger=self.logger)
            if rc != 0:
                self.logger.error(f'推送失败: {err}')
                return False
            self.logger.info('推送成功')

        state['aicq_main_commit'] = current_commit
        state['last_sync_time'] = __import__('datetime').datetime.now().isoformat()
        self.set_state(state)
        return True


if __name__ == '__main__':
    workflow = SyncAicqWebBotToPublic()
    success = workflow.run()
    sys.exit(0 if success else 1)
