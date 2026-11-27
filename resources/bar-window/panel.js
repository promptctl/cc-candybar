"use strict";
function barElement() {
  const main = document.querySelector("main");
  if (!main) throw new Error("Missing main element in the bar window");
  return main;
}
const bar = barElement();
/** @param {import("../../src/bar-window/panel-protocol.js").PanelEvent} message */
const tell = message => window.webkit.messageHandlers.panel.postMessage(message);
let revision = 0;
/** @type {{ x: number, y: number } | null} */
let pointer = null;
/** @type {string | null} */
let lastHover = null;

/** @param {EventTarget | null} element */
function hit(element) {
  const item = element instanceof Element ? element.closest("[data-run]") : null;
  if (!(item instanceof HTMLElement) || !item.parentElement) return null;
  return {
    at: { row: Number(item.parentElement.dataset.row), run: Number(item.dataset.run) },
    action: item.dataset.action || null,
  };
}

function hover() {
  const target = pointer ? hit(document.elementFromPoint(pointer.x, pointer.y)) : null;
  const at = target?.at ?? null;
  const action = target?.action ?? null;
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
    line.dataset.row = String(y);
    for (const [x, run] of row.runs.entries()) {
      const part = document.createElement("span");
      part.textContent = run.text;
      part.dataset.run = String(x);
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
  tell({ kind: "presented", revision });
  hover();
};

window.metrics = function(height, width) {
  bar.style.lineHeight = height + "px";
  bar.style.fontSize = (width / 0.60205) + "px";
};
bar.addEventListener("mousemove", event => { pointer = { x: event.clientX, y: event.clientY }; hover(); });
document.documentElement.addEventListener("mouseleave", () => { pointer = null; hover(); });
bar.addEventListener("contextmenu", event => event.preventDefault());
bar.addEventListener("mousedown", event => {
  const target = hit(event.target);
  if (!target) return;
  event.preventDefault();
  tell({ kind: "press", revision, at: target.at, button: event.button, ctrl: event.ctrlKey,
         alt: event.altKey, shift: event.shiftKey });
});
