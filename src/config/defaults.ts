import type { PowerlineConfig } from "../types/config";

export const DEFAULT_CONFIG: PowerlineConfig = {
  theme: "dark",
  display: {
    style: "minimal",
    lines: [
      {
        segments: {
          directory: { enabled: true },
          git: {
            enabled: true,
            showSha: false,
          },
          model: { enabled: true },
          session: { enabled: true, type: "tokens" },
          today: { enabled: true, type: "both" },
          block: { enabled: false, type: "cost" },
          tmux: { enabled: false },
        },
      },
    ],
  },
  budget: {
    session: {
      warningThreshold: 80,
    },
    today: {
      amount: 50,
      warningThreshold: 80,
    },
  },
};
