import "server-only";
import { formatTokenAmount } from "@/components/datasets/price";
import { publishedTariff } from "@/lib/datasets/tariff-server";
import { resolveServerNetwork } from "@/lib/evm/networks";
import { stablecoinSymbol } from "@/lib/evm/stablecoin";
import { createCatalogueSnapshotCache, loadCatalogue } from "@/lib/marketplace/catalogue";
import { DEFAULT_MARKETPLACE_QUERY, foldSearchText, MAX_SEARCH_TERMS } from "@/lib/marketplace/query";
import { marketplaceDeps } from "@/lib/marketplace/server";
import { MODEL_REGISTRY, type ModelId } from "@/lib/models/registry";
import type { AssistantToolSource, ListDatasetsInput, ProtocolStatusSummary } from "./tools";

/**
 * Sources réelles des outils de Sirio : le catalogue public (même lecture, même cache court que
 * `GET /api/marketplace`) et l'état du protocole lu dans la configuration du serveur (mêmes
 * champs que la page /status : réseau, plafonds, tarif, contrats). Aucune session n'est lue :
 * la réponse est la même pour tous les visiteurs.
 */

const snapshot = createCatalogueSnapshotCache();

function protocolStatus(): ProtocolStatusSummary {
  const { network, chain } = resolveServerNetwork();
  const mainnet = network === "mainnet";
  const symbol = stablecoinSymbol(network);
  const enclave = process.env.TEE_MODE === "phala" && process.env.SIRIUS_REQUIRE_PHALA === "true" && Boolean(process.env.SIRIUS_EXPECTED_MRTD);
  const maxLoan = process.env.SIRIUS_MAX_LOAN_USDC?.trim() || null;
  const maxExposure = process.env.SIRIUS_MAX_EXPOSURE_USDC?.trim() || null;
  const tariff = publishedTariff();
  const amount = (atomic: string) => `${formatTokenAmount(atomic, tariff?.decimals ?? 6) ?? atomic} ${symbol}`;
  return {
    network,
    chain: { name: chain.name, id: chain.id },
    settlementToken: mainnet ? `${symbol} (Global Dollar, issued by Paxos)` : `${symbol} (valueless test token)`,
    confidentialCompute: enclave
      ? "Hardware enclave (Intel TDX), attested on every request against pinned measurements"
      : "Demonstration mode: training is not yet isolated in an enclave on this instance",
    settlement: "On-chain escrow: the provider is paid when training completes; the borrower is refunded after the deadline otherwise",
    externalAudit: "Not yet audited. Internal review completed on 1 October 2026.",
    limits: {
      perLoan: mainnet ? (maxLoan ? `${maxLoan} ${symbol}` : null) : null,
      totalExposure: mainnet ? (maxExposure ? `${maxExposure} ${symbol} locked across all loans` : null) : null,
    },
    tariff: tariff
      ? {
        version: tariff.version,
        computeFeeByProfile: Object.fromEntries(
          (Object.keys(tariff.computeFeeAtomic) as ModelId[]).map((id) => [MODEL_REGISTRY[id].label, amount(tariff.computeFeeAtomic[id])]),
        ),
        minimumProviderPrice: amount(tariff.minimumProviderAtomic),
      }
      : null,
    contracts: {
      escrow: process.env.SIRIUS_ESCROW_ADDRESS ?? null,
      datasetRegistry: process.env.SIRIUS_DATASET_ADDRESS ?? null,
      kybRegistry: process.env.SIRIUS_KYB_ADDRESS ?? null,
      [symbol]: process.env.SIRIUS_USDC_ADDRESS ?? null,
    },
    pages: { status: "/status", marketplace: "/marketplace" },
  };
}

/** Catalogue filtré comme la page : termes repliés, catégorie, tri par date, première page. */
async function catalogue(input: ListDatasetsInput) {
  const terms = input.search ? foldSearchText(input.search).split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS) : [];
  const deps = marketplaceDeps();
  return loadCatalogue({ ...DEFAULT_MARKETPLACE_QUERY, terms, category: input.category }, deps, snapshot);
}

export function assistantToolSource(): AssistantToolSource {
  return { catalogue, status: protocolStatus };
}
