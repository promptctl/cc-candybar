// Draws the session's candybar in the band above the prompt, from the frames
// the daemon pushes for it through a `cc-candybar frames` child, as `Text`
// runs and `Link`s: the menus and their effects move at the daemon's frame
// rate rather than the statusline's one a second, and every `cc-candybar://`
// link is an OSC 8 span the terminal opens, as it opens the statusline's.

import { atom, read } from 'claude-code'
import type {
  ElementConstructor,
  EngineInterface,
  LinkProps,
  Register,
  TextProps,
} from 'claude-code'

import type { BandFrame, BandRun } from '../types'

const frameRef = { plugin: 'candybar-band', key: 'frame' } as const
const failureRef = { plugin: 'candybar-band', key: 'failure' } as const
const frameAtom = atom(frameRef, null)
const failureAtom = atom(failureRef, null)

type Child = { sessionId: string; stop: () => void }

// [LAW:single-enforcer] One owner of the child: `follow` starts the one the
// session calls for and stops any other. A reload starts these over; the
// engine kills the old module's child with it.
let child: Child | null = null

// [LAW:one-source-of-truth] The band names the session and nothing else: its
// frames are drawn from the data the session's own statusline client sends,
// so the band and the statusline are one render of one session.
async function follow($: EngineInterface) {
  const sessionId = await $.session.id()
  if (child?.sessionId === sessionId) return
  child?.stop()
  child = start($, sessionId)
}

export const register: Register = on => {
  // `classic.SessionStart` would carry more, but the built-in security plugin
  // passes classic hooks over a mod a person installs.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await follow($)
    return result
  })

  // A /clear is a new session id, and no `session.start` follows it.
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if (e.reason === 'clear') $.clock.after(0, () => void follow($))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const frame = await read($, frameAtom)
    const failure = await read($, failureAtom)
    if (e.props.hasSurvey || (frame === null && failure === null)) return next(e)

    const { Box, Text, Link } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {failure !== null && <Text color="error" wrap="truncate-end">{failure}</Text>}
        {(frame?.rows ?? []).map((row, i) => (
          <Text key={String(i)} wrap="truncate-end">
            {row.map((run, j) => drawRun(Text, Link, run, j))}
          </Text>
        ))}
      </Box>
    )
  })
}

function drawRun(
  Text: ElementConstructor<TextProps>,
  Link: ElementConstructor<LinkProps>,
  run: BandRun,
  j: number,
) {
  const { text, href, ...style } = run
  const styled = <Text key={String(j)} {...style}>{text}</Text>
  return href === undefined ? styled : <Link key={String(j)} href={href}>{styled}</Link>
}

// The child runs the checkout this mod sits in: `<repo>/mod` beside
// `<repo>/dist`, built by `pnpm build`.
function start($: EngineInterface, sessionId: string): Child {
  const stream = $.process.spawn({
    argv: [
      'node',
      `${$.plugin.root}/../dist/index.mjs`,
      'frames',
      '--session',
      sessionId,
      '--format',
      'band',
    ],
  })
  // [LAW:no-ambient-temporal-coupling] A stopped child's pieces can still be
  // in flight; once `stop` runs, none of them is the session's frame.
  let stopped = false
  void (async () => {
    let pending = ''
    let stderr = ''
    try {
      for await (const { stream: pipe, text } of stream) {
        if (stopped) break
        if (pipe === 'stderr') {
          stderr = (stderr + text).slice(-500)
          $.ui.log(text, { to: 'debug' })
          continue
        }
        const lines = (pending + text).split('\n')
        pending = lines.pop() ?? ''
        // Only the newest frame in a piece is worth drawing.
        const newest = lines.at(-1)
        if (newest !== undefined) await $.state.set(frameRef, JSON.parse(newest) as BandFrame)
      }
      const { code, signal } = await stream.result
      if (!stopped) {
        await $.state.set(failureRef, `candybar: frames stopped (${signal ?? `exit ${code}`}) ${stderr}`)
      }
    } catch (error) {
      if (!stopped) await $.state.set(failureRef, `candybar: frames failed: ${String(error)}`)
    }
  })()
  void $.state.set(failureRef, null)
  return {
    sessionId,
    stop: () => {
      stopped = true
      void stream.return(undefined as never)
    },
  }
}
