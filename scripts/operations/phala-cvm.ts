import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type CvmPower = "running" | "stopped" | "transitioning";
export interface PhalaCvmIO {
  getCvm(): Promise<CvmPower>;
  startCvm(): Promise<void>;
  stopCvm(): Promise<void>;
}
export interface PhalaCvmIdentity { profile: string; cvm: string; appId: string }

/**
 * Commandes `cvms get/start/stop` de Phala CLI sur une seule CVM déclarée, dont l'app ID est
 * contrôlé à chaque lecture. Partagé par le contrôleur de la démo et celui de l'API développeurs.
 */
export function phalaCvm({ profile, cvm, appId }: PhalaCvmIdentity): PhalaCvmIO {
  if (!/^[\w-]+$/.test(profile) || !/^[\w-]+$/.test(cvm) || !/^[a-f0-9]{40}$/.test(appId)) throw new Error("Identité Phala invalide");
  const execute = promisify(execFile);
  const cli = async (operation: "get" | "start" | "stop") => {
    const { stdout } = await execute("pnpm", ["dlx", "phala@1.1.22", "cvms", operation, cvm,
      "--profile", profile, "--json", "--timeout", "20"], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout);
    return result.data ?? result.result ?? result;
  };
  return {
    getCvm: async () => {
      const result = await cli("get");
      if (result.app_id !== appId) throw new Error("Identité CVM inattendue");
      return result.status === "running" ? "running" : result.status === "stopped" ? "stopped" : "transitioning";
    },
    startCvm: async () => { await cli("start"); },
    stopCvm: async () => { await cli("stop"); },
  };
}
