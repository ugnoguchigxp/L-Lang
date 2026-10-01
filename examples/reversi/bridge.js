import { createNativeRuntime } from "./wasm-runtime.js";
// DOM/ABI bridge only: state, legal moves, history, AI and view decisions come from Wasm.
const board = document.querySelector("#board"),
  status = document.querySelector("#status");
const error = document.querySelector("#error"),
  retry = document.querySelector("#retry");
const undo = document.querySelector("#undo"),
  restart = document.querySelector("#restart");
let runtime,
  output,
  pending,
  timer,
  generation = 0;
function showError(cause) {
  error.textContent = `処理に失敗しました。${cause.message}`;
  error.hidden = false;
  retry.hidden = false;
}
function render() {
  board.replaceChildren();
  output.cells.forEach((cell, index) => {
    const button = document.createElement("button");
    button.className = `cell${cell.enabled ? " legal" : ""}${cell.last ? " last" : ""}`;
    button.disabled = !cell.enabled;
    button.setAttribute(
      "aria-label",
      `${Math.floor(index / 8) + 1}行${(index % 8) + 1}列 ${cell.label}${cell.last ? "、直前の手" : ""}`,
    );
    if (cell.stone) {
      const piece = document.createElement("span");
      piece.className = `piece ${cell.stone === 1 ? "black" : "white"}`;
      button.append(piece);
    }
    button.addEventListener("click", () => dispatch(index));
    board.append(button);
  });
  document.querySelector("#black").textContent = String(output.black);
  document.querySelector("#white").textContent = String(output.white);
  status.textContent = output.status;
  undo.disabled = !output.canUndo;
}
function dispatch(action) {
  generation++;
  clearTimeout(timer);
  pending = action;
  try {
    output = runtime.evaluate({
      state: output?.state ?? {
        board: [],
        player: 1,
        last: -1,
        passed: 0,
        history: [],
      },
      action,
    });
    error.hidden = true;
    retry.hidden = true;
    render();
    pending = output.pendingAction;
    if (pending !== -99) {
      const token = generation;
      timer = setTimeout(() => {
        if (token === generation) dispatch(pending);
      }, 180);
    }
  } catch (cause) {
    showError(cause);
  }
}
async function load() {
  try {
    const [manifestResponse, wasmResponse] = await Promise.all([
      fetch("/module-build.json"),
      fetch("/program.wasm"),
    ]);
    if (!manifestResponse.ok || !wasmResponse.ok)
      throw new Error("成果物を読み込めません");
    const manifest = await manifestResponse.json(),
      bytes = await wasmResponse.arrayBuffer();
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (value) => value.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== manifest.wasm.wasmHash)
      throw new Error("Wasmのハッシュが一致しません");
    runtime = createNativeRuntime(manifest.wasm.contract, bytes);
    restart.disabled = false;
    dispatch(-4);
  } catch (cause) {
    showError(cause);
  }
}
undo.addEventListener("click", () => dispatch(-3));
restart.addEventListener("click", () => dispatch(-4));
retry.addEventListener("click", () => (runtime ? dispatch(pending) : load()));
void load();
