import importlib.util
from pathlib import Path
import unittest
import os
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('controller', Path(__file__).with_name('controller.py'))
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)

class LifecycleTests(unittest.TestCase):
    def test_process_inspection_failure_is_not_reported_as_stopped(self):
        with patch.object(c.subprocess, 'run', return_value=SimpleNamespace(returncode=2, stdout='', stderr='permission denied')):
            with self.assertRaises(RuntimeError):
                c.owner()

    def test_lsof_no_matching_listener_is_normal(self):
        with patch.object(c.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stdout='', stderr='')):
            self.assertIsNone(c.owner())

    def test_unknown_port_owner_is_not_stopped(self):
        with patch.object(c, 'status', return_value={'state':'conflict'}), patch.object(c, 'owner', return_value=(99,False)), patch.object(c.os,'kill') as kill:
            self.assertEqual(c.stop()['state'],'conflict'); kill.assert_not_called()

    def test_busy_generation_is_not_stopped(self):
        with patch.object(c,'status',return_value={'state':'busy'}), patch.object(c.os,'kill') as kill:
            self.assertEqual(c.stop()['state'],'busy'); kill.assert_not_called()

    def test_existing_model_is_not_started_twice(self):
        with patch.object(c,'status',return_value={'state':'ready'}), patch.object(c.subprocess,'Popen') as spawn:
            self.assertEqual(c.start()['state'],'ready'); spawn.assert_not_called()

    def test_pid_change_does_not_signal_new_owner(self):
        with patch.object(c,'status',return_value={'state':'ready'}), patch.object(c,'owner',side_effect=[(99,True),(100,False)]), patch.object(c.os,'kill') as kill:
            self.assertEqual(c.stop()['state'],'error'); kill.assert_not_called()

    def test_relative_script_requires_matching_directory(self):
        with patch.object(c,'command',side_effect=['99','python service.py','p99\nn/tmp/other']):
            self.assertEqual(c.owner(),(99,False))

    @unittest.skipUnless(sys.platform == 'darwin', 'macOS controller uses lsof')
    def test_moved_app_retains_only_its_own_listener(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp).resolve()
            app = state / 'Original.app'
            resources = app / 'Contents/Resources'
            resources.mkdir(parents=True)
            script = resources / 'service.py'
            port_file = state / 'port'
            script.write_text("import socket,time\nfrom pathlib import Path\n"
                              "s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen()\n"
                              f"Path({str(port_file)!r}).write_text(str(s.getsockname()[1]))\n"
                              "time.sleep(30)\n")
            with (state / 'service.log').open('ab') as log:
                child = subprocess.Popen([sys.executable, str(script)], cwd=resources, stdout=log, stderr=log)
                try:
                    deadline = time.monotonic() + 5
                    while not port_file.exists() and time.monotonic() < deadline:
                        self.assertIsNone(child.poll(), (state / 'service.log').read_text())
                        time.sleep(.02)
                    moved = state / 'Moved.app'
                    app.rename(moved)
                    with patch.dict(os.environ, PRINT_CHAMBER_MODE='app'), patch.object(c, 'STATE', state), \
                            patch.object(c, 'ROOT', moved / 'Contents/Resources'), patch.object(c, 'PORT', int(port_file.read_text())):
                        self.assertEqual(c.owner(), (child.pid, True))
                        # A different private log must never authorize signaling the listener.
                        log_path = state / 'service.log'
                        log_path.rename(state / 'other.log')
                        log_path.touch()
                        self.assertEqual(c.owner(), (child.pid, False))
                finally:
                    child.terminate()
                    child.wait(timeout=5)

    def test_busy_generation_is_not_restarted(self):
        with patch.object(c,'status',return_value={'state':'busy'}), patch.object(c,'stop') as stop, patch.object(c,'start') as start:
            self.assertEqual(c.restart()['state'],'busy'); stop.assert_not_called(); start.assert_not_called()

    def test_restart_starts_only_after_confirmed_stop(self):
        with patch.object(c,'status',return_value={'state':'ready'}), patch.object(c,'stop',return_value={'state':'stopped'}), patch.object(c,'start',return_value={'state':'loading'}) as start:
            self.assertEqual(c.restart()['state'],'loading'); start.assert_called_once()

    def test_restart_does_not_start_after_failed_stop(self):
        with patch.object(c,'status',return_value={'state':'ready'}), patch.object(c,'stop',return_value={'state':'conflict'}), patch.object(c,'start') as start:
            self.assertEqual(c.restart()['state'],'conflict'); start.assert_not_called()

if __name__ == '__main__': unittest.main()
