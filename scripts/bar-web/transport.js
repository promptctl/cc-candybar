// The page's transport under `pnpm bar:web`: every call is a request to the
// server (scripts/bar-web/server.ts), which drives an isolated real daemon.

async function post(route, body) {
  let res;
  try {
    res = await fetch(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(`the bar server did not answer: ${e.message}. Is pnpm bar:web still running?`);
  }
  const answer = await res.json();
  if (!res.ok) throw new Error(answer.error);
  return answer;
}

export const transport = {
  render: (size) => post("/render", size),
  click: (url, size) => post("/click", { url, ...size }),
  restart: (size) => post("/restart", size),
};
