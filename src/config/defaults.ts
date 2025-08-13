import type { PowerlineConfig } from "./loader";

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
          tmux: { enabled: false },
          context: { enabled: true },
        },
      },
    ],
  },
  budget: {
    session: {
      warningThreshold: 80,
    },
  },
};
