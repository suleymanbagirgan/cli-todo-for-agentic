#!/bin/bash
# Formats git commits and status into TODOITEM format with priority levels (smallest to largest)

PROJECT="joi-todo"

get_priority() {
    local msg="$1"

    # !!! = büyük iş (new features, architecture, sistem kurulumu)
    if [[ "$msg" =~ (Data\ layer|architecture|render|Initial|TUI|layer|terminal) ]]; then
        echo "!!!"
    # !! = orta iş (fixes, hardening, config, setup)
    elif [[ "$msg" =~ (fix|bug|harden|security|corrupt|setup) ]]; then
        echo "!!"
    # ! = küçük iş (docs, config files, testing)
    else
        echo "!"
    fi
}

tmpfile="/tmp/joi-todos-$$.tmp"
> "$tmpfile"

today=$(date +%Y-%m-%d)

# Uncommitted changes (WIP) - output directly if they exist
if git status --porcelain 2>/dev/null | grep -qE '^[^ ]'; then
    echo "0|!|TODOITEM: .gitignore: Add .claude/settings.local.json to ignore list +$PROJECT ! @${today}" >> "$tmpfile"
fi

if git status --porcelain 2>/dev/null | grep -q "^?? \.claude/"; then
    echo "0|!!|TODOITEM: .claude/ directory setup for Claude Code configuration +$PROJECT !! @${today}" >> "$tmpfile"
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
