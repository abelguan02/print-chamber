import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import runtime_config


class RuntimeConfigTests(unittest.TestCase):
    def test_environment_overrides_saved_machine_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            (state / 'runtime.json').write_text(json.dumps({'python': '/saved/python', 'model': '/saved/model'}))
            with patch.object(runtime_config, 'STATE', state), patch.dict(os.environ, {'FLUX_PYTHON': '/override/python'}, clear=True):
                config = runtime_config.settings()
                self.assertEqual(config['python'], Path('/override/python'))
                self.assertEqual(config['model'], Path('/saved/model'))

    def test_new_checkout_defaults_to_project_venv(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(runtime_config, 'STATE', Path(folder)), patch.dict(os.environ, {}, clear=True):
                self.assertEqual(runtime_config.settings()['python'], runtime_config.ROOT / '.venv/bin/python')

    def test_python_symlink_is_preserved_to_keep_venv_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            executable = state / 'venv-python'
            executable.symlink_to('/usr/bin/python3')
            with patch.object(runtime_config, 'STATE', state), patch.dict(os.environ, {'FLUX_PYTHON': str(executable)}, clear=True):
                self.assertEqual(runtime_config.settings()['python'], executable)


if __name__ == '__main__':
    unittest.main()
