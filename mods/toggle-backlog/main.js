// Opened by a key (mod.open:toggle-backlog): shows the Backlog panel, or hides it when it's
// already showing, the way the tab bar's Changes button does, then closes itself.
import { View, div } from "gpui-kit";
import { run, layout, props, closeOverlay } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class ToggleBacklog extends View {
  init(_props, cx) {
    cx.spawn(async () => {
      const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
      if (panel && body) {
        if (!panel.hidden && body.active === "backlog") run("layout.hide", { id: "panel" });
        else { run("layout.select", { stack: "panel-body", child: "backlog" }); run("layout.show", { id: "panel" }); }
      }
      const overlay = props()?.overlay;
      if (overlay) closeOverlay(overlay);
    });
  }

  render() {
    return div();
  }
}
