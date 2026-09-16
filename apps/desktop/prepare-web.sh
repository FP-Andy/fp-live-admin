#!/bin/bash
# 앱 안에 담을 화면(Next standalone)을 굽는다. 포장(dist:mac/dist:win) 전에 한 번 돌린다.
#
# standalone 은 서버를 돌리는 데 꼭 필요한 것만 추린 결과라 34MB 다(node_modules 통째면 397MB).
# 다만 static·public 은 따로 붙여 줘야 한다 — Next 가 그렇게 나눠 낸다.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
WEB="$HERE/../web"
OUT="$WEB/.next-standalone-out"

cd "$WEB"
[ -d node_modules ] || npm ci
npm run build

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R .next/standalone/. "$OUT/"
cp -R .next/static "$OUT/.next/static"
cp -R public "$OUT/public"

echo "화면 준비 완료: $OUT ($(du -sh "$OUT" | cut -f1))"
