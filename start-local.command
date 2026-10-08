#!/bin/zsh
cd "${0:A:h}"
PYTHON_BIN="${FLUX_PYTHON:-/Users/abelguan/Documents/Codex/LocalModels/flux2-klein/.venv/bin/python}"
if curl -fsS --max-time 2 http://127.0.0.1:8877/health >/dev/null 2>&1; then
  echo "本地服务已在运行。插件连接码："
  cat .local/token
  echo "\n试用画廊：http://127.0.0.1:8877/demo"
  read "?按回车关闭此窗口"
  exit 0
fi
exec "$PYTHON_BIN" service.py
