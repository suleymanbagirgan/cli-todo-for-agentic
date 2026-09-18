#!/bin/bash
# Auto-list all work: uncommitted changes + commits with priorities

PROJECT="joi-todo"
today=$(date +%Y-%m-%d)

get_priority() {
    local msg="$1"
    if [[ "$msg" =~ (feat|feature|Data|layer|architecture|render|Initial|TUI|terminal|refactor|Refactor) ]]; then
        echo "!!!"
    elif [[ "$msg" =~ (fix|Fix|bug|harden|security|corrupt|setup|Setup|enhancement|Enhancement|chore|improve|Improve|enhance|Enhance) ]]; then
        echo "!!"
    else
        echo "!"
    fi
}

{
    # Staged changes
    git diff --cached --name-only 2>/dev/null | while read -r file; do
        [[ -n "$file" ]] && echo "TODOITEM:  S  $file +$PROJECT !! @${today}"
    done

    # Modified files
    git diff --name-only 2>/dev/null | while read -r file; do
        [[ -n "$file" ]] && echo "TODOITEM:  M  $file +$PROJECT ! @${today}"
    done

    # Untracked
    git ls-files --others --exclude-standard 2>/dev/null | while read -r file; do
        [[ -n "$file" ]] && echo "TODOITEM:  ?? $file +$PROJECT ! @${today}"
    done

    # Commits with file changes
    git log --reverse --format="%h|%ai|%s" 2>/dev/null | while IFS='|' read -r hash date_time msg; do
        [[ -z "$hash" ]] && continue
        date=$(echo "$date_time" | cut -d' ' -f1)
        priority=$(get_priority "$msg")
        files=$(git show --name-only --pretty="" "$hash" 2>/dev/null | wc -l)
        echo "TODOITEM: $msg +$PROJECT ${priority} @${date} ($files changed)"

        # Show affected files
        git show --name-status --pretty="" "$hash" 2>/dev/null | while read -r line; do
            [[ -n "$line" ]] && echo "  → $line"
        done
    done
}
