import type {
  EventInput,
  RendererBoot,
  RendererOutput,
  Timed,
} from "../renderer-interface/interface.js";
import {
  RECORDING_VERSION,
  type RecordedConstruction,
  type RecordingEntry,
} from "../renderer-interface/recording.js";
import { RENDERER_WIRE_VERSION } from "../renderer-interface/wire.js";
import { KeyedSerialQueue } from "../utils/keyed-serial-queue.js";
import type { DaemonLogger } from "../utils/logger.js";
import { eventLine } from "../utils/logfmt.js";
import type { RendererName } from "./foundations/renderer-name.js";
import type { RecordingFile } from "./recording-file.js";
import type { RecordingCommand } from "./foundations/recording-command.js";
import type { Timekeeper } from "../time.js";
import {
  recordingBootProblem,
  recordingInputProblem,
  recordingOutputProblem,
} from "./recording-privacy.js";

type CaptureState =
  | {
      readonly kind:
        | "armed"
        | "booting"
        | "built"
        | "refused"
        | "sealed"
        | "finished";
    }
  | { readonly kind: "failed"; readonly reason: string };

// [LAW:effects-at-boundaries] A slow recording destination cannot grow the
// shared host indefinitely or hold a live turn open. A single large entry can
// write on its own. Subsequent entries share this per-recording byte budget.
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

// [LAW:no-ambient-temporal-coupling] A capture belongs to exactly one
// generation. Its boot and turns are taken before the supervisor renumbers
// any receipts. Only a complete prefix ending between turns can be published.
export class RendererRecording {
  private state: CaptureState = { kind: "armed" };
  private pending: Promise<void> = Promise.resolve();
  private waitingBytes = 0;
  private turns = 0;

  constructor(
    readonly renderer: RendererName,
    readonly file: string,
    private readonly destination: RecordingFile,
    private readonly log: DaemonLogger,
  ) {}

  claim(): RendererRecording | undefined {
    if (this.state.kind !== "armed") return undefined;
    this.state = { kind: "booting" };
    return this;
  }

  get active(): boolean {
    return this.state.kind === "built";
  }

  // The host can continue to own the live object while the worker answers.
  // Retain the plain data as it crossed the pipe, including JSON's nulls.
  snapshot<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  constructed(input: RendererBoot, result: RecordedConstruction): void {
    if (this.state.kind !== "booting") return;
    this.admit(
      () => recordingBootProblem(input),
      () => {
        this.state = { kind: result.kind };
        return this.append({
          kind: "boot",
          version: RECORDING_VERSION,
          wireVersion: RENDERER_WIRE_VERSION,
          input,
          result,
        });
      },
    );
  }

  async turn(
    input: EventInput,
    answer: (event: EventInput) => Promise<Timed<RendererOutput>>,
  ): Promise<Timed<RendererOutput>> {
    const captured = this.admit(
      () => recordingInputProblem(input),
      () => this.snapshot(input),
    );
    let timed: Timed<RendererOutput>;
    try {
      timed = await answer(input);
    } catch (error) {
      this.fail("renderer transport returned no semantic answer to an input");
      throw error;
    }
    if (captured === undefined || !this.active) return timed;
    const { turnMs: _transportTiming, ...output } = timed;
    this.admit(
      () => recordingOutputProblem(output),
      () => {
        this.turns++;
        return this.append({ kind: "turn", input: captured, output });
      },
    );
    return timed;
  }

  // A rejected export must leave the actual renderer and its turn intact.
  private admit<T>(
    problemOf: () => string | null,
    take: () => T,
  ): T | undefined {
    try {
      const reason = problemOf();
      if (reason === null) return take();
      this.fail(reason);
    } catch {
      this.fail("renderer data could not be admitted for recording");
    }
    return undefined;
  }

  private append(entry: RecordingEntry): void {
    // Serialize in the accepting turn. Production data can share a held
    // declaration with a later turn, and a queued write must own its bytes.
    let line: string;
    try {
      line = JSON.stringify(entry) + "\n";
    } catch {
      this.fail("renderer data could not be encoded");
      return;
    }
    const bytes = Buffer.byteLength(line);
    if (this.waitingBytes > 0 && this.waitingBytes + bytes > MAX_QUEUED_BYTES) {
      this.fail("recording storage could not keep up with the renderer");
      return;
    }
    this.waitingBytes += bytes;
    this.pending = this.pending.then(async () => {
      try {
        if (this.state.kind !== "failed") await this.destination.append(line);
      } catch (error) {
        this.fail(`writing recording: ${String(error)}`);
      } finally {
        this.waitingBytes -= bytes;
      }
    });
  }

  fail(reason: string): void {
    if (this.state.kind === "failed" || this.state.kind === "finished") return;
    this.state = { kind: "failed", reason };
    this.pending = this.pending
      .then(() => this.destination.discard())
      .catch((error: unknown) => {
        this.report("cleanup-failed", String(error));
      });
    this.report("failed", reason);
  }

  interrupted(): void {
    if (this.state.kind === "booting" || this.active)
      this.fail("the renderer ended before the recording was stopped");
  }

  private report(outcome: string, reason?: string): void {
    this.log(
      reason === undefined ? "info" : "warn",
      eventLine("recording", [
        ["renderer", this.renderer],
        ["turns", String(this.turns)],
        ["outcome", outcome],
        ...(reason === undefined ? [] : [["reason", reason] as const]),
      ]),
    );
  }

  // [LAW:no-ambient-temporal-coupling] Seal inside the selected renderer's
  // mailbox. Draining and publishing happen after that mailbox is free.
  seal(): void {
    if (this.state.kind === "armed" || this.state.kind === "booting")
      this.fail(
        "the selected renderer did not finish booting during this recording",
      );
    if (this.state.kind === "built" || this.state.kind === "refused") {
      this.state = { kind: "sealed" };
      this.append({ kind: "end", turns: this.turns });
    }
  }

  async finish(): Promise<string> {
    this.seal();
    // A failed append can schedule its cleanup as the write settles.
    await this.checkedWrites();
    let cleanup: string | null;
    try {
      cleanup = await this.destination.publish();
    } catch (error) {
      this.fail(`publishing recording: ${String(error)}`);
      await this.pending;
      throw error;
    }
    this.state = { kind: "finished" };
    this.report("saved", cleanup ?? undefined);
    return `Saved ${this.turns} renderer turns to ${this.file}\n${cleanup === null ? "" : cleanup + "\n"}`;
  }

  private async checkedWrites(): Promise<void> {
    await this.pending;
    if (this.state.kind === "failed") {
      await this.pending;
      throw new Error(this.state.reason);
    }
  }
}

export class RendererRecordings {
  private readonly selected = new Map<RendererName, RendererRecording>();
  private readonly control: KeyedSerialQueue<RendererName>;
  private readonly requests = new Set<Promise<string>>();
  private closing = false;

  constructor(
    private readonly open: (file: string) => Promise<RecordingFile>,
    private readonly log: DaemonLogger,
    detach: Timekeeper["detach"],
  ) {
    this.control = new KeyedSerialQueue(
      detach,
      (name) => `renderer ${name} recording control`,
    );
  }

  generation(name: RendererName): RendererRecording | undefined {
    return this.selected.get(name)?.claim();
  }

  request(
    command: RecordingCommand,
    atBoundary: <T>(
      name: RendererName,
      operation: (restart?: () => Promise<void>) => Promise<T>,
    ) => Promise<T>,
  ): Promise<string> {
    const name = command.renderer;
    if (this.closing) return Promise.reject(new Error("daemon is closing"));
    const result = this.control.run(name, async () => {
      if (this.closing) throw new Error("daemon is closing");
      const current = this.selected.get(name);
      if (command.action === "stop") {
        if (current === undefined)
          throw new Error(`no recording for renderer ${name}`);
        await atBoundary(name, async () => {
          this.selected.delete(name);
          current.seal();
        });
        return current.finish();
      }
      if (current !== undefined) {
        if (current.file === command.file)
          return `Recording already requested for renderer ${name}\n`;
        throw new Error(
          `renderer ${name} already has a recording; stop it first`,
        );
      }
      const capture = new RendererRecording(
        name,
        command.file,
        await this.open(command.file),
        this.log,
      );
      try {
        // The renderer may first bind while the file opens. Resolve its
        // current mailbox after the open, before arming its next generation.
        return await atBoundary(name, async (restart) => {
          if (this.closing) throw new Error("daemon is closing");
          this.selected.set(name, capture);
          await restart?.();
          this.log(
            "info",
            eventLine("recording", [
              ["renderer", name],
              ["outcome", restart === undefined ? "armed" : "started"],
            ]),
          );
          return restart === undefined
            ? `Recording armed for the next start of renderer ${name}\n`
            : `Recording a fresh generation of renderer ${name}\n`;
        });
      } catch (error) {
        this.selected.delete(name);
        capture.fail("could not start a fresh renderer generation");
        throw error;
      }
    });
    this.requests.add(result);
    return result.finally(() => this.requests.delete(result));
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.requests);
    const finishing = Array.from(this.selected.values(), (capture) =>
      capture.finish(),
    );
    this.selected.clear();
    // Every failed capture reports its own cause and discards its staging file.
    await Promise.allSettled(finishing);
  }
}
