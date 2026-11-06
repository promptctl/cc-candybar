// tmux's command syntax (tmux(1), PARSING SYNTAX), both ways: how words and
// command lists are written for tmux to parse, and how tmux prints them back
// when it lists a binding (`list-keys`), so what it prints reads as the
// commands it holds.

// A command list: commands of words, in the order tmux runs them.
export type CommandList = ReadonlyArray<readonly string[]>;

// A string tmux parses as one word of a command: double-quoted, with the
// three characters it escapes there escaped.
export function tmuxQuoted(text: string): string {
  return `"${text.replace(/[\\"$]/g, (c) => `\\${c}`)}"`;
}

// A command list as the text of one word, for a command that takes one —
// if-shell's, which tmux parses as it is (measured: not format-expanded).
export function commandText(commands: CommandList): string {
  return commands.map((c) => c.map(tmuxQuoted).join(" ")).join(" ; ");
}

// A command list spliced into command text as the commands of the command
// before it — a bind-key's — rather than as commands of its own: `\;` is the
// separator tmux leaves to the command it parses.
export function boundText(commands: CommandList): string {
  return commands.map((c) => c.map(tmuxQuoted).join(" ")).join(" \\; ");
}

// The escapes tmux's printer writes inside a word (vis(3) with its C-style,
// octal, tab and newline flags): a C escape, three octal digits for a byte it
// will not print, and a backslash before any other character it escaped.
const C_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  a: "\x07",
  v: "\v",
  f: "\f",
  "0": "\0",
};

// Whether a `\;` at `i` stands alone, as tmux prints a command list's
// separator: a `\;` inside a word is a `;` in it.
const lonely = (text: string, i: number): boolean =>
  text.startsWith("\\;", i) && (text[i + 2] ?? " ") === " ";

// [LAW:parse-dont-validate] The command list text spells, as tmux prints one
// or as command text: words bare, double-quoted or single-quoted, every one
// with its escapes undone (tmux escapes inside single quotes too), `''` the
// empty word, and an unquoted `;` or a lone `\;` the separator, so a `;`
// inside a quoted word stays in it. A lone `;` argument cannot be told from a
// separator in a listing (tmux prints both `\;`), so it reads as one. Octal
// escapes are bytes, decoded together so a UTF-8 character tmux escaped reads
// whole.
export function tmuxCommands(text: string): string[][] {
  const commands: string[][] = [[]];
  let i = 0;
  while (i < text.length) {
    if (text[i] === " ") {
      i++;
      continue;
    }
    if (text[i] === ";" || lonely(text, i)) {
      commands.push([]);
      i += text[i] === ";" ? 1 : 2;
      continue;
    }
    const bytes: number[] = [];
    const add = (s: string): void => {
      bytes.push(...Buffer.from(s, "utf8"));
    };
    let quote: string | null = null;
    while (i < text.length) {
      const c = text[i]!;
      if (quote === null && (c === " " || c === ";")) break;
      if (c === quote) {
        quote = null;
        i++;
      } else if (quote === null && (c === '"' || c === "'")) {
        quote = c;
        i++;
      } else if (c === "\\" && i + 1 < text.length) {
        const octal = /^[0-7]{3}/.exec(text.slice(i + 1, i + 4));
        const next = text[i + 1]!;
        if (octal !== null) {
          bytes.push(parseInt(octal[0], 8));
          i += 4;
        } else {
          add(C_ESCAPES[next] ?? next);
          i += 2;
        }
      } else {
        const char = String.fromCodePoint(text.codePointAt(i)!);
        add(char);
        i += char.length;
      }
    }
    commands.at(-1)!.push(Buffer.from(bytes).toString("utf8"));
  }
  return commands.filter((c) => c.length > 0);
}
