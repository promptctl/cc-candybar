<script lang="ts">
  // A captured statusline, replayed into a real terminal. The bytes are exactly what the project
  // printed in the sandbox, so what xterm draws is what Claude Code would have drawn. The script
  // was run once per terminal width; the frame shows the widest capture whose columns fit it,
  // which is the reflow a live terminal would get by re-running the script.
  import { Terminal } from '@xterm/xterm';
  import { Unicode11Addon } from '@xterm/addon-unicode11';
  import '@xterm/xterm/css/xterm.css';

  let { bars }: { bars: Record<string, string> } = $props();
  let host: HTMLDivElement;
  let frame: HTMLDivElement;
  const widths = $derived(Object.keys(bars).map(Number).sort((a, b) => a - b));

  const plain = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
  const rowsOf = (out: string, cols: number) => out.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil([...l].length / cols)), 0);

  $effect(() => {
    const term = new Terminal({
      cols: widths[0], rows: 1, convertEol: true, disableStdin: true, cursorInactiveStyle: 'none', cursorStyle: 'bar',
      allowProposedApi: true, fontSize: 13, fontFamily: '"Rich Powerline", "JetBrainsMono Nerd Font", "Symbols Nerd Font Mono", "SF Mono", Menlo, monospace',
      theme: { background: '#0c0e12', foreground: '#d5d8e6' },
      scrollback: 0,
    });
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(host);
    let shown = 0;
    const fit = () => {
      const cell = (host.querySelector('.xterm-screen') as HTMLElement).offsetWidth / term.cols;
      const cols = Math.floor(frame.clientWidth / cell);
      const w = widths.filter((x) => x <= cols).pop() ?? widths[0];
      if (w === shown) return;
      shown = w;
      term.reset();
      term.resize(w, Math.min(12, rowsOf(plain(bars[w]), w)));
      term.write(bars[w]);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(frame);
    return () => { ro.disconnect(); term.dispose(); };
  });
</script>

<div class="bar" bind:this={frame}>
  <div bind:this={host}></div>
</div>

<style>
  .bar { background: #0c0e12; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; overflow: hidden; }
</style>
