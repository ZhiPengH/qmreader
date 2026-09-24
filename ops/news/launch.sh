#!/bin/bash
# 纵览News 本地预览一键拉起：服务没起就起，起了就复用；最后打开浏览器。
# 用法：./launch.sh [端口，默认 4178]；批注/验收请在 Hermes 内置浏览器（⌘⇧L）里做。
set -euo pipefail
cd "$(dirname "$0")/../.."
PORT="${1:-4178}"
DATA_DIR="/Volumes/HzpSSD/Development/Runtime/news-rss-e00gvha_"

# 只杀占端口的 node server.js，别碰别的
if PID=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null); then
  if ps -p "$PID" -o command= | grep -q 'node server.js'; then
    echo "端口 ${PORT} 已有预览服务（PID ${PID}），直接复用"
  else
    echo "端口 ${PORT} 被非预览进程占用（PID ${PID}），请先处理" >&2
    exit 1
  fi
else
  echo "启动预览服务（端口 ${PORT}，日志 /tmp/zonglan-news-preview.log）…"
  QMREADER_DATA_DIR="$DATA_DIR" HOST=127.0.0.1 PORT="$PORT" PUBLIC_ORIGIN= \
    STARTUP_REFRESH_DELAY_MS=-1 FRESHNESS_SWEEP_INTERVAL_MS=-1 TWITTER_SWEEP_INTERVAL_MS=-1 \
    nohup node server.js > /tmp/zonglan-news-preview.log 2>&1 &
  for i in $(seq 1 20); do
    sleep 0.3
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
    [ "$i" = 20 ] && { echo "启动失败，看日志：/tmp/zonglan-news-preview.log"; exit 1; }
  done
  echo "服务已启动"
fi

open "http://127.0.0.1:$PORT/"
echo "已打开 http://127.0.0.1:$PORT/"
