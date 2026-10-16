import { expect, mock, test } from 'claude-code/testing'

const FRAME = {
  rows: [
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
    yield { stream: 'stderr' as const, text: '    at run (frames.mjs:1)\nError: why it stopped\n' }
    return { value: { code: 1, signal: null } }
  })

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.advance(1)

  // The child is asked for the session alone: its data is the statusline's.
  expect(spawned.map(argv => argv.slice(2))).toEqual([
    ['frames', '--session', 'sid-1', '--format', 'band'],
  ])
  expect(await ui.find({ type: 'Link' })).toMatchObject({
    props: { href: 'cc-candybar://dispatch/e=x' },
  })
  expect(await ui.find({ type: 'Text', text: /bar/ })).toBeDefined()
  // The child ended on its own, so the band says why above the bar, in one
  // row: its last word, not the stack before it.
  const failure = await ui.find({ type: 'Text', text: /frames stopped/ })
  expect(failure).toMatchObject({ text: 'candybar: frames stopped (exit 1) Error: why it stopped' })
  expect(logged.filter(line => line.startsWith('candybar-band:'))).toEqual([
    'candybar-band: frames started for sid-1',
    'candybar-band: frames for sid-1 ended (exit 1)',
  ])
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

    expect(spawned.map(argv => argv[4])).toEqual(['sid-1', 'sid-2'])
    expect(logged).toContain('candybar-band: frames for sid-1 stopped')
    expect(logged).toContain('candybar-band: frames started for sid-2')
    // Its links name the old session, so none of its frame is left to click.
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
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

test('a line the band cannot read ends the child’s stream and says why', async ($, on) => {
  const reached: string[] = []
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('process.spawn', async function* () {
    try {
      yield { stream: 'stdout' as const, text: 'not a frame\n' }
      reached.push('next piece')
      yield { stream: 'stdout' as const, text: `${JSON.stringify(FRAME)}\n` }
      return { value: { code: 0, signal: null } }
    } finally {
      reached.push('ended')
    }
  })

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.advance(1)

  // Leaving the read loop returned the stream, which is how `stop` ends a
  // child: nothing is left running unread.
  expect(reached).toEqual(['ended'])
  expect(await ui.find({ type: 'Text', text: /frames failed/ })).toBeDefined()
  await ui.unmount()
})
