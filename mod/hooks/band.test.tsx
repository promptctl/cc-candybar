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
  const clock = mock.clock(on)
  // The engine beneath the mod: the session it names, and a band it draws empty.
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('process.spawn', async function* (_$, e) {
    spawned.push(e.argv)
    yield { stream: 'stdout' as const, text: `${JSON.stringify(FRAME)}\n` }
    return { value: { code: 0, signal: null } }
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
  // The child ended on its own, so the band says so above the bar.
  expect(await ui.find({ type: 'Text', text: /frames stopped \(exit 0\)/ })).toBeDefined()
  await ui.unmount()
})
