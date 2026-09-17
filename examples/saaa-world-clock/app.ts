interface CityDefinition {
  id: string;
  label: string;
  timeZone: string;
  group: string;
}

interface WorldClockCapability {
  profile: "world-clock-i32-v1";
  requestHash: string;
  wasmHash: string;
  wasmBytes: number;
  request: {
    intent: string;
    title: string;
    subtitle: string;
    accent: string;
    locale: string;
    cities: CityDefinition[];
  };
}

interface WorldClockExports {
  abi_version(): number;
  local_seconds(utcSeconds: number, offsetMinutes: number): number;
  day_delta(utcSeconds: number, offsetMinutes: number): number;
}

const root = requiredElement("app");
const runtimeStatus = requiredElement("runtime-status");

void start().catch((error: unknown) => {
  runtimeStatus.textContent = "起動に失敗しました";
  runtimeStatus.dataset.state = "error";
  root.innerHTML = `<div class="error-panel"><strong>World Clockを起動できませんでした。</strong><span>${escapeHtml(error instanceof Error ? error.message : String(error))}</span></div>`;
});

async function start(): Promise<void> {
  const [capabilityResponse, wasmResponse] = await Promise.all([
    fetch("/capability.json", { cache: "no-store" }),
    fetch("/world-clock.wasm", { cache: "no-store" }),
  ]);
  if (!capabilityResponse.ok || !wasmResponse.ok) {
    throw new Error("generated capabilityを取得できませんでした");
  }
  const capability = (await capabilityResponse.json()) as WorldClockCapability;
  const wasmBytes = await wasmResponse.arrayBuffer();
  if (!WebAssembly.validate(wasmBytes)) {
    throw new Error("Wasm validation failed");
  }
  const instance = await WebAssembly.instantiate(wasmBytes, {});
  const wasm = instance.instance.exports as unknown as WorldClockExports;
  if (wasm.abi_version() !== 1) throw new Error("unsupported Wasm ABI");

  document.documentElement.style.setProperty(
    "--accent",
    capability.request.accent,
  );
  requiredElement("title").textContent = capability.request.title;
  requiredElement("subtitle").textContent = capability.request.subtitle;
  requiredElement("intent").textContent = capability.request.intent;
  requiredElement("wasm-meta").textContent =
    `${capability.profile} · ${capability.wasmBytes} bytes · ${capability.wasmHash.slice(0, 12)}`;
  runtimeStatus.textContent = "Wasm ABI verified";
  runtimeStatus.dataset.state = "ready";

  root.innerHTML = capability.request.cities.map(cityCard).join("");
  const render = () => renderClocks(capability, wasm, new Date());
  render();
  window.setInterval(render, 1_000);
}

function cityCard(city: CityDefinition): string {
  return `<article class="clock-card" data-city="${escapeHtml(city.id)}">
    <div class="card-heading">
      <div>
        <span class="group">${escapeHtml(city.group)}</span>
        <h2>${escapeHtml(city.label)}</h2>
      </div>
      <span class="day-relation" data-part="relation">今日</span>
    </div>
    <time class="clock" data-part="clock">--:--:--</time>
    <div class="card-footer">
      <span data-part="date">----</span>
      <span data-part="offset">UTC</span>
    </div>
    <div class="zone">${escapeHtml(city.timeZone)}</div>
  </article>`;
}

function renderClocks(
  capability: WorldClockCapability,
  wasm: WorldClockExports,
  now: Date,
): void {
  const utcSeconds =
    now.getUTCHours() * 3_600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  const utcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  for (const city of capability.request.cities) {
    const card = document.querySelector<HTMLElement>(
      `[data-city="${city.id}"]`,
    );
    if (card === null) continue;
    const offsetMinutes = offsetMinutesForTimeZone(now, city.timeZone);
    const localSeconds = wasm.local_seconds(utcSeconds, offsetMinutes);
    const dayDelta = wasm.day_delta(utcSeconds, offsetMinutes);
    part(card, "clock").textContent = formatClock(localSeconds);
    part(card, "relation").textContent = dayRelation(dayDelta);
    part(card, "relation").dataset.delta = String(dayDelta);
    part(card, "offset").textContent = formatOffset(offsetMinutes);
    const localDate = new Date(utcMidnight + dayDelta * 86_400_000);
    part(card, "date").textContent = new Intl.DateTimeFormat(
      capability.request.locale,
      {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
        weekday: "short",
      },
    ).format(localDate);
  }
  requiredElement("utc-clock").textContent =
    `UTC ${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}:${String(now.getUTCSeconds()).padStart(2, "0")}`;
}

function offsetMinutesForTimeZone(date: Date, timeZone: string): number {
  const exactSecond = new Date(Math.floor(date.getTime() / 1_000) * 1_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(exactSecond);
  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  const zonedAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return Math.round((zonedAsUtc - exactSecond.getTime()) / 60_000);
}

function formatClock(localSeconds: number): string {
  const hours = Math.floor(localSeconds / 3_600);
  const minutes = Math.floor((localSeconds % 3_600) / 60);
  const seconds = localSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "−" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function dayRelation(dayDelta: number): string {
  if (dayDelta < 0) return "前日";
  if (dayDelta > 0) return "翌日";
  return "今日";
}

function part(card: HTMLElement, name: string): HTMLElement {
  const element = card.querySelector<HTMLElement>(`[data-part="${name}"]`);
  if (element === null) throw new Error(`missing ${name} element`);
  return element;
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing #${id}`);
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ??
      character,
  );
}
