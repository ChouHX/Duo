"""OS differences shared by the source CLI and the packaged worker."""
import os
import shutil
import sys
from pathlib import Path


def private_fd(fd):
    if hasattr(os, 'fchmod'):
        os.fchmod(fd, 0o600)


def browser_candidates(platform=None, environ=None):
    platform = platform or sys.platform
    env = os.environ if environ is None else environ
    if platform == 'darwin':
        return [Path(root) / name / 'Contents/MacOS' / exe
                for root in ('/Applications', str(Path.home() / 'Applications'))
                for name, exe in [('Google Chrome.app', 'Google Chrome'),
                                  ('Microsoft Edge.app', 'Microsoft Edge')]]
    if platform == 'win32':
        return [Path(env[root]) / suffix for root in ('PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA')
                if env.get(root) for suffix in ('Google/Chrome/Application/chrome.exe',
                                                'Microsoft/Edge/Application/msedge.exe')]
    if platform.startswith(('linux', 'freebsd')):
        # 先看 PATH（多数发行版装在 /usr/bin），再补常见安装路径；
        # 固定路径即使不存在也保留，让调用方统一用 is_file() 判定。
        names = ('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
                 'microsoft-edge', 'microsoft-edge-stable')
        found = [Path(found) for name in names if (found := shutil.which(name))]
        known = ('/opt/google/chrome/chrome', '/usr/bin/google-chrome',
                 '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
                 '/usr/bin/chromium-browser', '/snap/bin/chromium',
                 '/usr/bin/microsoft-edge')
        return found + [Path(path) for path in known if Path(path) not in found]
    return []


def find_browser():
    for path in browser_candidates():
        if path.is_file():
            return path
    raise ValueError('未找到 Chrome 或 Edge，请先安装其中一种浏览器。')
