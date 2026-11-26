// [LAW:one-way-deps] What a session's transcripts give its folds less of, in
// a module that imports nothing: the line reading produces these and the
// world state carries them, and the world state sits above the folds whose
// outputs it carries, so the vocabulary both share sits below them both.

// [LAW:types-are-the-program] What a fold could not read of one file: how
// many lines it dropped, and which is the first of them and why (`reason`
// says what that line is: "is not JSON (…)").
export interface DroppedLines {
  readonly lines: number;
  readonly firstLine: number;
  readonly reason: string;
}

// [LAW:no-silent-failure] What a session's transcripts give its folds less
// of: lines of one file the folds read without, or a sidechain whose first
// line cannot say whose it is (`reason` says what that line is), which the
// session's usage leaves out. Each stands as long as the folds missing it are
// the session's, since the bar's figures for the session are short by it for
// that long.
export type TranscriptLoss =
  | ({ readonly kind: "dropped-lines"; readonly path: string } & DroppedLines)
  | {
      readonly kind: "unowned-sidechain";
      readonly path: string;
      readonly reason: string;
    };

// [LAW:one-source-of-truth] A loss in words, as the bar shows it and the
// daemon's log records it.
export function transcriptLossText(loss: TranscriptLoss): string {
  switch (loss.kind) {
    case "dropped-lines":
      return loss.lines === 1
        ? `${loss.path}: line ${loss.firstLine} ${loss.reason}, so the bar's figures for this session leave it out`
        : `${loss.path}: ${loss.lines} lines could not be read, so the bar's figures for this session leave them out; the first, line ${loss.firstLine}, ${loss.reason}`;
    case "unowned-sidechain":
      return `${loss.path}: its first line ${loss.reason}, so whose sidechain it is cannot be told, and the session's usage leaves it out`;
  }
}
