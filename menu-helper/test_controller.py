import importlib.util
from pathlib import Path
import unittest
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

if __name__ == '__main__': unittest.main()
