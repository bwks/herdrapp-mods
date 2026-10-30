# Working on this setup

These are the rules for this repo (https://github.com/bwks/herdrapp-mods), my personal Herdr app
setup. `../AGENTS.md` is Herdr's own manual for this folder. Herdr rewrites it on every start, so
it can't hold anything of ours, and this file sits here instead. Read both: that file explains how
Herdr works, and this one covers what is mine and how I want it changed. `../README.md` describes
each key, layout and mod for people.

## What's mine

Only these are tracked (see `../.gitignore`, a whitelist):

| Path | What it is |
|---|---|
| `keys.json` | my bindings, with Ctrl+Space as a prefix, from my herdr TUI config |
| `settings.json` | font (Victor Mono), size, theme |
| `layouts/my-main.json` | a clone of Herdr's `main`; the layout I use |
| `mods/my-changes/` | a clone of Herdr's `changes`, plus line comments sent to agents and expand |
| `mods/backlog/` | a panel showing `BACKLOG.md` and `backlog/*.md` from the shown space's repo |
| `mods/toggle-changes/`, `mods/toggle-backlog/` | invisible popups that keys open to toggle a side-panel view |

Everything else in this folder belongs to Herdr: shipped mods and layouts, `.d.ts`, `frame/`,
`layouts/.state/`, `shared.json` and so on. **Don't edit them.** Herdr replaces shipped ones on
start. To change one, clone it (`mod.clone` / `layout.clone`) and point `my-main.json` at the clone.

A new mod or layout won't reach git until you add a `!` line for it to `../.gitignore`, next to
the existing ones.

## Every change

1. Edit, then check:
   - Mods: run `herdr-app check <mod folder>`, which must pass. Then `herdr-app status` shows
     errors from the running copy.
   - `keys.json` / layout: look for `keys.error` / `layouts/*.error` / `layout.error`. No file
     means it's fine.
2. Look at it: `herdr-app shot <scratch path>.png` captures the window. A check passing doesn't
   prove that it lays out right or that later async states work.
3. Keep `../README.md` in step: the key table, the layout's differences from `main`, and each mod's
   features and limits.
4. Commit with a short message saying why. **Push only when I ask.**

## Windows and PowerShell

- This machine runs Windows 11. PowerShell 5.1 strips the inner quotes of JSON arguments, so
  `herdr-app do x '{"a":1}'` breaks. Use flags (`herdr-app do mod.clone --name changes --as x`), or
  run it from Git Bash.
- Paths in mods: use `home()` / `appHome()`. Never hardcode `C:\Users\...` or `/home/...`.
- Spaces can be on another machine (`ubnt01-ts`, over ssh). Code in a mod has to work for both
  local and remote spaces.

## Mod rules learned the hard way

- **Virtual lists:** you can't register handlers inside a `v_virtual_list` item renderer (it throws
  `on_click cannot be registered from a virtual list's item render`). Use the list's
  `on_item_click(key, cx)`, and get modifiers from the container's `on_mouse_down`. `my-changes`
  uses a plain `v_flex` with per-row handlers up to `DRAG_ROWS` (800) rows, and the virtual list
  above that.
- **Typing into an agent:** `hc send` always presses Enter. To leave text in an agent's prompt for
  me to review, write it to the clipboard, then `run("pane.focus", {terminal})`, then
  `run("terminal.paste", {})`. This replaces my clipboard. Say so in the README if a new feature
  does it.
- **Agent targets:** offer the agents in the active space (`agents()` filtered by space). Start from
  the focused one, and let a button cycle through them.
- **Remote files:** `readTextFile(path, {on})` works anywhere. `writeTextFile` and `watchFolder` work
  locally only. To write on a remote machine, run
  `exec("sh", ["-c", 'mkdir -p "$(dirname "$2")" && printf "%s" "$1" > "$2"', "sh", text, path], {on})`.
  For remote spaces, poll about every 5s instead of watching.
- **Repo root:** use `git rev-parse --show-toplevel` run in the space's folder (with `on`), falling
  back to the folder.
- **Two commands on one key:** a key runs one command. Make a tiny mod (`place: "none"`, popup
  overlay 1×1, `frame: "none"`) that does the work in `init` and then calls
  `closeOverlay(props().overlay)`. `toggle-changes` is the example.
- **Mod commands from keys:** `"<mod>.<command>"` reaches `nextCommand()` only in a *shown* copy.
- **Sizes:** diff text follows `settings().font_size`; derive row heights and column widths from it
  rather than hardcoding px.
- No `setTimeout`, no stored `cx`, no top-level side effects on `globalThis` (see `../AGENTS.md`).

## Keys

- The prefix is `ctrl-space`. Sequences are written `"ctrl-space x"`. `ctrl-space ctrl-space` sends
  a real Ctrl+Space (`send:\u0000`).
- Keep Herdr's other default bindings unless I ask otherwise. Never take the ctrl+letters that
  shells and editors rely on (see `../AGENTS.md`) unless I ask.
- `keys.json.bak-before-tui` is the untracked backup of Herdr's defaults.

## The backlog format

`backlog` reads `BACKLOG.md` at a repo's root:

```markdown
## Now
- [ ] [Title](backlog/slug.md)
- [x] [Done thing](backlog/done-thing.md)
```

`##` headings group tasks. `Title — [details](backlog/x.md)` also parses. The panel rewrites only
the one line it ticks. Keep the parser in step if the format changes, and test it with node on
sample text before trying it in the app.
