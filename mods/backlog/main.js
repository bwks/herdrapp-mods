// The repo's BACKLOG.md as a task list: `- [ ] [Title](backlog/slug.md)` lines, grouped by `##`
// headings. Pick a task to read its details file; tick it done, add tasks, or hand one to an agent.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { spaces, panes, focused, agents, run, exec, readTextFile, writeTextFile, watchFolder, theme, settings, shared, setShared, window } from "herdr";

const FILE = "BACKLOG.md", FOLDER = "backlog";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

// Tasks and headings, each with the line it came from so a tick rewrites only that line.
function parse(text) {
  const items = [];
  text.split("\n").forEach((line, index) => {
    const heading = /^#{2,6}\s+(.*)$/.exec(line);
    if (heading) { items.push({ heading: heading[1].trim(), index }); return; }
    const task = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (!task) return;
    const link = /\[([^\]]*)\]\(([^)\s]+)\)/.exec(task[2]);
    // `[Title](file)` names the task; `Title — [details](file)` only points at the file.
    const rest = link ? task[2].replace(link[0], "").replace(/\s*[—–:-]\s*$/, "").trim() : task[2].trim();
    const title = link && !rest ? link[1].trim() : rest;
    items.push({ index, done: task[1] !== " ", title: title || "(untitled)", file: link?.[2] ?? null });
  });
  return items;
}

const slugify = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "task";

// The agents a task can go to: the shown space's, else every one.
function targets() {
  const space = spaces().find((s) => s.active), all = agents();
  const here = all.filter((a) => a.space === space?.id);
  return here.length ? here : all;
}

export default class Backlog extends View {
  init(_props, cx) {
    this.items = []; this.text = null; this.selected = null; this.detail = null; this.target = null;
    this.handle = cx.focus_handle();
    this.titleInput = InputState.new({ placeholder: "Task title" });
    this.detailInput = TextareaState.new({ placeholder: "Details (optional, markdown)", rows: 5 });
    this.titleInput.on("change", (_e, cx) => { const had = Boolean(this.draftTitle?.trim()); this.draftTitle = this.titleInput.value(); if (had !== Boolean(this.draftTitle.trim())) cx.notify(); });
    // Herdr's tab bar remembers the side panel per space only for panels it knows.
    const panels = shared("workspace.panels") ?? ["files", "changes"];
    if (Array.isArray(panels) && !panels.includes("backlog")) setShared("workspace.panels", [...panels, "backlog"]);
    this.refresh(cx);
    cx.timer.every(5000, (cx) => { if (this.on) this.refresh(cx); });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try { while (this.watched === root) { await watchFolder(root); if (this.watched === root) this.refresh(cx); } }
      catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.items = []; this.text = null; this.selected = null; this.detail = null;
      this.error = null; this.note = null; this.watched = null; this.adding = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        const root = top.code === 0 ? top.stdout.trim() : cwd;
        const text = await readTextFile(`${root}/${FILE}`, { on }).catch(() => null);
        if (key() !== context) return;
        this.root = root; this.on = on; this.text = text; this.items = text === null ? [] : parse(text); this.error = null;
        this.watch(root, cx);
        if (this.selected) await this.loadDetail(context);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  task() {
    return this.items.find((i) => !i.heading && i.file === this.selected?.file && i.title === this.selected?.title)
      ?? this.items.find((i) => !i.heading && i.index === this.selected?.index) ?? null;
  }

  async loadDetail(context) {
    const task = this.task();
    if (!task?.file) { this.detail = null; return; }
    const text = await readTextFile(`${this.root}/${task.file}`, { on: this.on }).catch(() => null);
    if (key() === context) this.detail = text;
  }

  pick(task, cx) {
    this.adding = false; this.note = null;
    this.selected = this.selected?.index === task.index ? null : { index: task.index, file: task.file, title: task.title };
    this.detail = undefined;
    const context = this.context;
    if (this.selected) cx.spawn(async (cx) => { await this.loadDetail(context); cx.notify(); });
    cx.notify();
  }

  // Writes a file in the repo, here or on the space's machine, making its folder first.
  async write(path, text, expected) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (this.on) {
      const r = await exec("sh", ["-c", 'mkdir -p "$(dirname "$2")" && printf "%s" "$1" > "$2"', "sh", text, path], { on: this.on });
      if (r.code !== 0) throw new Error(r.stderr.trim() || "write failed");
      return;
    }
    const mk = window()?.platform === "windows" ? exec("cmd", ["/d", "/c", "if not exist \"" + dir.replace(/\//g, "\\") + "\" mkdir \"" + dir.replace(/\//g, "\\") + "\""]) : exec("mkdir", ["-p", dir]);
    await mk.catch(() => null);
    await writeTextFile(path, text, expected);
  }

  // Re-reads BACKLOG.md, applies `change` to its lines, and writes it back.
  edit(change, cx, after) {
    if (!this.root || this.busy) return;
    const root = this.root, on = this.on, context = this.context;
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const current = await readTextFile(`${root}/${FILE}`, { on }).catch(() => null);
        const next = change(current);
        if (next !== null && next !== current) await this.write(`${root}/${FILE}`, next, current);
        if (after) await after();
      } catch (e) { if (key() === context) this.note = `Couldn't save: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  toggle(task, cx) {
    this.edit((text) => {
      if (text === null) return null;
      const lines = text.split("\n"), line = lines[task.index] ?? "";
      if (!/\[( |x|X)\]/.test(line)) return null;
      lines[task.index] = line.replace(/\[( |x|X)\]/, task.done ? "[ ]" : "[x]");
      return lines.join("\n");
    }, cx);
  }

  add(cx) {
    const title = (this.titleInput.value() ?? "").trim(), details = (this.detailInput.value() ?? "").trim();
    if (!title || !this.root) return;
    const taken = new Set(this.items.map((i) => i.file));
    let slug = slugify(title), n = 2;
    while (taken.has(`${FOLDER}/${slug}.md`)) slug = `${slugify(title)}-${n++}`;
    const file = `${FOLDER}/${slug}.md`, root = this.root;
    this.edit((text) => {
      const line = `- [ ] [${title.replace(/[\[\]]/g, "")}](${file})`;
      if (text === null) return `# Backlog\n\n${line}\n`;
      return text.replace(/\n*$/, "\n") + line + "\n";
    }, cx, () => this.write(`${root}/${file}`, `# ${title}\n\n${details || "_No details yet._"}\n`, null));
    this.adding = false; this.draftTitle = ""; this.titleInput.set_value(""); this.detailInput.set_value("");
    this.selected = { index: -1, file, title };
  }

  createDetails(task, cx) {
    const root = this.root, file = `${FOLDER}/${slugify(task.title)}.md`;
    this.edit((text) => {
      if (text === null) return null;
      const lines = text.split("\n");
      lines[task.index] = lines[task.index].replace(/\]\s+.*$/, `] [${task.title.replace(/[\[\]]/g, "")}](${file})`);
      return lines.join("\n");
    }, cx, () => this.write(`${root}/${file}`, `# ${task.title}\n\n_No details yet._\n`, null));
    this.selected = { index: task.index, file, title: task.title };
  }

  agent() {
    const list = targets();
    return list.find((a) => a.address === this.target) ?? list.find((a) => a.focused) ?? list[0] ?? null;
  }

  // Types the request into the agent's prompt without pressing Enter, and gives it the keyboard.
  send(task, cx) {
    const agent = this.agent();
    if (!agent) { this.note = "No agent to send to: start one in this space"; cx.notify(); return; }
    const where = task.file ? ` Its details are in \`${task.file}\`.` : "";
    cx.write_to_clipboard(`Please work on this task from ${FILE} in ${this.root}: "${task.title}".${where} When it's finished, tick it in ${FILE}.\n`);
    run("pane.focus", { terminal: agent.address });
    run("terminal.paste", {});
  }

  button(id, label, primary, enabled, onClick, t) {
    return div().id(id).h(28).px(12).flex().flex_none().items_center().rounded(7).text_size(12)
      .bg(enabled && primary ? t.solid : t.raised).text_color(!enabled ? t.dim : primary ? t.solid_foreground : t.foreground)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx))).child(label);
  }

  agentPicker(t) {
    const agent = this.agent(), list = targets();
    return div().id("backlog-agent").h(28).px(10).flex().flex_none().items_center().gap(6).rounded(7).border_1().border_color(t.border).text_size(12).min_w(0).max_w(220)
      .text_color(agent ? t.foreground : t.dim).when(list.length > 1, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => {
        const at = list.findIndex((a) => a.address === agent?.address);
        this.target = list[(at + 1) % list.length].address; cx.notify();
      }))
      .child(div().truncate().child(agent ? `→ ${agent.program?.name ?? agent.app ?? "agent"} · ${agent.tab_name || agent.tab_index}` : "No agent"))
      .when(list.length > 1, (e) => e.child(div().text_color(t.dim).child("⇄")));
  }

  row(task, t) {
    const on = this.selected && task.index === this.task()?.index;
    return h_flex().id(`task-${task.index}`).min_h(30).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(task, cx))
      .child(div().id(`tick-${task.index}`).w(16).h(16).flex_none().flex().items_center().justify_center().rounded(4).border_1()
        .border_color(task.done ? t.accent : t.input).bg(task.done ? t.accent : t.background).text_size(11).text_color(t.accent_foreground)
        .hover((s) => s.border_color(t.accent))
        .on_click((_e, cx) => { cx.stop_propagation(); this.toggle(task, cx); }).child(task.done ? "✓" : ""))
      .child(div().flex_1().min_w(0).truncate().text_color(task.done ? t.dim : t.foreground).when(task.done, (e) => e.line_through()).child(task.title))
      .when(!task.file, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child("no details")));
  }

  detailPane(t) {
    const task = this.task();
    if (!task) return div().flex_1().p(14).text_color(t.dim).child(this.busy ? "Saving…" : "Task not found");
    return v_flex().flex_1().min_h(0).border_t(1).border_color(t.border)
      .child(h_flex().flex_none().px(14).py(10).gap(8).items_center()
        .child(v_flex().flex_1().min_w(0)
          .child(div().font_semibold().truncate().child(task.title))
          .child(div().text_size(11).text_color(t.dim).truncate().child(task.file ?? "No details file")))
        .child(div().id("detail-close").w(24).h(24).flex().flex_none().items_center().justify_center().rounded(6).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.selected = null; cx.notify(); }).child("×")))
      .child(div().id("detail-body").flex_1().min_h(0).overflow_y_scrollbar().px(14).pb(10).text_size(13)
        .child(this.detail === undefined ? div().text_color(t.dim).child("Loading…")
          : this.detail === null ? div().text_color(t.dim).child(task.file ? `Can't read ${task.file}` : "This task has no details file yet.")
          : TextView.markdown(`detail-${task.file}`, this.detail).selectable(true)))
      .child(h_flex().flex_none().p(10).gap(6).items_center().border_t(1).border_color(t.border)
        .child(this.button("detail-done", task.done ? "Reopen" : "Mark done", false, !this.busy, (cx) => this.toggle(task, cx), t))
        .when(!task.file, (e) => e.child(this.button("detail-create", "Add details file", false, !this.busy, (cx) => this.createDetails(task, cx), t)))
        .child(div().flex_1())
        .child(this.agentPicker(t))
        .child(this.button("detail-send", "Send to agent", true, Boolean(this.agent()), (cx) => this.send(task, cx), t)));
  }

  addForm(t) {
    const ready = Boolean(this.draftTitle?.trim()) && !this.busy;
    return v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border).bg(t.surface)
      .child(div().text_size(11).text_color(t.muted).child(`New task · ${FILE} and ${FOLDER}/`))
      .child(div().id("task-title").h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.titleInput).h_full().w_full().text_size(12).text_color(t.foreground)))
      .child(div().id("task-details").rounded(8).border_1().border_color(t.border).px(8).py(6).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Textarea.new(this.detailInput).w_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().gap(6)
        .child(this.button("task-cancel", "Cancel", false, true, (cx) => { this.adding = false; cx.notify(); }, t))
        .child(div().flex_1())
        .child(this.button("task-add", "Add task", true, ready, (cx) => this.add(cx), t)));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), tasks = this.items.filter((i) => !i.heading), open = tasks.filter((i) => !i.done).length;
    const showDetail = Boolean(this.selected) && !this.adding;
    return v_flex().id("backlog").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape" && (this.selected || this.adding)) { this.selected = null; this.adding = false; cx.stop_propagation(); cx.notify(); } })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Backlog"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${open} open`))
        .child(div().flex_1())
        .when(Boolean(this.root), (e) => e.child(div().id("task-new").h(24).px(8).flex().items_center().rounded(6).text_size(12).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.adding = !this.adding; cx.notify(); }).child("+ Task"))))
      .child(v_flex().id("backlog-list").when(showDetail, (e) => e.flex_none().max_h(260)).when(!showDetail, (e) => e.flex_1()).min_h(0).overflow_y_scrollbar().p(6).gap(1)
        .children(this.items.map((item) => item.heading
          ? div().px(8).pt(10).pb(4).flex_none().text_size(11).font_semibold().text_color(t.muted).child(item.heading)
          : this.row(item, t)))
        .when(!tasks.length, (e) => e.child(div().p(8).text_color(t.dim).child(
          this.error ?? (this.loading && !this.root ? "Loading…" : !this.root ? "No folder" : this.text === null ? `No ${FILE} in ${this.root}. Add a task to start one.` : "No tasks yet")))))
      .when(showDetail, (e) => e.child(this.detailPane(t)))
      .when(Boolean(this.note), (e) => e.child(div().px(12).py(6).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(this.adding, (e) => e.child(this.addForm(t)));
  }
}
