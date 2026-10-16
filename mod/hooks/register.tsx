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

const bandRef = { plugin: 'candybar-band', key: 'band' } as const
const bandAtom = atom(bandRef, { frame: null, failure: null })

type Child = { sessionId: string; stop: () => void }

// [LAW:single-enforcer] One owner of the child: `follow` starts the one the
// session calls for and stops any other. A reload starts these over; the
// engine kills the old module's child with it.
let child: Child | null = null

// [LAW:one-source-of-truth] The band names the session and nothing else: its
// frames are drawn from the data the session's own statusline client sends,
// so the band and the statusline are one render of one session.
async function followNow($: EngineInterface) {
  try {
    const sessionId = await $.session.id()
    if (child?.sessionId === sessionId) return
    child?.stop()
    child = start($, sessionId)
  } catch (error) {
    // [LAW:no-silent-failure] A band that cannot follow its session says so.
    $.ui.log(`candybar-band: following the session failed: ${String(error)}`, { to: 'debug' })
    await $.state.set(bandRef, { frame: null, failure: `candybar: following the session failed: ${String(error)}` })
  }
}

// [LAW:no-ambient-temporal-coupling] Follows run one at a time, in the order
// the session's events asked for them, so the last one asked reads the
// session id last and its child is the one left running.
let following: Promise<void> = Promise.resolve()

function follow($: EngineInterface): Promise<void> {
  following = following.then(() => followNow($), () => followNow($))
  return following
}

export const register: Register = on => {
  // `classic.SessionStart` would carry more, but the built-in security plugin
  // passes classic hooks over a mod a person installs.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await follow($)
    return result
  })

  // A /clear or a resume goes on under a new session id, and no
  // `session.start` follows it. [LAW:dataflow-not-control-flow] Every end
  // asks: `follow` keeps the child of a session id that did not change.
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    $.clock.after(0, () => void follow($))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { frame, failure } = await read($, bandAtom)
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
  // A new session's band starts empty: the last frame is another session's,
  // its links that session's.
  void $.state.set(bandRef, { frame: null, failure: null })
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
  $.ui.log(`candybar-band: frames started for ${sessionId}`, { to: 'debug' })
  // [LAW:no-ambient-temporal-coupling] A stopped child's pieces can still be
  // in flight; once `stop` runs, none of them is the session's frame.
  let stopped = false
  void (async () => {
    let frame: BandFrame | null = null
    // The child's last line on stderr, and each pipe's line not yet ended.
    let said = ''
    const partial = { stdout: '', stderr: '' }
    const draw = (failure: string | null) => $.state.set(bandRef, { frame, failure })
    try {
      for await (const { stream: pipe, text } of stream) {
        if (stopped) break
        const lines = (partial[pipe] + text).split('\n')
        partial[pipe] = lines.pop() ?? ''
        if (pipe === 'stderr') {
          for (const line of lines) $.ui.log(line, { to: 'debug' })
          const newest = lines.findLast(line => line.trim() !== '')
          if (newest === undefined) continue
          // [LAW:no-silent-failure] The child says only what is wrong (a
          // daemon it is reconnecting to, a render that failed), so its word
          // stands above the bar until a frame answers it.
          said = newest
          await draw(said)
          continue
        }
        // Only the newest frame in a piece is worth drawing.
        const newest = lines.at(-1)
        if (newest === undefined) continue
        frame = JSON.parse(newest) as BandFrame
        await draw(null)
      }
      const { code, signal } = await stream.result
      const how = signal ?? `exit ${code}`
      $.ui.log(`candybar-band: frames for ${sessionId} ended (${how})`, { to: 'debug' })
      if (!stopped) await draw(`candybar: frames stopped (${how}) ${said}`)
    } catch (error) {
      $.ui.log(`candybar-band: frames for ${sessionId} failed: ${String(error)}`, { to: 'debug' })
      if (!stopped) await draw(`candybar: frames failed: ${String(error)}`)
    }
  })()
  return {
    sessionId,
    stop: () => {
      stopped = true
      $.ui.log(`candybar-band: frames for ${sessionId} stopped`, { to: 'debug' })
      void stream.return(undefined as never)
    },
  }
}
