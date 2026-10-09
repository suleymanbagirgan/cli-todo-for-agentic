#!/bin/bash
# Auto-list all work: uncommitted changes + commits, priority-sorted

PROJECT="joi-todo"
today=$(date +%Y-%m-%d)
tmpfile=$(mktemp)

get_priority() {
    local msg="$1"
    if [[ "$msg" =~ (feat|feature|Data|layer|architecture|render|Initial|TUI|terminal) ]]; then
        echo "3"  # !!! = priority 3
    elif [[ "$msg" =~ (fix|bug|harden|security|corrupt|refactor|Refactor|setup|enhancement|chore|improve|enhance) ]]; then
        echo "2"  # !! = priority 2
    else
        echo "1"  # ! = priority 1
    fi
}

priority_badge() {
    case "$1" in
        3) echo "!!!" ;;
        2) echo "!!" ;;
        *) echo "!" ;;
    esac
}

# Collect all items with priority prefix for sorting
{
    # 1. Staged changes (highest priority for uncommitted work)
    git diff --cached --name-only 2>/dev/null | while read -r file; do
        [[ -n "$file" ]] && echo "3|TODOITEM:  S  $file +$PROJECT !!!"
    done

    # 2. Modified files (medium priority for uncommitted work)
    git diff --name-only 2>/dev/null | while read -r file; do
        [[ -n "$file" ]] && echo "2|TODOITEM:  M  $file +$PROJECT !!"
    done

    # 3. Untracked (medium-low priority)
    git ls-files --others --exclude-standard 2>/dev/null | while read -r file; do
        [[ -n "$file" ]] && echo "2|TODOITEM:  ?? $file +$PROJECT !!"
    done

    # 4. Commits (sorted by priority from msg)
    git log --reverse --format="%h|%ai|%s" 2>/dev/null | while IFS='|' read -r hash date_time msg; do
        [[ -z "$hash" ]] && continue
        date=$(echo "$date_time" | cut -d' ' -f1)
        priority=$(get_priority "$msg")
        badge=$(priority_badge "$priority")
        files=$(git show --name-only --pretty="" "$hash" 2>/dev/null | wc -l)
        echo "${priority}|TODOITEM: $msg +$PROJECT ${badge} @${date} ($files changed)"
    done
} | sort -rn -t'|' -k1 | cut -d'|' -f2- > "$tmpfile"

output=$(cat "$tmpfile")

# Print to stdout (for hook capture in system-reminder)
echo "$output"

# Also persist to .todos.md for persistent reference
{
    echo "# joi-todo İş Listesi — $(date '+%Y-%m-%d %H:%M')"
    echo ""
    echo "$output"
} > .claude/.todos.md

rm -f "$tmpfile"
