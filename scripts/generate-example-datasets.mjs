import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "public/examples/energy-demand.csv");

let state = 42;
function random() {
  state = (state * 1_664_525 + 1_013_904_223) >>> 0;
  return state / 2 ** 32;
}

function peak(hour, center) {
  return Math.exp(-((hour - center) ** 2) / 4);
}

async function main() {
  const header = [
    "hour",
    "temperature_c",
    "humidity_pct",
    "wind_kmh",
    "cloud_cover_pct",
    "is_weekend",
    "is_holiday",
    "solar_kw",
    "morning_peak",
    "evening_peak",
    "energy_mwh",
  ];
  const rows = [header.join(",")];

  for (let index = 0; index < 8_760; index++) {
    const day = Math.floor(index / 24);
    const hour = index % 24;
    const weekend = Number(day % 7 >= 5);
    const holiday = Number(day === 0 || day === 119 || day === 358);
    const temperature = 14 + 11 * Math.sin((2 * Math.PI * (day - 78)) / 365) + (random() - 0.5) * 4;
    const humidity = 62 + (random() - 0.5) * 36;
    const wind = 12 + (random() - 0.5) * 18;
    const clouds = Math.min(100, Math.max(0, 55 + (random() - 0.5) * 80));
    const solar = Math.max(0, Math.sin((Math.PI * (hour - 6)) / 12)) * (1 - clouds / 130) * 45;
    const morning = peak(hour, 8);
    const evening = peak(hour, 19);
    const noise = (random() - 0.5) * 10;
    const demand = 54 - 0.7 * temperature + 0.14 * humidity + 0.18 * wind + 0.06 * clouds + 8 * weekend - 10 * holiday - 0.02 * solar + 31 * morning + 45 * evening + noise;

    rows.push([
      hour,
      temperature.toFixed(2),
      humidity.toFixed(2),
      wind.toFixed(2),
      clouds.toFixed(2),
      weekend,
      holiday,
      solar.toFixed(2),
      morning.toFixed(6),
      evening.toFixed(6),
      demand.toFixed(2),
    ].join(","));
  }

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${rows.join("\n")}\n`);
  console.log(`Dataset synthétique écrit : ${output} (8760 lignes)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
