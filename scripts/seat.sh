#!/usr/bin/env bash
# 固定 seat worktree の取り方・戻し方。seat（../<repo>-paneB-N）の中で実行する。
#   scripts/seat.sh status           全 seat の branch と差分の数を一覧
#   scripts/seat.sh start <topic>    origin/main から paneB-N/<topic> を切る（seat が空いているときだけ）
#   scripts/seat.sh release          PR の merge 後に detached の origin/main へ戻す（差分が無いときだけ）
set -euo pipefail
here=$(git rev-parse --show-toplevel)
seat=$(basename "$here")
base=${seat%-paneB-*}
n=${seat##*-paneB-}
case "${1:-status}" in
  status)
    for d in "$(dirname "$here")/$base"-paneB-*; do
      [ -d "$d" ] || continue
      b=$(git -C "$d" branch --show-current); c=$(git -C "$d" status --porcelain | wc -l | tr -d " ")
      printf "%-24s %-44s 差分 %s\n" "$(basename "$d")" "${b:-(空き: detached origin/main)}" "$c"
    done ;;
  start)
    topic=${2:?usage: scripts/seat.sh start <topic>}
    [ "$seat" != "$base" ] || { echo "seat（../$base-paneB-N）の中で実行してください"; exit 1; }
    [ -z "$(git status --porcelain)" ] || { echo "この seat に差分があります。先に片づけてください"; exit 1; }
    [ -z "$(git branch --show-current)" ] || { echo "この seat は $(git branch --show-current) を使用中です。別の seat を使うか release してください"; exit 1; }
    git fetch origin --quiet
    git switch -c "paneB-$n/$topic" origin/main
    echo "paneB-$n/$topic を origin/main から切りました" ;;
  release)
    [ -z "$(git status --porcelain)" ] || { echo "差分があります。commit か破棄の後に release してください"; exit 1; }
    git fetch origin --quiet
    git switch --detach origin/main
    echo "origin/main（detached）に戻しました。branch はそのまま残ります" ;;
  *) echo "usage: scripts/seat.sh status | start <topic> | release"; exit 1 ;;
esac
