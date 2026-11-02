// Fake time ending must hand the refusal back: useRealTimers puts the native
// timer where the guard was.

test("waits on a real timer after fake time ended", () => {
  jest.useFakeTimers();
  jest.useRealTimers();
  setTimeout(() => undefined, 1);
});

test("reads the wall clock after fake time ended", () => {
  jest.useFakeTimers();
  jest.useRealTimers();
  Date.now();
});
