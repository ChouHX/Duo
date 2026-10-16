import shutil
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
python = root / '.venv' / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')
if not python.exists():
    raise SystemExit('请先运行 python scripts/setup_worker.py。')
# 只在有原生凭据库的平台内置对应 keyring 后端；Linux 走 credentials.Vault 的无保险库分支。
backend = {'win32': 'keyring.backends.Windows', 'darwin': 'keyring.backends.macOS'}.get(sys.platform)
command = [str(python), '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
    '--name', 'duo-killer-worker', '--distpath', str(root/'worker/dist'), '--workpath', str(root/'worker/build'),
    '--specpath', str(root/'worker/build'), '--paths', str(root/'worker/legacy'),
    '--collect-all', 'playwright', '--collect-data', 'tzdata']
if backend:
    command += ['--hidden-import', backend]
command += ['--hidden-import', 'srp._pysrp', '--hidden-import', 'qrcode.image.pure',
            str(root/'worker/main.py')]
subprocess.run(command, cwd=root, check=True)
destination = root/'src-tauri/resources/worker'
if destination.exists():
    shutil.rmtree(destination)
shutil.copytree(root/'worker/dist/duo-killer-worker', destination)
print('已内置 Python 与依赖：', destination)
