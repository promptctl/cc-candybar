import type { PanelEvent, PanelFrame } from "../../src/bar-window/panel-protocol.js";

declare global {
  interface Window {
    readonly webkit: {
      readonly messageHandlers: {
        readonly panel: { postMessage(message: PanelEvent): void };
      };
    };
    present(frame: PanelFrame): void;
    metrics(height: number, width: number): void;
  }
}
