# joi todo

Fast, opinionated terminal todo for founders and builders. Written in [Ink](https://github.com/vadimdemedes/ink).

Runs fullscreen (alt-screen buffer), scrolls internally, shows a rotating daily manifesto, groups completed work by date, tracks time per task.

## Install

```bash
git clone https://github.com/suleymanbagirgan/joi-todo
cd joi-todo
npm install
npm link          # exposes the `todo` command globally
```

## Usage

```bash
todo                              # interactive TUI
todo add "ship the landing +web !! @tomorrow"
todo list [+tag]                  # grouped list
todo top [days]                   # critical items in next N days
todo done <ref>                   # toggle complete
todo start <ref>                  # start timer
todo hold                         # pause active timer
todo now                          # what's running
todo time [today|week|month]      # time report per project
todo undo                         # reverse the last action
todo stats                        # counts
todo path                         # data file locations
```

## Interactive shortcuts

| Key | Action |
|-----|--------|
| `j` / `↓` | Move cursor down |
| `k` / `↑` | Move cursor up |
| `g` / `G` | Jump to top / bottom |
| `^D` / `^U` | Move by 10 |
| `a` / `i` | Add task |
| `e` | Edit task |
| `c` / `space` | Complete / uncomplete |
| `d` / `x` | Delete |
| `s` | Start / resume timer |
| `h` | Hold active timer |
| `u` | Undo last action |
| `/` | Filter by project |
| `F` | Clear filter |
| `r` | Refresh |
| `q` / `esc` | Quit |
| `Tab` (in add/edit) | Project picker |

## Task syntax

```
text +project !! @date
```

- `+project` — assigns to a project (which maps to a category via config)
- `!` / `!!` / `!!!` — priority (low / medium / high)
- `@today` / `@tomorrow` / `@yesterday` / `@YYYY-MM-DD` — due date

## Data location

- Tasks & events live under `~/.joi-todo/`
- Optional iCloud sync: `todo sync on` symlinks the directory into your iCloud Drive

## Rotating manifestos

Each day the header shows one of 50 rotating one-liners. Deterministic — same day = same line.

Override the defaults by creating `~/.joi-todo/manifestos.js`:

```js
export const manifestos = [
  "Your own quote here.",
  "Another one.",
  // ...
];
```

## License

MIT
