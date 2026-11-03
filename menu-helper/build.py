"""Build the local menu-bar app using Apple's installed command-line tools."""
from pathlib import Path
import json
import os
import plistlib
import shutil
import subprocess

LSREGISTER = ('/System/Library/Frameworks/CoreServices.framework/Frameworks/'
              'LaunchServices.framework/Support/lsregister')
root = Path(__file__).resolve().parent.parent
app = root / 'Print Chamber 小助手.app'
contents = app / 'Contents'
# One version for the extension and helper; the manifest is the source of truth.
version = json.loads((root / 'extension/manifest.json').read_text(encoding='utf-8'))['version']
(contents / 'MacOS').mkdir(parents=True, exist_ok=True)
(contents / 'Resources').mkdir(exist_ok=True)
# AppIcon.icns is generated from extension/icons/icon.svg by build-icons.cjs.
shutil.copyfile(root / 'menu-helper/AppIcon.icns', contents / 'Resources/AppIcon.icns')
info = dict(CFBundleExecutable='PrintChamberHelper', CFBundleIdentifier='local.printchamber.helper',
            CFBundleName='Print Chamber 小助手', CFBundlePackageType='APPL',
            CFBundleShortVersionString=version, CFBundleVersion='1', CFBundleIconFile='AppIcon', LSUIElement=True,
            NSHighResolutionCapable=True, LSMinimumSystemVersion='13.0', ProjectRoot=str(root))
(contents / 'Info.plist').write_bytes(plistlib.dumps(info))
subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-O', '-module-cache-path', '/tmp/print-chamber-swift-cache',
                str(root / 'menu-helper/main.swift'), '-o', str(contents / 'MacOS/PrintChamberHelper')], check=True)
subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(app)], check=True)
# Rebuilding in place keeps the bundle's mtime, so Finder keeps showing its cached icon.
os.utime(app)
subprocess.run([LSREGISTER, '-f', str(app)], check=False)
print(app)
