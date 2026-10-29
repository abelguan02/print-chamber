"""Compile the helper without its AppKit launch, then exercise token lookup using fixtures."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class MenuHelperPathTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.folder = Path(cls.temp.name)
        source = (ROOT / 'menu-helper/main.swift').read_text().split('\nlet app = NSApplication.shared', 1)[0]
        source += '\nlet path = connectionTokenURL(project: URL(fileURLWithPath: CommandLine.arguments[1]))\n'
        source += 'print(try String(contentsOf: path, encoding: .utf8))\n'
        main = cls.folder / 'main.swift'
        main.write_text(source)
        cls.binary = cls.folder / 'helper-path-test'
        subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-module-cache-path',
                        str(cls.folder / 'module-cache'), str(main), '-o', str(cls.binary)],
                       check=True, capture_output=True, text=True, timeout=90)

    def test_default_absolute_relative_and_tilde_state_paths(self):
        project = self.folder / 'project'
        default = project / '.local'
        override = self.folder / 'custom state'
        for directory, token in [(default, 'default-test-token'), (override, 'override-test-token')]:
            directory.mkdir(parents=True, exist_ok=True)
            (directory / 'token').write_text(token)
        environment = dict(os.environ)
        environment.pop('PRINT_CHAMBER_STATE', None)
        paths = [None, str(override), 'custom state', os.path.relpath(override, Path.home())]
        paths[-1] = '~/' + paths[-1]
        for setting in paths:
            with self.subTest(state=setting):
                env = dict(environment)
                if setting is not None:
                    env['PRINT_CHAMBER_STATE'] = setting
                result = subprocess.run([str(self.binary), str(project)], cwd=self.folder, env=env,
                                        capture_output=True, text=True, check=True, timeout=5)
                self.assertEqual(result.stdout.strip(), 'default-test-token' if setting is None else 'override-test-token')


if __name__ == '__main__':
    unittest.main()
