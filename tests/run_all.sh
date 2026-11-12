#!/usr/bin/env bash
# 一键运行全部测试：后端（Python 标准库 + FastAPI 桩）、前端状态机、端到端协议集成。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 后端测试 =="
python3 -I tests/run_backend_tests.py

echo
echo "== 前端状态机测试 =="
node tests/run_frontend_tests.js

echo
echo "== 端到端协议集成测试 =="
node tests/run_integration_tests.js

echo
echo "全部测试通过。"
