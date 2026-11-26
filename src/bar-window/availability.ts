import type { Message } from "./presentation.js";

export interface Client {
  readonly tty: string;
  readonly pid: number;
}
export const clientKey = ({ pid, tty }: Client): string => `${pid}:${tty}`;

export type Availability = Client & {
  readonly kind: "availability";
} & (
    | { readonly state: "locating" }
    | { readonly state: "hidden" | "unavailable"; readonly reason: string }
    | {
        readonly state: "visible";
        readonly columns: number;
        readonly rows: number;
      }
    | { readonly state: "visible"; readonly reason: string }
  );

export function readAvailability(event: Message): Availability {
  const { tty, pid, state, reason, columns, rows } = event;
  if (
    typeof tty === "string" &&
    tty.startsWith("/dev/") &&
    typeof pid === "number" &&
    Number.isSafeInteger(pid) &&
    pid > 1
  ) {
    const client = { kind: "availability" as const, pid, tty };
    if (state === "locating") return { ...client, state };
    if (
      state === "visible" &&
      typeof columns === "number" &&
      Number.isSafeInteger(columns) &&
      columns > 0 &&
      typeof rows === "number" &&
      Number.isSafeInteger(rows) &&
      rows > 0
    )
      return { ...client, state, columns, rows };
    if (typeof reason === "string" && reason.length > 0) {
      if (state === "visible" && columns === undefined && rows === undefined)
        return { ...client, state, reason };
      if (state === "hidden" || state === "unavailable")
        return { ...client, state, reason };
    }
  }
  throw new Error("Invalid native terminal availability");
}
