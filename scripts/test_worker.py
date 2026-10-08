import os
import subprocess
import sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
python=root/'.venv'/('Scripts/python.exe' if sys.platform=='win32' else 'bin/python')
env={**os.environ,'PYTHONUTF8':'1','PYTHONPATH':os.pathsep.join([str(root/'worker'),str(root/'worker/legacy')])}
raise SystemExit(subprocess.call([str(python),'-B','-m','unittest','discover','-s',str(root/'tests/worker')],cwd=root,env=env))
