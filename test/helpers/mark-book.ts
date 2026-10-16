// An in-memory mark book for tests that hand the doctor a fake edge: the
// production one is a file under the daemon's state directory.
import type { MarkBook } from "../../src/doctor/checks";
import { withMark, type MarkBookStore } from "../../src/doctor/mark-book";

export function memoryMarkBook(initial: MarkBook = {}): MarkBookStore & {
  readonly book: () => MarkBook;
} {
  let book = initial;
  return {
    read: () => ({ kind: "ok", value: book }),
    record: (check, sighting, mark) => {
      book = withMark(book, check, sighting, mark);
    },
    book: () => book,
  };
}
