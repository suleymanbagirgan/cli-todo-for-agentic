#!/bin/bash

cd /Users/sman/Documents/10-Work/Alpsuleiman/joi-todo || exit 1

echo ""
echo "📋 Açık işler:"
echo ""

git log --oneline --reverse 2>/dev/null | sed 's/^/TODOITEM: /' | sed 's/$/ +joi-todo/'

if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "TODOITEM: WIP: Uncommitted changes in repository +joi-todo"
  git status --porcelain 2>/dev/null | while read -r line; do
    status=$(echo "$line" | cut -c1-2)
    file=$(echo "$line" | cut -c4-)
    [ -n "$file" ] && echo "TODOITEM:  $status $file +joi-todo"
  done
fi

echo ""
