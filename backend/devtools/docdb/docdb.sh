#!/usr/bin/env bash
# TEST SUBSTITUTE SERVER control script (docdb is NOT MongoDB; see devtools/README.md).
#   devtools/docdb/docdb.sh start|stop|status|snapshot [http-port] [wire-port] [datadir]
# The wire port speaks the MongoDB wire protocol for the REAL drivers (bson package required: npm install in backend/).
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${2:-${DOCDB_PORT:-27018}}"
WIRE="${3:-${DOCDB_WIRE_PORT:-27019}}"
DATA="${4:-${DOCDB_DATA:-$HERE/../.local/docdb}}"
PIDF="$HERE/../.local/docdb-$PORT.pid"
LOG="$HERE/../.local/docdb-$PORT.log"
mkdir -p "$HERE/../.local"
case "${1:-status}" in
  start)
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "docdb already running (pid $(cat "$PIDF"))"; exit 0; fi
    nohup node --max-old-space-size="${DOCDB_HEAP_MB:-6000}" "$HERE/devtools/docdb/server.js" --port "$PORT" --wire-port "$WIRE" --data "$DATA" > "$LOG" 2>&1 &
    echo $! > "$PIDF"
    for i in $(seq 1 600); do if curl -s "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then echo "docdb up: http $PORT, MongoDB wire protocol $WIRE (pid $(cat "$PIDF"))"; exit 0; fi; sleep 0.5; done
    echo "docdb did not start; see $LOG"; exit 1;;
  stop)
    if [ -f "$PIDF" ]; then kill "$(cat "$PIDF")" 2>/dev/null; rm -f "$PIDF"; echo "docdb stopped"; else echo "not running"; fi;;
  snapshot)
    curl -s -X POST -H 'content-type: application/json' -d '{"op":"snapshot"}' "http://127.0.0.1:$PORT/op"; echo;;
  status)
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "running pid $(cat "$PIDF")"; ps -o rss= -p "$(cat "$PIDF")" | awk '{print $1/1024 " MB"}'; else echo "stopped"; fi;;
esac
