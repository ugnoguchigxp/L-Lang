import { createNativeRuntime } from "/wasm-runtime.js";
import { createTimer } from "/timer.js";

// DOM, input and timer transport only. All game decisions are returned by Wasm.
const ui = Object.fromEntries(
  [
    "title",
    "subtitle",
    "board",
    "preview",
    "score",
    "lines",
    "level",
    "status",
    "restart",
    "controls",
    "error",
    "retry",
  ].map((id) => [id, document.getElementById(id)]),
);
let config, runtime, output;
const timer = createTimer(() => send(config.tickAction));
function cells(container, values, width, height) {
  if (
    !Array.isArray(values) ||
    values.length !== width * height ||
    values.some((v) => !Number.isInteger(v))
  )
    throw new Error("Invalid grid view");
  container.style.setProperty("--grid-width", width);
  if (container.childElementCount !== values.length)
    container.replaceChildren(
      ...values.map(() => {
        const cell = document.createElement("span");
        cell.className = "cell";
        return cell;
      }),
    );
  values.forEach((value, index) => {
    container.children[index].dataset.value = String(value);
  });
}
function render() {
  cells(ui.board, output.cells, config.board.width, config.board.height);
  cells(
    ui.preview,
    output.preview,
    config.preview.width,
    config.preview.height,
  );
  for (const name of ["score", "lines", "level", "status"])
    ui[name].textContent = String(output[name]);
  ui.board.setAttribute(
    "aria-label",
    `${config.title}、${output.status}、スコア ${output.score}`,
  );
  ui.restart.disabled = false;
}
function schedule(resetClock = false) {
  timer.update(output.tickMs, resetClock);
  if (document.hidden) timer.cancel(true);
}
function send(action) {
  timer.cancel();
  try {
    const next = runtime.evaluate({
      state: output?.state ?? config.initialState,
      action,
    });
    output = next;
    render();
    ui.error.hidden = true;
    ui.retry.hidden = true;
    schedule(action === config.tickAction || action === config.resetAction);
  } catch (error) {
    ui.error.textContent = `ゲームを続けられませんでした。${error.message}`;
    ui.error.hidden = false;
    ui.retry.hidden = false;
  }
}
async function fetchOk(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`読み込み失敗 ${path}`);
  return response;
}
async function boot() {
  try {
    const [appResponse, manifestResponse, wasmResponse] = await Promise.all([
      fetchOk("/app.json"),
      fetchOk("/module-build.json"),
      fetchOk("/program.wasm"),
    ]);
    config = await appResponse.json();
    const manifest = await manifestResponse.json(),
      bytes = await wasmResponse.arrayBuffer();
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    if (!manifest.wasm || hash !== manifest.wasm.wasmHash)
      throw new Error("Wasmの内容がビルド情報と一致しません");
    runtime = createNativeRuntime(manifest.wasm.contract, bytes);
    document.title = config.title;
    ui.title.textContent = config.title;
    ui.subtitle.textContent = config.subtitle;
    ui.board.style.setProperty("--board-width", config.board.width);
    ui.board.style.setProperty("--board-height", config.board.height);
    ui.controls.replaceChildren(
      ...config.controls.map((control) => {
        const button = document.createElement("button");
        button.textContent = control.label;
        button.addEventListener("click", (event) => {
          send(control.action);
          if (event.detail > 0) ui.board.focus({ preventScroll: true });
        });
        return button;
      }),
    );
    send(config.resetAction);
  } catch (error) {
    ui.error.textContent = `読み込みに失敗しました。${error.message}`;
    ui.error.hidden = false;
    ui.retry.hidden = false;
  }
}
ui.restart.addEventListener("click", () => send(config.resetAction));
ui.retry.addEventListener("click", () => location.reload());
document.addEventListener("keydown", (event) => {
  if (
    !runtime ||
    !config ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.target.isContentEditable ||
    (event.target.closest("button") && event.key === " ") ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName) ||
    !Object.hasOwn(config.keyActions, event.key)
  )
    return;
  const action = config.keyActions[event.key];
  event.preventDefault();
  if (event.repeat && !config.repeatActions?.includes(action)) return;
  send(action);
});
document.addEventListener("visibilitychange", () => {
  timer.cancel(true);
  // Hidden tabs stop sending time events; foreground evaluates no accumulated time.
  if (!document.hidden && runtime && output) send(config.idleAction);
});
await boot();
