import { Writable } from "node:stream";
import { deliverPlan } from "../../src/cli-plan";

function output(error?: Error) {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      text += chunk.toString();
      done(error);
    },
  });
  return { stream, text: () => text };
}

const plan = { stdout: "planned body", stderr: "advisory\n", code: 3 };

test.each(["EPIPE", "ECONNRESET"])(
  "a peer's %s during stdout delivery preserves the planned code and diagnostics",
  async (code) => {
    const out = output(Object.assign(new Error(code), { code }));
    const err = output();
    expect(
      await deliverPlan(plan, { stdout: out.stream, stderr: err.stream }),
    ).toBe(3);
    expect(out.text()).toBe(plan.stdout);
    expect(err.text()).toBe(plan.stderr);
  },
);

test("an unrelated refused write remains the command's failure after stderr is delivered", async () => {
  const failure = Object.assign(new Error("write ENOSPC"), { code: "ENOSPC" });
  const err = output();
  await expect(
    deliverPlan(plan, { stdout: output(failure).stream, stderr: err.stream }),
  ).rejects.toBe(failure);
  expect(err.text()).toBe(plan.stderr);
});
