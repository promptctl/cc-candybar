<script lang="ts">
  // A captured statusline, replayed into a real terminal. The bytes are exactly what the project
  // printed in the sandbox, so what xterm draws is what Claude Code would have drawn. The script
  // was run through a 120-second conversation at three terminal widths; the frame shows the widest
  // capture whose columns fit it, and plays the conversation off the shared clock.
  import { Terminal } from '@xterm/xterm';
  import { Unicode11Addon } from '@xterm/addon-unicode11';
  import '@xterm/xterm/css/xterm.css';
  import { untrack } from 'svelte';
  import { clock, TICK_MS } from './clock.svelte';

  import type { Bars } from './types';
  let { bars }: { bars: Bars } = $props();
  let host: HTMLDivElement;
  let frame: HTMLDivElement;
  const widths = $derived(Object.keys(bars).map(Number).sort((a, b) => a - b));

  const MAX_ROWS = 12;
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
    let alive = true;
    let shown: [number, string] | null = null;
    const draw = () => {
      const cell = (host.querySelector('.xterm-screen') as HTMLElement).offsetWidth / term.cols;
      const cols = Math.floor(frame.clientWidth / cell);
      const w = widths.filter((x) => x <= cols).pop() ?? widths[0];
      const f = frameAt(bars[w], Math.floor(clock.now() / TICK_MS));
      if (w === width && f === shown) return;
      width = w;
      shown = f;
      // The terminal lays the frame out (wide glyphs, wrapping, every escape) and its buffer says how
      // many rows that took; counting characters here would be a second, wrong layout.
      // [LAW:one-source-of-truth] The trailing newline is dropped so the cursor stays on the last
      // drawn row and shrinking to fit trims only blank rows below it.
      // Hidden while it is laid out at full height, so the strip never flashes twelve rows tall.
      host.style.visibility = 'hidden';
      term.reset();
      term.resize(w, MAX_ROWS);
      term.write(f[1].replace(/\n+$/, ''), () => {
        // a later frame, or the bar's removal, has overtaken this write
        if (!alive || f !== shown) return;
        const buf = term.buffer.active;
        let last = 0;
        for (let y = 0; y < MAX_ROWS; y++) if (buf.getLine(y)?.translateToString(true).trim()) last = y;
        term.resize(w, last + 1);
        host.style.visibility = '';
      });
    };
    // The clock is read by every draw, on the timer; the terminal is built once, not once per speed.
    untrack(draw);
    const timer = setInterval(draw, 250);
    const ro = new ResizeObserver(draw);
    ro.observe(frame);
    return () => { alive = false; clearInterval(timer); ro.disconnect(); term.dispose(); };
  });
</script>

<div class="bar" bind:this={frame}>
  <div bind:this={host}></div>
</div>

<style>
  .bar { background: #0c0e12; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; overflow: hidden; }
</style>
