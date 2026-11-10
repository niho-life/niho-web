#!/usr/bin/env bash
# 固定 seat worktree を再利用する。topic branch の ref は削除せず残す。
set -euo pipefail

top="$(git rev-parse --show-toplevel)"
top_name="$(basename "$top")"
if [[ "$top_name" =~ ^niho-web-paneB-[0-9]+$ ]]; then
  repo_root="$(dirname "$top")/niho-web"
  seat_number="${top_name##*-paneB-}"
else
  repo_root="$top"
  seat_number=""
fi
repo_root="$(cd "$repo_root" && pwd)"
seat_count=3

dirty_count() {
  git -C "$1" status --porcelain | wc -l | tr -d ' '
}

branch_name() {
  git -C "$1" branch --show-current
}

detached_unreachable_count() {
  git -C "$1" rev-list --count HEAD --not --remotes
}

seat_path() {
  printf '%s-paneB-%s' "$repo_root" "$1"
}

require_current_seat() {
  if [[ ! "$seat_number" =~ ^[1-3]$ ]] || [[ "$top" != "$(seat_path "$seat_number")" ]]; then
    echo "start/release は既存の niho-web-paneB-1〜3 の中で実行してください。" >&2
    exit 1
  fi
}

show_status() {
  local n path branch dirty unreachable label
  for n in $(seq 1 "$seat_count"); do
    path="$(seat_path "$n")"
    if [[ ! -d "$path" ]] || ! git -C "$path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      printf 'paneB-%s  なし（新設しない）\n' "$n"
      continue
    fi
    branch="$(branch_name "$path")"
    dirty="$(dirty_count "$path")"
    unreachable=0
    if [[ -z "$branch" ]]; then
      unreachable="$(detached_unreachable_count "$path")"
    fi
    if (( dirty > 0 )); then
      label="変更あり・保護"
    elif [[ -n "$branch" ]]; then
      label="再利用可・branch保持"
    elif (( unreachable > 0 )); then
      label="要確認・branchなしcommit $unreachable 件"
    else
      label="空き"
    fi
    printf 'paneB-%s  %-23s %s\n' "$n" "$label" "${branch:-（detached）}"
  done
}

start_topic() {
  local topic="$1" branch
  require_current_seat
  [[ "$topic" =~ ^[a-z0-9][a-z0-9-]{1,59}$ ]] || {
    echo "topic は英小文字・数字・ハイフンで指定してください。" >&2
    exit 2
  }
  [[ "$(dirty_count "$top")" == "0" ]] || {
    echo "作業差分があります。内容を保護するため中断しました。" >&2
    git status -sb
    exit 1
  }
  git fetch origin --quiet
  if [[ -z "$(branch_name "$top")" ]] && (( $(detached_unreachable_count "$top") > 0 )); then
    echo "detached HEAD に remote 未到達の commit があります。branch を付けて保護してください。" >&2
    exit 1
  fi
  branch="paneB-$seat_number/$topic"
  git check-ref-format --branch "$branch" >/dev/null
  if git show-ref --verify --quiet "refs/heads/$branch" ||
     git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    echo "branch が既にあります: $branch（既存 ref は自動で上書きしません）" >&2
    exit 1
  fi
  git switch --no-track -c "$branch" origin/main
  echo "$branch を origin/main から作成しました。前の branch ref は残しています。"
}

release_seat() {
  require_current_seat
  [[ "$(dirty_count "$top")" == "0" ]] || {
    echo "作業差分があります。内容を保護するため中断しました。" >&2
    git status -sb
    exit 1
  }
  git fetch origin --quiet
  if [[ -z "$(branch_name "$top")" ]] && (( $(detached_unreachable_count "$top") > 0 )); then
    echo "detached HEAD に remote 未到達の commit があります。branch を付けて保護してください。" >&2
    exit 1
  fi
  git switch --detach origin/main
  echo "origin/main（detached）に戻しました。既存 branch ref は削除していません。"
}

case "${1:-status}" in
  status)
    [[ $# -eq 1 ]] || { echo "usage: scripts/seat.sh status" >&2; exit 2; }
    show_status
    ;;
  start)
    [[ $# -eq 2 ]] || { echo "usage: scripts/seat.sh start <topic>" >&2; exit 2; }
    start_topic "$2"
    ;;
  release)
    [[ $# -eq 1 ]] || { echo "usage: scripts/seat.sh release" >&2; exit 2; }
    release_seat
    ;;
  *)
    echo "usage: scripts/seat.sh status | start <topic> | release" >&2
    exit 2
    ;;
esac
