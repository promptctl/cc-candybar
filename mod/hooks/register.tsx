// Draws the session's candybar in the band above the prompt, from the frames
// the daemon pushes for it through a `cc-candybar-native follow` child, as
// `Text` runs and `Link`s: the menus and their effects move at the daemon's frame
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

import type { BandBar, BandLine, BandOff, BandRow, BandRun } from '../types'

const bandRef = { plugin: 'candybar-band', key: 'band' } as const
const bandAtom = atom(bandRef, { frame: null, failure: null })

type Child = { sessionId: string; stop: () => void }

// [LAW:single-enforcer] One owner of the child: `follow` starts the one the
// session calls for and stops any other, and a child that ended on its own
// (the lane off, an exit) empties the slot it holds, so the next follow asks
// again. A reload starts these over; the engine kills the old module's child
// with it.
let child: Child | null = null

// [LAW:one-source-of-truth] The band names the session and nothing else: its
// frames are drawn from the data the session's own statusline client sends,
// so the band and the statusline are one render of one session.
async function followNow($: EngineInterface) {
  try {
    const sessionId = await $.session.id()
    if (child?.sessionId === sessionId) return
    child?.stop()
    const started: Child = start($, sessionId, () => {
      if (child === started) child = null
    })
    child = started
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

  // A band whose child ended (its lane off, an exit) holds none, so it asks
  // again as the person works: the lane comes back on by a click in any
  // session, a save, a `cd` or a hand edit, and the band follows by the next
  // prompt.
  on('prompt.submit', async ($, e, next) => {
    void follow($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { frame, failure } = await read($, bandAtom)
    // Nothing to draw — no frame yet, the band's lane switched off (🧪 band (A)
    // in candybar's settings menu), an empty bar — hands the band on.
    const rows = frame?.ok === true ? frame.band : []
    if (e.props.hasSurvey || (rows.length === 0 && failure === null)) return next(e)

    const { Box, Text, Link } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {failure !== null && <Text color="error" wrap="truncate-end">{failure}</Text>}
        {rows.map((row, i) => (
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

// [LAW:parse-dont-validate] How each field of a run is read, keyed by
// `BandRun`'s fields: a field added there fails to compile here until the band
// says how to read it, and a key a run carries that is not here is refused —
// a renamed field arrives as one, while the field it replaced, optional, is
// simply absent.
const RUN_FIELDS = {
  text: 'string',
  color: 'string',
  backgroundColor: 'string',
  href: 'string',
  bold: true,
  dimColor: true,
  italic: true,
  underline: true,
  strikethrough: true,
  inverse: true,
} as const satisfies Record<keyof BandRun, 'string' | true>

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function isRun(v: unknown): v is BandRun {
  if (!isRecord(v) || typeof v.text !== 'string') return false
  return Object.entries(v).every(([key, value]) => {
    if (!Object.hasOwn(RUN_FIELDS, key)) return false
    return RUN_FIELDS[key as keyof BandRun] === 'string' ? typeof value === 'string' : value === true
  })
}

const isRow = (v: unknown): v is BandRow => Array.isArray(v) && v.every(isRun)

const isBar = (v: Record<string, unknown>): v is Record<string, unknown> & BandBar =>
  v.ok === true && Array.isArray(v.band) && v.band.every(isRow)

const isOff = (v: Record<string, unknown>): v is Record<string, unknown> & BandOff =>
  v.ok === false && v.code === 'SWITCHED_OFF' && typeof v.error === 'string'

// One line of the child's stdout, read whole: a bar, the lane switched off,
// or — the daemon and this mod being from different builds, one daemon serving
// every checkout's mod — a line the band says it cannot draw.
function parseBandLine(text: string): { readonly line: BandLine } | { readonly unreadable: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    value = undefined
  }
  if (isRecord(value) && (isBar(value) || isOff(value))) return { line: value }
  return {
    unreadable: `candybar: a line the band cannot draw (${Array.from(text).slice(0, 80).join('')}) — the daemon and this mod are from different builds`,
  }
}

// The child is the native client of the checkout this mod sits in: `<repo>/mod`
// beside `<repo>/bin/cc-candybar-native`, built by `just install-rust`.
function start($: EngineInterface, sessionId: string, release: () => void): Child {
  // A new session's band starts empty: the last frame is another session's,
  // its links that session's.
  void $.state.set(bandRef, { frame: null, failure: null })
  const stream = $.process.spawn({
    argv: [`${$.plugin.root}/../bin/cc-candybar-native`, 'follow', '--lane', 'band', '--session', sessionId],
  })
  $.ui.log(`candybar-band: frames started for ${sessionId}`, { to: 'debug' })
  // [LAW:no-ambient-temporal-coupling] A stopped child's pieces can still be
  // in flight; once `stop` runs, none of them is the session's frame.
  let stopped = false
  void (async () => {
    let frame: BandLine | null = null
    // The child's last line on stderr, and each pipe's line not yet ended.
    let said = ''
    const partial = { stdout: '', stderr: '' }
    const draw = (failure: string | null) => $.state.set(bandRef, { frame, failure })
    // How the child ended: what the debug log says, what stands above the
    // band, and whether the child is known gone, so the session is free to
    // follow again.
    let ended: { readonly log: string; readonly failure: string | null; readonly gone: boolean } | null = null
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
        // Only the newest line in a piece is worth drawing.
        const newest = lines.at(-1)
        if (newest === undefined) continue
        const parsed = parseBandLine(newest)
        // [LAW:no-silent-failure] A line the band cannot draw stands above the
        // last bar it could, until a line it can answers it.
        if ('unreadable' in parsed) {
          $.ui.log(parsed.unreadable, { to: 'debug' })
          await draw(parsed.unreadable)
          continue
        }
        frame = parsed.line
        // A lane switched off holds no process: the child would only ask the
        // daemon again every few seconds for as long as the session runs.
        // Leaving the loop returns the stream, which kills the child; a kill
        // that fails throws here instead.
        if (!frame.ok) {
          ended = { log: `not following: lane A is off (${frame.error})`, failure: null, gone: true }
          break
        }
        await draw(null)
      }
      if (ended === null) {
        const { code, signal } = await stream.result
        const how = signal ?? `exit ${code}`
        ended = { log: `ended (${how})`, failure: `candybar: frames stopped (${how}) ${said}`, gone: true }
      } else {
        // [LAW:no-ambient-temporal-coupling] Its `result` is no end of the
        // child's, so nothing waits on it: the engine's contract rejects it
        // for a stream closed early, and Claude Code 2.1.299 settles it with
        // nothing. [LAW:no-silent-failure] exception: that rejection is the
        // contract's answer to the close, no fact about the child; a kill
        // that failed threw at the break.
        stream.result.catch(() => undefined)
      }
    } catch (error) {
      // The stream failed, or a kill did: the child may still be running, so
      // the session keeps it and starts no second one beside it.
      ended = { log: `failed: ${String(error)}`, failure: `candybar: frames failed: ${String(error)}`, gone: false }
    }
    // [LAW:no-ambient-temporal-coupling] A child the band stopped ended as
    // asked, whenever the stop landed, and its stream's `result` is no end of
    // the child's.
    if (stopped) return
    // [LAW:no-silent-failure] The debug log says why the band is blank, and a
    // child that failed says so above it until the next follow answers it.
    $.ui.log(`candybar-band: frames for ${sessionId} ${ended.log}`, { to: 'debug' })
    if (ended.gone) release()
    await draw(ended.failure)
  })().catch(error => {
    // [LAW:no-silent-failure] The band could not even say why its child
    // ended: the engine refused the write, as it does once a reload has
    // unloaded this module (and killed its child). Said where it still can be.
    $.ui.log(`candybar-band: frames for ${sessionId} could not be drawn: ${String(error)}`, { to: 'debug' })
  })
  return {
    sessionId,
    stop: () => {
      stopped = true
      $.ui.log(`candybar-band: frames for ${sessionId} stopped`, { to: 'debug' })
      // Kills the child (SIGTERM), silent or not: a /clear leaves no follower.
      // [LAW:no-silent-failure] A close that failed may have left one.
      stream
        .return(undefined as never)
        .catch(error => $.ui.log(`candybar-band: frames for ${sessionId} could not be stopped: ${String(error)}`, { to: 'debug' }))
    },
  }
}
