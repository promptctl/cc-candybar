import { expect, mock, test } from 'claude-code/testing'

const FRAME = {
  ok: true,
  band: [
    [
      { text: '🍫', color: '#181825', backgroundColor: '#b592e1', href: 'cc-candybar://dispatch/e=x' },
      { text: ' bar', color: '#181825' },
    ],
  ],
}

const BAND = {
  plugin: 'candybar-band',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 155,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
  viewport: { columns: 160, rows: 45 },
} as const

test('the band draws the session’s pushed frame, its links as Links', async ($, on) => {
  const spawned: (readonly string[])[] = []
  const logged: string[] = []
  const clock = mock.clock(on)
  // The engine beneath the mod: the session it names, and a band it draws empty.
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('ui.log', (_$, e) => (logged.push(e.text), { value: undefined }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('process.spawn', async function* (_$, e) {
    spawned.push(e.argv)
    yield { stream: 'stdout' as const, text: `${JSON.stringify(FRAME)}\n` }
    // What `follow` says before an exit 1: the reason, one line, its own name first.
    yield { stream: 'stderr' as const, text: 'cc-candybar follow: daemon speaks protocol 3\ncc-candybar follow: why it stopped\n' }
    return { value: { code: 1, signal: null } }
  })

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.advance(1)

  // The child is the native client, asked for the session alone: its data is
  // the statusline's.
  expect(spawned.map(argv => argv[0]!.endsWith('/bin/cc-candybar-native'))).toEqual([true])
  expect(spawned.map(argv => argv.slice(1))).toEqual([['follow', '--lane', 'band', '--session', 'sid-1']])
  expect(await ui.find({ type: 'Link' })).toMatchObject({
    props: { href: 'cc-candybar://dispatch/e=x' },
  })
  expect(await ui.find({ type: 'Text', text: /bar/ })).toBeDefined()
  // The child ended on its own, so the band says why above the bar, in one
  // row: its last word.
  const failure = await ui.find({ type: 'Text', text: /frames stopped/ })
  expect(failure).toMatchObject({
    text: 'candybar: frames stopped (exit 1) cc-candybar follow: why it stopped',
  })
  // Its whole stderr is in the debug log, a line an entry.
  expect(logged).toContain('cc-candybar follow: daemon speaks protocol 3')
  expect(logged.filter(line => line.startsWith('candybar-band:'))).toEqual([
    'candybar-band: frames started for sid-1',
    'candybar-band: frames for sid-1 ended (exit 1)',
  ])
  await ui.unmount()
})

// The band's lane switched off in candybar's settings is the daemon's
// SWITCHED_OFF refusal on the child's stdout, relayed as it was sent: the band
// hands the prompt area back to what is beneath it, the debug log says why,
// and the child goes on, so switching it back on brings the bar back.
test('the lane switched off hands the band back, and the next bar draws again', { timeoutMs: 15_000 }, async ($, on) => {
  const logged: string[] = []
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('ui.log', (_$, e) => (logged.push(e.text), { value: undefined }))
  // What is beneath the band: drawn only when the band hands it on.
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return <Box><Text>beneath</Text></Box>
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${JSON.stringify(FRAME)}\n` }
    await clock.sleep(250)
    yield { stream: 'stdout' as const, text: `${JSON.stringify({ ok: false, code: 'SWITCHED_OFF', error: '🧪 band (A) is off', daemonV: 3 })}\n` }
    await clock.sleep(250)
    yield { stream: 'stdout' as const, text: `${JSON.stringify(FRAME)}\n` }
    await clock.sleep(60_000)
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.advance(1)
  expect(await ui.find({ type: 'Link' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /beneath/ })).toBeUndefined()

  await clock.advance(250)
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /beneath/ })).toBeDefined()
  expect(logged).toContain('candybar-band: lane A is off for sid-1: 🧪 band (A) is off')

  await clock.advance(250)
  expect(await ui.find({ type: 'Link' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /beneath/ })).toBeUndefined()
  await ui.unmount()
})

for (const reason of ['clear', 'resume'] as const) {
  test(`a ${reason} moves the band to the new session, dropping the old one’s frame`, async ($, on) => {
    const spawned: (readonly string[])[] = []
    const logged: string[] = []
    const clock = mock.clock(on)
    let id = 'sid-1'
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
    on('session.id', () => ({ value: id }))
    on('ui.log', (_$, e) => (logged.push(e.text), { value: undefined }))
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
    on('process.spawn', async function* (_$, e) {
      spawned.push(e.argv)
      // The old session's child draws a frame; the new one's has drawn none yet.
      if (spawned.length === 1) yield { stream: 'stdout' as const, text: `${JSON.stringify(FRAME)}\n` }
      return { value: { code: 0, signal: null } }
    })

    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await clock.advance(1)
    expect(await ui.find({ type: 'Link' })).toBeDefined()

    id = 'sid-2'
    await $.session.end({ reason, sessionId: 'sid-1', resume: { id: 'sid-1' } })
    await clock.advance(1)

    expect(spawned.map(argv => argv[argv.indexOf('--session') + 1])).toEqual(['sid-1', 'sid-2'])
    expect(logged).toContain('candybar-band: frames for sid-1 stopped')
    expect(logged).toContain('candybar-band: frames started for sid-2')
    // Its links name the old session, so none of its frame is left to click.
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
    await ui.unmount()
  })
}

// A stopped child's stream has no end of the child's to read: Claude Code
// 2.1.299 settles its `result` with nothing, as this harness does when the
// hook throws after the close — and an exit, had one been read, is no failure
// either.
for (const [end, close] of [
  ['an exit', () => ({ value: { code: null, signal: 'SIGTERM' } })],
  ['nothing', () => {
    throw new Error('closed early')
  }],
] as const) {
  test(`a child the band stopped ended as asked, which is no failure (${end})`, async ($, on) => {
    const logged: string[] = []
    const clock = mock.clock(on)
    let id = 'sid-1'
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
    on('session.id', () => ({ value: id }))
    on('ui.log', (_$, e) => (logged.push(e.text), { value: undefined }))
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
    // A still bar: the child draws one frame, then writes nothing until the
    // band stops it.
    let killed = false
    on('process.spawn', async function* (_$, _e, next) {
      yield { stream: 'stdout' as const, text: `${JSON.stringify(FRAME)}\n` }
      await new Promise<void>(stopped => next.signal.addEventListener('abort', () => stopped(), { once: true }))
      killed = true
      return close()
    })

    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await clock.advance(1)
    id = 'sid-2'
    await $.session.end({ reason: 'clear', sessionId: 'sid-1', resume: { id: 'sid-1' } })
    await clock.advance(1)

    const sid1 = logged.filter(line => line.includes('sid-1'))
    expect(sid1).toEqual(['candybar-band: frames started for sid-1', 'candybar-band: frames for sid-1 stopped'])
    expect(killed).toBe(true)
    expect(await ui.find({ type: 'Text', text: /candybar: frames/ })).toBeUndefined()
    await ui.unmount()
  })
}

test('an end that keeps the session id keeps its child', async ($, on) => {
  const spawned: (readonly string[])[] = []
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('process.spawn', async function* (_$, e) {
    spawned.push(e.argv)
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'sid-1', resume: { id: 'sid-1' } })
  await clock.advance(1)

  expect(spawned).toHaveLength(1)
})

// One daemon serves every checkout's mod, so the two can be different builds:
// a line the band cannot draw — a shape from before the band frame, a run
// whose field was renamed or retyped, not JSON at all — is said above the last
// bar it could draw, and the stream goes on, so a line it can answers it.
for (const [what, line] of [
  ['a frame from before the band encoding', JSON.stringify({ ok: true, output: 'bar\n' })],
  ['a run with a field the band does not know', JSON.stringify({ ok: true, band: [[{ text: 'x', fg: '#fff' }]] })],
  ['a run whose text is not a string', JSON.stringify({ ok: true, band: [[{ text: 7 }]] })],
  ['a lane-off refusal with no sentence', JSON.stringify({ ok: false, code: 'SWITCHED_OFF' })],
  ['a line that is not JSON', 'not a frame'],
] as const) {
  test(`${what} is said above the band, and the next bar answers it`, { timeoutMs: 15_000 }, async ($, on) => {
    const logged: string[] = []
    const clock = mock.clock(on)
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: 'sid-1' }))
    on('ui.log', (_$, e) => (logged.push(e.text), { value: undefined }))
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return <Box />
    })
    on('process.spawn', async function* () {
      yield { stream: 'stdout' as const, text: `${JSON.stringify(FRAME)}\n` }
      await clock.sleep(250)
      yield { stream: 'stdout' as const, text: `${line}\n` }
      await clock.sleep(250)
      yield { stream: 'stdout' as const, text: `${JSON.stringify(FRAME)}\n` }
      await clock.sleep(60_000)
      return { value: { code: 0, signal: null } }
    })

    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await clock.advance(1)
    await clock.advance(250)
    const said = `candybar: a line the band cannot draw (${line.slice(0, 80)}) — the daemon and this mod are from different builds`
    expect(await ui.find({ type: 'Text', text: said })).toBeDefined()
    // The last bar it could draw still shows beneath what is wrong.
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    expect(logged).toContain(said)

    await clock.advance(250)
    expect(await ui.find({ type: 'Text', text: /cannot draw/ })).toBeUndefined()
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.unmount()
  })
}

// A child still running is work the kit cannot see asleep, so each settle
// here waits out the kit's bound (~1.5 s an advance, ~0.5 s a find).
test('what the child says stands above the bar until a frame answers it', { timeoutMs: 15_000 }, async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${JSON.stringify(FRAME)}\n` }
    yield { stream: 'stderr' as const, text: 'cc-candybar follow: stream failed (ECONNREFUSED); reconnecting in 250ms\n' }
    await clock.sleep(250)
    yield { stream: 'stdout' as const, text: `${JSON.stringify(FRAME)}\n` }
    await clock.sleep(60_000)
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.advance(1)
  // The daemon went away: the bar still shows, under the reason it is stale.
  expect(await ui.find({ type: 'Text', text: /reconnecting in 250ms/ })).toBeDefined()
  expect(await ui.find({ type: 'Link' })).toBeDefined()

  await clock.advance(250)
  expect(await ui.find({ type: 'Text', text: /reconnecting/ })).toBeUndefined()
  expect(await ui.find({ type: 'Link' })).toBeDefined()
  await ui.unmount()
})

test('a band that cannot follow its session says so', async ($, on) => {
  const clock = mock.clock(on)
  let fail = false
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => (fail ? { deny: 'no session' } : { value: 'sid-1' }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('process.spawn', async function* () {
    await clock.sleep(60_000)
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  fail = true
  await $.session.end({ reason: 'clear', sessionId: 'sid-1', resume: { id: 'sid-1' } })
  await clock.advance(1)

  expect(await ui.find({ type: 'Text', text: /following the session failed: .*no session/ })).toBeDefined()
  await ui.unmount()
})

test('follows run in the order they were asked for, so the newest session id wins', async ($, on) => {
  const spawned: string[] = []
  const clock = mock.clock(on)
  // The first ask for the id answers late, with the id as it was when asked.
  let asked = 0
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.id', async () => {
    asked += 1
    if (asked > 1) return { value: 'sid-2' }
    await clock.sleep(10)
    return { value: 'sid-1' }
  })
  on('process.spawn', async function* (_$, e) {
    spawned.push(e.argv[e.argv.indexOf('--session') + 1]!)
    await clock.sleep(60_000)
    return { value: { code: 0, signal: null } }
  })

  const started = $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(1)
  await $.session.end({ reason: 'clear', sessionId: 'sid-1', resume: { id: 'sid-1' } })
  await clock.advance(10)
  await started

  expect(spawned).toEqual(['sid-1', 'sid-2'])
})
