#!/bin/bash
# Formats git commits and status into TODOITEM format with priority levels (smallest to largest)

PROJECT="joi-todo"

get_priority() {
    local msg="$1"

    # !!! = büyük iş (new features, architecture, sistem kurulumu, refactor)
    if [[ "$msg" =~ (feat|feature|Data|layer|architecture|render|Initial|TUI|terminal|refactor|Refactor) ]]; then
        echo "!!!"
    # !! = orta iş (fixes, hardening, config, setup, enhancement)
    elif [[ "$msg" =~ (fix|Fix|bug|harden|security|corrupt|setup|Setup|enhancement|Enhancement|chore) ]]; then
        echo "!!"
    # ! = küçük iş (docs, README, comment updates, typo)
    else
        echo "!"
    fi
}

tmpfile="/tmp/joi-todos-$$.tmp"
> "$tmpfile"

today=$(date +%Y-%m-%d)

# Uncommitted changes (WIP) - list each file as separate item
staged_files=$(git diff --cached --name-only 2>/dev/null)
unstaged_files=$(git diff --name-only 2>/dev/null)
untracked_files=$(git ls-files --others --exclude-standard 2>/dev/null)

if [[ -n "$staged_files" ]]; then
    while read -r file; do
        [[ -z "$file" ]] && continue
        echo "0|!!|TODOITEM:  S  $file +$PROJECT !! @${today}" >> "$tmpfile"
    done <<< "$staged_files"
fi

if [[ -n "$unstaged_files" ]]; then
    while read -r file; do
        [[ -z "$file" ]] && continue
        echo "0|!|TODOITEM:  M  $file +$PROJECT ! @${today}" >> "$tmpfile"
    done <<< "$unstaged_files"
fi

if [[ -n "$untracked_files" ]]; then
    while read -r file; do
        [[ -z "$file" ]] && continue
        echo "0|!|TODOITEM:  ?? $file +$PROJECT ! @${today}" >> "$tmpfile"
    done <<< "$untracked_files"
fi

# Git commits (oldest first = reverse order of git log)
git log --reverse --format="%h|%ai|%s" 2>/dev/null | while read -r line; do
    if [[ -z "$line" ]]; then continue; fi

    hash=$(echo "$line" | cut -d'|' -f1)
    date=$(echo "$line" | cut -d'|' -f2 | cut -d' ' -f1)
    msg=$(echo "$line" | cut -d'|' -f3-)

    priority=$(get_priority "$msg")

    # Encode priority as sortable number: ! = 1, !! = 2, !!! = 3
    case "$priority" in
        "!") sortkey="1" ;;
        "!!") sortkey="2" ;;
        "!!!") sortkey="3" ;;
        *) sortkey="2" ;;
    esac

    echo "${sortkey}|${date}|TODOITEM: $msg +$PROJECT ${priority} @${date}" >> "$tmpfile"
done 2>/dev/null

# Output sorted by priority (! first, then !!, then !!!)
if [[ -f "$tmpfile" ]] && [[ -s "$tmpfile" ]]; then
    sort -t'|' -k1,1n -k2,2 "$tmpfile" | cut -d'|' -f3-
    rm -f "$tmpfile"
fi
