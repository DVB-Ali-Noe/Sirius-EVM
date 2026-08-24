"use client";

import { decodeFunctionResult, encodeFunctionData } from "viem";
import { erc20Abi } from "./abi/erc20";
import { usdcAddress } from "./addresses";
import { getExternalWallet } from "@/lib/wallet/manager";

export interface UsdcBalance {
  atomic: string;
}

export async function fetchUsdcBalance(address: string): Promise<UsdcBalance> {
  const wallet = getExternalWallet();
  if (!wallet) throw new Error("Wallet EVM indisponible");
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [address as `0x${string}`] });
  const result = await wallet.request({ method: "eth_call", params: [{ to: usdcAddress(), data }, "latest"] });
  if (typeof result !== "string") throw new Error("Solde USDC indisponible");
  const balance = decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: result as `0x${string}` });
  return { atomic: balance.toString() };
}
