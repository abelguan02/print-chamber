import json
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch
import runtime_config


class RuntimeConfigTests(unittest.TestCase):
    def test_mode_defaults_and_state_override(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder).resolve()
            for mode in ['dev', 'app']:
                default_state = home / ('Library/Application Support/Print Chamber' if mode == 'app' else '.local')
                for override in [None, home / 'custom']:
                    env = {'HOME': str(home), 'PRINT_CHAMBER_MODE': mode}
                    if override:
                        env['PRINT_CHAMBER_STATE'] = str(override)
                    with self.subTest(mode=mode, override=override), patch.dict(os.environ, env, clear=True):
                        # Load a relocated module so dev defaults also use a clean fixture.
                        module = home / 'runtime_config.py'
                        module.write_bytes(Path(runtime_config.__file__).read_bytes())
                        config = runpy.run_path(str(module))
                        state = override or default_state
                        self.assertEqual(config['STATE'], state)
                        paths = config['settings']()
                        self.assertEqual(paths['python'], (state / 'python' if mode == 'app' else home / '.venv') / 'bin/python')
                        self.assertEqual(paths['model'], (state / 'models' if mode == 'app' else home / 'Models') / 'FLUX.2-klein-4B')
                        self.assertEqual(paths['samples'], home / 'Downloads')

    def test_app_machine_config_and_environment_priority(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            saved = {key: str(state / key) for key in ['python', 'model', 'samples']}
            (state / 'runtime.json').write_text(json.dumps(saved))
            env = {'PRINT_CHAMBER_MODE': 'app', 'PRINT_CHAMBER_STATE': folder}
            with patch.dict(os.environ, env, clear=True):
                config = runpy.run_path(runtime_config.__file__)
                self.assertEqual(config['settings'](), {key: Path(value) for key, value in saved.items()})
                overrides = {'FLUX_PYTHON': '/other/python', 'FLUX_MODEL_PATH': '/other/model',
                             'FLUX_SAMPLES_DIR': '/other/samples'}
                with patch.dict(os.environ, overrides):
                    self.assertEqual(config['settings'](), {key: Path('/other') / key for key in saved})

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
