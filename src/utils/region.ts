// [LAW:effects-at-boundaries] The host's resolved presentation settings are
// data. They can travel between workers without exporting the environment.
export interface RegionalSettings {
  readonly locale: string;
  readonly timeZone: string;
}

export function systemRegion(): RegionalSettings {
  return {
    locale: new Intl.NumberFormat().resolvedOptions().locale,
    timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
