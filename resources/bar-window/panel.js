"use strict";
const bar = document.querySelector("main");
const tell = message => window.webkit.messageHandlers.panel.postMessage(message);
let revision = 0;
let pointer = null;
let lastHover = null;
let cell = { height: 0, width: 0 };

// [LAW:dataflow-not-control-flow] Every frame draws at the scale that fits its
// rows into the reserved tmux pane the panel covers: a frame that fits draws at
// 1, and a taller one (an open menu in a short pane) shrinks instead of hiding.
function fit() {
  const scale = Math.min(1, window.innerHeight / (bar.children.length * cell.height));
  bar.style.lineHeight = cell.height * scale + "px";
  bar.style.fontSize = (cell.width / 0.60205) * scale + "px";
}

function hit(element) {
  const item = element?.closest("[data-run]");
  return item ? { row: Number(item.parentElement.dataset.row), run: Number(item.dataset.run) } : null;
}

function hover() {
  const at = pointer ? hit(document.elementFromPoint(pointer.x, pointer.y)) : null;
  const action = at ? bar.children[at.row].children[at.run].dataset.action || null : null;
  if (action !== lastHover) {
    lastHover = action;
    tell({ kind: "hover", revision, at });
  }
}

window.present = function(frame) {
  const rows = document.createDocumentFragment();
  for (const [y, row] of frame.rows.entries()) {
    const line = document.createElement("div");
    line.className = "row";
    line.dataset.row = y;
    for (const [x, run] of row.runs.entries()) {
      const part = document.createElement("span");
      part.textContent = run.text;
      part.dataset.run = x;
      if (run.action) part.dataset.action = run.action;
      if (run.clickable) part.setAttribute("role", "button");
      const attrs = run.attrs || [];
      part.classList.add(...attrs);
      const reverse = attrs.includes("reverse");
      part.style.color = reverse ? run.bg || "Canvas" : run.fg || "CanvasText";
      part.style.backgroundColor = reverse ? run.fg || "CanvasText" : run.bg || "transparent";
      const decoration = [];
      if (attrs.includes("underline") || attrs.includes("underline2")) decoration.push("underline");
      if (attrs.includes("strike")) decoration.push("line-through");
      if (attrs.includes("overline")) decoration.push("overline");
      part.style.textDecorationLine = decoration.join(" ");
      if (attrs.includes("underline2")) part.style.textDecorationStyle = "double";
      line.append(part);
    }
    rows.append(line);
  }
  revision = frame.revision;
  bar.replaceChildren(rows);
  fit();
  tell({ kind: "presented", revision });
  hover();
};

window.metrics = function(height, width) {
  cell = { height, width };
  fit();
};
window.addEventListener("resize", fit);
bar.addEventListener("mousemove", event => { pointer = { x: event.clientX, y: event.clientY }; hover(); });
document.documentElement.addEventListener("mouseleave", () => { pointer = null; hover(); });
bar.addEventListener("contextmenu", event => event.preventDefault());
bar.addEventListener("mousedown", event => {
  const at = hit(event.target);
  if (!at) return;
  event.preventDefault();
  tell({ kind: "press", revision, at, button: event.button, ctrl: event.ctrlKey,
         alt: event.altKey, shift: event.shiftKey });
});
