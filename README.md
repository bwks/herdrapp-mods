# Herdr app mods

My personal setup for the [Herdr](https://herdr.dev) desktop app: key bindings, a layout, and the
mods (small JavaScript panels) it uses. It lives in `~/.config/herdr-app`, the folder Herdr redraws
itself from, so edits here show up in the window within a second.

Only my own files are tracked. Herdr writes or rewrites everything else in the folder (its shipped
layouts and mods, `layouts/.state/`, the `.d.ts` files), so `.gitignore` leaves those out. A new mod or
layout needs a `!` line in `.gitignore` before git will see it.

## Install on another machine

Herdr fills `~/.config/herdr-app` on its first start, so fetch into it rather than cloning:

```sh
cd ~/.config/herdr-app
git init && git remote add origin https://github.com/bwks/herdrapp-mods.git
git fetch && git checkout -f main
herdr-app do layout.switch --name my-main
```

Things that stay per machine: the theme pick (Atom One Dark) and panel sizes, which Herdr keeps in
`layouts/.state/`. The terminal font, Victor Mono, has to be installed, or Herdr falls back to
JetBrains Mono. On macOS, Ctrl+Space is the default input-source shortcut, so the key prefix may
clash there.

## Keys: `keys.json`

The bindings from my herdr TUI config (`~/.config/herdr/config.toml`), with **Ctrl+Space** as the
prefix like tmux: press Ctrl+Space, let go, then the key.

| Keys | Does |
|---|---|
| `Ctrl+Space` `c` | new tab |
| `Ctrl+Space` `1`–`9` | go to tab 1–9 |
| `Ctrl+Space` `Shift+T` / `Shift+X` | rename tab / close tab |
| `Ctrl+Space` `h` `j` `k` `l` | focus the pane left / down / up / right |
| `Ctrl+Space` `\|` / `-` | split side by side / top and bottom |
| `Ctrl+Space` `x` / `z` | close pane / zoom pane |
| `Ctrl+Space` `b` | toggle the sidebar |
| `Ctrl+Space` `w` | space picker |
| `Ctrl+Space` `g` | open or close the Changes panel |
| `Ctrl+Space` `e` | widen the Changes panel, or put it back |
| `Ctrl+Space` `t` | open or close the Backlog panel |
| `Ctrl+Space` `Ctrl+Space` | send a real Ctrl+Space to the program |
| `Alt+H` / `Alt+L` | previous / next tab |
| `Alt+K` / `Alt+J` | previous / next space |

Herdr's other default keys are kept. TUI features the app doesn't have (detach, copy mode, resize
mode, navigation mode) aren't mapped.

## Layout: `layouts/my-main.json`

A copy of Herdr's own `main` layout. Herdr restores its shipped layouts on every start, so changes
go in a copy. Mine differs in three ways:

- The side panel's **Changes** view uses `my-changes` instead of Herdr's `changes`.
- The side panel has a third view, **Backlog** (`backlog`).
- The side panel can grow up to 4000px wide (Herdr's limit is 900), so it can expand.

Because it's a copy, Herdr's later updates to `main` don't reach it. `Ctrl+Shift+L` cycles layouts,
so Herdr's own `main` is always one press away.

## Mods

### `my-changes`: Changes panel with review comments

A copy of Herdr's Changes panel (the uncommitted changes of the repo in the shown space), plus:

- **Comment on lines.** Click a diff line, shift-click or drag to select a range, and a comment box
  opens with the file and line numbers. Type a note, then either:
  - **Send comment**: types it into an agent's prompt straight away, or
  - **Add to batch**: collects it; the bar at the top shows the batch with **Send all** and **Clear**,
    and × removes one. Commented lines get an accent bar.
- **What the agent gets:** the repo, file, line numbers, the exact diff lines and your comment. It's
  typed into the agent's prompt *without* pressing Enter, so you can review it first. This goes
  through the clipboard, so sending replaces what you had copied.
- **Which agent:** the agents in the shown space; the agent button cycles between them when there
  are several, starting from the focused one.
- **Expand:** the ⇤ button in its header, or `Ctrl+Space` `e`, widens the panel to about 3/4 of the
  work area and back.
- **Look:** diff text uses the terminal's font and size; added and removed lines use the same solid
  green and red as Claude Code's diffs (`#022800`, `#3d0100`, at the top of `main.js`).
- **Limits:** drag-select works for diffs up to 800 lines; longer ones use click and shift-click.
  Dragging doesn't scroll the diff at its edges.

### `backlog`: tasks from `BACKLOG.md`

A side-panel view of the task list in the repo of the shown space:

```markdown
# Backlog

## Now
- [ ] [Fix bridge cleanup on lab delete](backlog/fix-bridge-cleanup-on-lab-delete.md)
- [x] [Unit tests for node_bridge_interfaces](backlog/unit-tests-for-node-bridge-interfaces.md)
```

- Each task is a checkbox line in `BACKLOG.md` at the repo root, linking to a details file in
  `backlog/`. `##` headings group tasks. `Title — [details](backlog/x.md)` works too.
- **Read:** click a task to see its details file as formatted Markdown.
- **Tick:** the checkbox (or **Mark done** / **Reopen**) rewrites that one line in `BACKLOG.md`.
- **Add:** **+ Task** takes a title and optional details, creates `backlog/<title>.md` and adds
  the line, creating `BACKLOG.md` if there isn't one.
- **Send to agent:** types a request to work on the task (naming its details file, and asking it to
  tick the task when finished) into an agent's prompt, without pressing Enter.
- It follows file changes, so edits by agents show up; on another machine (over ssh) it re-reads
  every 5 seconds.
- **Limits:** tasks aren't sent automatically when an agent goes idle. If an agent edits
  `BACKLOG.md` at the same moment you tick a task, one change can be lost.

### `toggle-changes` and `toggle-backlog`: panel keys

Opening a side-panel view takes two commands (show the panel, pick the view), and a key runs only
one. So each of these is a tiny mod that a key opens as an invisible popup: it shows the panel on
Changes or Backlog (or hides it if that view is already showing), then closes itself.
`Ctrl+Space` `g` and `Ctrl+Space` `t` open them.

## Changing things

- Edit a mod's `main.js` and Herdr reloads it at once. Check it before calling it done:
  `herdr-app check ~/.config/herdr-app/mods/<name>`.
- A broken `keys.json` or layout keeps the last good version and writes why to `keys.error` /
  `layout.error`.
- `herdr-app status` shows mod errors; `Ctrl+Alt+Shift+Escape` resets to Herdr's default layout and
  keys if something goes badly wrong.
