<script lang="ts">
  // A captured statusline, replayed into a real terminal. The bytes are exactly what the project
  // printed in the sandbox, so what xterm draws is what Claude Code would have drawn. The script
  // was run through a 120-second conversation at three terminal widths; the frame shows the widest
  // capture whose columns fit it, and plays the conversation off the shared clock.
  import { Terminal } from '@xterm/xterm';
  import { Unicode11Addon } from '@xterm/addon-unicode11';
  import '@xterm/xterm/css/xterm.css';
  import { clock, TICK_MS } from './clock.svelte';

  import type { Bars } from './types';
  let { bars }: { bars: Bars } = $props();
  let host: HTMLDivElement;
  let frame: HTMLDivElement;
  const widths = $derived(Object.keys(bars).map(Number).sort((a, b) => a - b));

  const plain = (s: string) => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
  const rowsOf = (out: string, cols: number) => out.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil([...l].length / cols)), 0);
  // the frame in force at a tick: the last change point at or before it
  const frameAt = (frames: [number, string][], tick: number) => frames.reduce((f, c) => (c[0] <= tick ? c : f), frames[0]);

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
    let width = 0;
    let shown: [number, string] | null = null;
    const draw = () => {
      const cell = (host.querySelector('.xterm-screen') as HTMLElement).offsetWidth / term.cols;
      const cols = Math.floor(frame.clientWidth / cell);
      const w = widths.filter((x) => x <= cols).pop() ?? widths[0];
      const f = frameAt(bars[w], Math.floor(clock.now() / TICK_MS));
      if (w === width && f === shown) return;
      width = w;
      shown = f;
      term.reset();
      term.resize(w, Math.min(12, rowsOf(plain(f[1]), w)));
      term.write(f[1]);
    };
    draw();
    const timer = setInterval(draw, 250);
    const ro = new ResizeObserver(draw);
    ro.observe(frame);
    return () => { clearInterval(timer); ro.disconnect(); term.dispose(); };
  });
</script>

<div class="bar" bind:this={frame}>
  <div bind:this={host}></div>
</div>

<style>
  .bar { background: #0c0e12; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; overflow: hidden; }
</style>
