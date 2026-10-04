// [LAW:one-source-of-truth] The K/M token-scale rule, as template text whose
// dot is the count. The bundled default declares it as the `formatTokenCount`
// helper, which a config may override by name; a control instanced into
// synthesized chrome inlines this text under a `with` instead, so it needs no
// helper from the config it lands in.
export const FORMAT_TOKEN_COUNT =
  '{{ if ge . 1000000 }}{{ printf "%.1f" (divf . 1000000) }}M' +
  '{{ else if ge . 1000 }}{{ printf "%.1f" (divf . 1000) }}K' +
  "{{ else }}{{ . }}{{ end }}";
