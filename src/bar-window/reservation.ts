// Both selection and cleanup name the pane using tmux's own format language.

export function reservationPredicate(title: string): string {
  if (!/^cc-candybar-window-[a-zA-Z0-9-]+$/.test(title))
    throw new Error("Invalid reservation title");
  return `#{&&:#{==:#{pane_title},${title}},#{==:#{pane_start_command},''}}`;
}
