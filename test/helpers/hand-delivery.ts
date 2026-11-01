import type {
  Delivery,
  DeliveryNotice,
  FileEvents,
} from "../../src/daemon/cache/file-events";

// The daemon's one owner of file-event delivery, driven by hand: what it
// reads, and the notices it sends.
export interface HandDelivery extends FileEvents {
  set(delivery: Delivery, notice: DeliveryNotice): void;
  notify(notice: DeliveryNotice): void;
  // How many subscribers it still holds.
  listening(): number;
}

export function handDelivery(): HandDelivery {
  let current: Delivery = {
    kind: "delivering",
    unreported: [],
    missedSince: null,
  };
  const listeners = new Set<(notice: DeliveryNotice) => void>();
  const notify = (notice: DeliveryNotice) => {
    for (const listener of [...listeners]) listener(notice);
  };
  return {
    delivery: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(delivery, notice) {
      current = delivery;
      notify(notice);
    },
    notify,
    listening: () => listeners.size,
  };
}
