// [LAW:one-source-of-truth] The K/M token-scale rule, as template text over
// the count `n` (a template expression). The bundled default declares it as
// the `formatTokenCount` helper over `.`, which a config may override by name;
// a control instanced into synthesized chrome inlines it over its own field
// instead, so it needs no helper from the config it lands in.
export const formatTokenCount = (n: string): string =>
  `{{ if ge ${n} 1000000 }}{{ printf "%.1f" (divf ${n} 1000000) }}M` +
  `{{ else if ge ${n} 1000 }}{{ printf "%.1f" (divf ${n} 1000) }}K` +
  `{{ else }}{{ ${n} }}{{ end }}`;
