// [LAW:types-are-the-program] What a message is about, and the rule that says
// when two messages are one. The rule is part of the value, so a producer
// picks it by the constructor it calls, never by how it spells a string, and
// the identity digests the rule beside what it names, so no text can pass for
// a kind. A rule that needs a subject cannot be built without one.
// [LAW:one-way-deps] Lives below both the loader, whose advisories are
// born about something, and the render that lists them.
export type About<Kind extends string = string> = {
  readonly kind: Kind;
} & (
  | { readonly rule: "kind" }
  | { readonly rule: "subject"; readonly subject: string }
  | { readonly rule: "text"; readonly text: string }
);

// One message of its kind, whatever its words become.
export const aboutKind = <Kind extends string>(kind: Kind): About<Kind> => ({
  kind,
  rule: "kind",
});

// One message of its kind for the subject, whatever its words become.
export const aboutSubject = <Kind extends string>(
  kind: Kind,
  subject: string,
): About<Kind> => ({ kind, rule: "subject", subject });

// Its words are what it is: other words, another message.
export const aboutText = <Kind extends string>(
  kind: Kind,
  text: string,
): About<Kind> => ({ kind, rule: "text", text });
