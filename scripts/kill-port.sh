#!/bin/sh
# Kill whatever process is listening on the given TCP port.
# Usage: kill-port.sh <port>
PORT="$1"
[ -z "$PORT" ] && exit 0

PID=$(netstat -tlnp 2>/dev/null | awk -v p="$PORT" '$4 ~ ":"p"$" {split($7, a, "/"); print a[1]}')
[ -z "$PID" ] && exit 0

echo ">>> Port $PORT in use by PID $PID, killing"
kill "$PID" 2>/dev/null
sleep 0.5

# Check if it's still alive
if kill -0 "$PID" 2>/dev/null; then
  kill -9 "$PID" 2>/dev/null
  sleep 0.3
fi
