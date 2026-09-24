import { parentPort, workerData } from "node:worker_threads";
import { trainSelectedModel } from "./model-registry";
import type { ModelSelection } from "@/lib/models/registry";

const input = workerData as { csv: Uint8Array; selection: ModelSelection };
try {
  parentPort!.postMessage({ model: trainSelectedModel(input.selection, Buffer.from(input.csv)) });
} catch {
  parentPort!.postMessage({ failed: true });
}
