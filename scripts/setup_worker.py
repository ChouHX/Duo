"""Run with python or python3 on macOS and Windows."""
import subprocess
import sys
import venv
from pathlib import Path

root = Path(__file__).resolve().parents[1]
if sys.version_info < (3, 10):
    raise SystemExit('需要 Python 3.10 或更新版本（开发建议 3.12）。')
environment = root / '.venv'
python = environment / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')
if not python.exists():
    venv.EnvBuilder(with_pip=True).create(environment)
subprocess.run([str(python), '-m', 'pip', 'install', '-r', str(root / 'worker/build-requirements.txt')], check=True)
(root/'src-tauri/resources/worker').mkdir(parents=True, exist_ok=True)
print('Python 业务进程开发环境已准备好。')
