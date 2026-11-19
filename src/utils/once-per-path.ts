// [LAW:one-source-of-truth] Within one read batch, every caller gets the
// first observation of the path, including failed and absent observations.
export function oncePerPath<T>(read: (file: string) => T): (file: string) => T {
  const readings = new Map<string, { value: T }>();
  return (file) => {
    const held = readings.get(file);
    if (held !== undefined) return held.value;
    const value = read(file);
    readings.set(file, { value });
    return value;
  };
}
