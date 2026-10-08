import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('build_web', Path(__file__).resolve().parents[2] / 'scripts/build_web.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class ReleaseTests(unittest.TestCase):
    def test_replaces_old_files_without_accumulating_versions(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            old, new = root / 'local-web-release', root / 'staging'
            old.mkdir(); new.mkdir()
            (old / 'obsolete').write_text('old')
            (new / 'app').write_text('new')
            (root / 'user-data').write_text('keep')
            build.replace_release(new, old)
            self.assertFalse((old / 'obsolete').exists())
            self.assertEqual((old / 'app').read_text(), 'new')
            self.assertEqual((root / 'user-data').read_text(), 'keep')
            self.assertFalse(list(root.glob('.local-web-previous-*')))

    def test_failed_promotion_restores_previous_version(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            old, new = root / 'local-web-release', root / 'staging'
            old.mkdir(); new.mkdir()
            (old / 'app').write_text('working')
            rename = Path.rename
            def fail(source, target):
                if source == new:
                    raise OSError('test failure')
                return rename(source, target)
            with patch.object(Path, 'rename', fail), self.assertRaises(OSError):
                build.replace_release(new, old)
            self.assertEqual((old / 'app').read_text(), 'working')
            self.assertFalse(list(root.glob('.local-web-previous-*')))


if __name__ == '__main__':
    unittest.main()
