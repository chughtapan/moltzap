#!/usr/bin/env sh

set -eu

dir=".repos/effect"
url="https://github.com/Effect-TS/effect.git"
tag="effect@3.22.0"
expected="e670e0f6befb959b84208d5f77631276521020ae"

if [ -e "$dir" ]; then
  actual=$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)
  if [ "$actual" != "$expected" ]; then
    echo "Expected Effect $tag at $expected; found ${actual:-an invalid checkout} in $dir." >&2
    exit 1
  fi
  exit 0
fi

mkdir -p ".repos"
git clone --depth 1 --branch "$tag" --single-branch -- "$url" "$dir"

actual=$(git -C "$dir" rev-parse HEAD)
if [ "$actual" != "$expected" ]; then
  echo "Effect $tag resolved to unexpected commit $actual." >&2
  exit 1
fi
