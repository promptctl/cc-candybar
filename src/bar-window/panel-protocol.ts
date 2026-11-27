// The follower and WebKit page exchange these values through the native panel.
export interface PanelFrame {
  readonly kind: "frame";
  readonly revision: number;
  readonly rows: readonly {
    readonly runs: readonly {
      readonly text: string;
      readonly fg?: string;
      readonly bg?: string;
      readonly attrs?: readonly string[];
      readonly clickable: boolean;
      readonly action?: string;
    }[];
  }[];
}

interface Cell {
  row: number;
  run: number;
}

export type PanelEvent =
  | { kind: "presented"; revision: number }
  | { kind: "hover"; revision: number; at: Cell | null }
  | {
      kind: "press";
      revision: number;
      at: Cell;
      button: number;
      ctrl: boolean;
      alt: boolean;
      shift: boolean;
    };
