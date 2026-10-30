import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, agents, run, nextCommand, exec, readTextFile, watchFolder, theme, settings } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const DRAG_ROWS = 800;
// The diff follows the terminals' font size; added/removed line colors are Claude Code's.
const DIFF_ADD = "#022800", DIFF_DEL = "#3d0100";
const diffText = () => Number(settings().font_size) || 14;
const diffRow = () => Math.round(diffText() * 1.5);
const countLines =(text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

// "lines 42–48" on the new side; removed-only selections name the old file's lines.
function lineLabel(rows) {
  const span = (ns) => ns.length ? (ns[0] === ns.at(-1) ? `line ${ns[0]}` : `lines ${ns[0]}–${ns.at(-1)}`) : null;
  const kept = rows.filter((r) => r.kind === "+" || r.kind === " ").map((r) => r.number);
  return span(kept) ?? `removed ${span(rows.filter((r) => r.kind === "-").map((r) => r.number))} (old file)`;
}

function quote(c) {
  return `\`${c.path}\` ${c.lines}:\n\`\`\`diff\n${c.snippet}\n\`\`\`\n${c.text}`;
}

// The agents a comment can go to: the shown space's, else every one.
function targets() {
  const space = spaces().find((s) => s.active), all = agents();
  const here = all.filter((a) => a.space === space?.id);
  return here.length ? here : all;
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.sel = null; this.comments = []; this.target = null; this.draft = "";
    this.commentInput = TextareaState.new({ placeholder: "Comment on the selected lines", rows: 3 });
    this.commentInput.on("change", (_e, cx) => {
      const had = Boolean(this.draft.trim());
      this.draft = this.commentInput.value();
      if (had !== Boolean(this.draft.trim())) cx.notify();
    });
    this.commentInput.on("focus", (_e, cx) => { this.commenting = true; cx.notify(); });
    this.commentInput.on("blur", (_e, cx) => { this.commenting = false; cx.notify(); });
    cx.spawn(async (cx) => {
      for (;;) {
        if (await nextCommand() === "expand") this.expand(cx);
        cx.notify();
      }
    });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false; this.sel = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    if (this.sel && (this.sel.path !== this.open || Math.max(this.sel.a, this.sel.b) >= this.rows.length)) this.sel = null;
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * diffText() * 0.62 + 80));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Click a line to select it, shift-click to extend; click a lone selected line again to clear.
  select(i, shift, cx) {
    const s = this.sel;
    if (shift && s && s.path === this.open) this.sel = { ...s, b: i };
    else if (s && s.path === this.open && s.a === i && s.b === i) this.sel = null;
    else this.sel = { path: this.open, a: i, b: i };
    cx.notify();
  }

  selectedRows() {
    if (!this.sel) return [];
    const lo = Math.min(this.sel.a, this.sel.b), hi = Math.max(this.sel.a, this.sel.b);
    return this.rows.slice(lo, hi + 1).filter((r) => r.number !== undefined);
  }

  addComment(cx) {
    const rows = this.selectedRows(), text = this.draft.trim();
    if (!rows.length || !text || !this.root) return null;
    const comment = {
      id: Date.now() + Math.random(), root: this.root, path: this.sel.path, lines: lineLabel(rows), text,
      keys: rows.map((r) => r.kind + r.number),
      snippet: rows.slice(0, 80).map((r) => (r.kind === " " ? " " : r.kind) + r.text).join("\n") + (rows.length > 80 ? "\n… (truncated)" : ""),
    };
    this.sel = null; this.draft = ""; this.commentInput.set_value(""); this.handle.focus();
    cx.notify();
    return comment;
  }

  agent() {
    const list = targets();
    return list.find((a) => a.address === this.target) ?? list.find((a) => a.focused) ?? list[0] ?? null;
  }

  // Types the message into the agent's prompt without pressing Enter, and gives it the keyboard.
  deliver(comments, cx) {
    const agent = this.agent();
    if (!agent || !comments.length) { this.note = agent ? null : "No agent to send to: start one in this space"; cx.notify(); return false; }
    const roots = [...new Set(comments.map((c) => c.root))];
    const head = comments.length === 1 ? "Review comment on my uncommitted changes" : `Review comments on my uncommitted changes (${comments.length})`;
    const body = comments.length === 1 ? quote(comments[0]) : comments.map((c, i) => `${i + 1}. ${quote(c)}`).join("\n\n");
    cx.write_to_clipboard(`${head} in ${roots.join(", ")}:\n\n${body}\n`);
    run("pane.focus", { terminal: agent.address });
    run("terminal.paste", {});
    this.note = null;
    return true;
  }

  sendOne(cx) {
    const agent = this.agent(), comment = agent && this.addComment(cx);
    if (!agent) { this.note = "No agent to send to: start one in this space"; cx.notify(); return; }
    if (comment) this.deliver([comment], cx);
  }

  sendAll(cx) {
    if (this.deliver(this.comments, cx)) this.comments = [];
    cx.notify();
  }

  // Widens the panel to 3/4 of the work area (layout node "panel"), or back to the width it had.
  expand(cx) {
    if (this.expanded) run("layout.resize", { id: "panel", px: this.restoreWidth ?? 368 });
    else { this.restoreWidth = Math.round(this.width ?? 368); run("layout.resize", { id: "panel", weight: 3 }); }
    this.expanded = !this.expanded;
    cx.notify();
  }

  // Drag extends the selection over every row the pointer enters while the button is down.
  drag(i, cx) {
    if (!this.dragging || !this.sel || this.sel.b === i || this.rows[i]?.number === undefined) return;
    this.sel = { ...this.sel, b: i };
    cx.notify();
  }

  // `handlers`: only outside a virtual list, whose rows can't hold any.
  diffRow({ kind, number, text }, i, t, marked, handlers) {
    if (kind === "@") return div().w_full().px(12).h(diffRow()).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    const lo = this.sel ? Math.min(this.sel.a, this.sel.b) : -1, hi = this.sel ? Math.max(this.sel.a, this.sel.b) : -2;
    const selected = i >= lo && i <= hi, pickable = number !== undefined;
    return h_flex().w_full().h(diffRow()).flex_none().gap(10).when(kind === "+", (e) => e.bg(DIFF_ADD)).when(kind === "-", (e) => e.bg(DIFF_DEL))
      .when(selected, (e) => e.bg(t.accent + "80"))
      .when(pickable, (e) => e.cursor_pointer())
      .when(pickable && handlers, (e) => e.id(`diff-row-${i}`)
        .on_mouse_down("left", (ev, cx) => { this.dragging = true; this.select(i, ev.modifiers.shift, cx); })
        .on_hover((hovered, cx) => { if (hovered) this.drag(i, cx); }))
      .child(div().w(3).h_full().flex_none().when(marked.has(kind + number), (e) => e.bg(t.accent)))
      .child(div().w(Math.round(diffText() * 2.6)).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  button(id, label, primary, enabled, onClick, t) {
    return div().id(id).h(28).px(12).flex().flex_none().items_center().rounded(7).text_size(12)
      .bg(enabled && primary ? t.solid : t.raised).text_color(!enabled ? t.dim : primary ? t.solid_foreground : t.foreground)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx))).child(label);
  }

  agentPicker(t) {
    const agent = this.agent(), list = targets();
    return div().id("comment-agent").h(28).px(10).flex().flex_none().items_center().gap(6).rounded(7).border_1().border_color(t.border).text_size(12).min_w(0).max_w(220)
      .text_color(agent ? t.foreground : t.dim).when(list.length > 1, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => {
        const at = list.findIndex((a) => a.address === agent?.address);
        this.target = list[(at + 1) % list.length].address; cx.notify();
      }))
      .child(div().truncate().child(agent ? `→ ${agent.program?.name ?? agent.app ?? "agent"} · ${agent.tab_name || agent.tab_index}` : "No agent"))
      .when(list.length > 1, (e) => e.child(div().text_color(t.dim).child("⇄")));
  }

  commentBox(t) {
    const rows = this.selectedRows(), ready = Boolean(this.draft.trim() && rows.length && this.root);
    return v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center().text_size(11)
        .child(div().text_color(t.muted).truncate().flex_1().min_w(0).child(rows.length ? `${this.sel.path} · ${lineLabel(rows)}` : "Select lines"))
        .child(div().text_color(t.dim).child("shift-click to extend")))
      .child(div().id("comment-text").rounded(8).border_1().border_color(this.commenting ? t.accent : t.border).px(8).py(6).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.commentInput).w_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().gap(6).items_center()
        .child(this.button("comment-cancel", "Cancel", false, true, (cx) => { this.sel = null; this.handle.focus(); cx.notify(); }, t))
        .child(div().flex_1())
        .when(!this.comments.length, (e) => e.child(this.agentPicker(t)))
        .child(this.button("comment-add", "Add to batch", false, ready, (cx) => { const c = this.addComment(cx); if (c) this.comments.push(c); }, t))
        .child(this.button("comment-send", "Send comment", true, ready && Boolean(this.agent()), (cx) => this.sendOne(cx), t)));
  }

  batchBar(t) {
    return v_flex().flex_none().border_b(1).border_color(t.border).bg(t.surface)
      .child(h_flex().h(40).px(10).gap(6).items_center()
        .child(div().text_size(12).font_semibold().child(`${this.comments.length} comment${this.comments.length === 1 ? "" : "s"}`))
        .child(div().flex_1())
        .child(this.agentPicker(t))
        .child(this.button("comments-clear", "Clear", false, true, (cx) => { this.comments = []; cx.notify(); }, t))
        .child(this.button("comments-send", "Send all", true, Boolean(this.agent()), (cx) => this.sendAll(cx), t)))
      .child(v_flex().id("comments-list").max_h(110).overflow_y_scrollbar().px(10).pb(6).gap(2).children(this.comments.map((c) =>
        h_flex().id(`comment-${c.id}`).h(22).gap(8).items_center().text_size(11)
          .child(div().flex_none().text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { if (this.open !== c.path) this.pick(c.path, cx); })
            .child(`${c.path.split("/").pop()} ${c.lines.replace(/^lines? /, "")}`))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.text))
          .child(div().id(`comment-rm-${c.id}`).flex_none().px(4).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.ansi1))
            .on_click((_e, cx) => { this.comments = this.comments.filter((x) => x.id !== c.id); cx.notify(); }).child("×")))));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const plain = this.rows.length <= DRAG_ROWS;
    const marked = new Set(this.comments.filter((c) => c.root === this.root && c.path === this.open).flatMap((c) => c.keys));
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size) => { this.width = size.width; })
      .on_key_down((e, cx) => {
        if (e.key === "escape" && (this.typing || this.commenting)) { this.typing = this.commenting = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "escape" && this.sel) { this.sel = null; cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
        .child(div().id("changes-expand").w(24).h(24).flex().items_center().justify_center().rounded(6).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.expand(cx)).child(this.expanded ? "⇥" : "⇤")))
      .when(this.comments.length > 0, (e) => e.child(this.batchBar(t)))
      .child(v_flex().id("changes-list").flex_none().h(Math.min(200, Math.max(44, this.files.length * 28 + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(diffText())
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .on_mouse_down("left", (e) => { this.shift = e.modifiers.shift; })
          .on_mouse_up("left", () => { this.dragging = false; })
          .on_hover((hovered) => { if (!hovered) this.dragging = false; })
          .child(div().w_full().min_w(this.diffWidth).h_full().child(plain
            // Up to DRAG_ROWS, a plain list so rows can take presses and hovers (drag to select).
            ? v_flex().id("changes-diff").size_full().overflow_y_scrollbar().children(this.rows.map((row, i) => this.diffRow(row, i, t, marked, true)))
            // Longer: a virtual list, whose rows can't hold handlers; it reports the clicked row, the press says if shift was held.
            : v_virtual_list("changes-diff", this.rows.length, diffRow(), (i) => String(i),
              (range) => this.rows.slice(range.start, range.end).map((row, j) => this.diffRow(row, range.start + j, t, marked, false))).size_full()
              .on_item_click((key, cx) => { if (this.rows[+key]?.number !== undefined) this.select(+key, this.shift, cx); }))))
        .when(!plain, (e) => e.child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0()))
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.sel), (e) => e.child(this.commentBox(t)))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
