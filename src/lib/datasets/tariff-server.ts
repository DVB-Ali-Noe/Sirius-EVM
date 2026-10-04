import "server-only";
import { billingEnabled, billingPolicy } from "@/lib/billing/config";
import { usdcAddress } from "@/lib/evm/addresses";
import { resolveServerNetwork } from "@/lib/evm/networks";
import { MIN_PRICE_USDC_ATOMIC, USDC_DECIMALS } from "@/lib/evm/usdc";
import { legacyTariff, tariffFromPolicy, type PublishedTariff } from "./tariff";

/**
 * Tarif en vigueur lu côté serveur, pour la page d'upload.
 *
 * La politique de facturation (`RUNNER_BILLING_POLICY_FILE`, format `BillingPolicy`) est
 * celle que le runner utilise pour signer les devis ; l'instance Next doit en recevoir la
 * même copie pour afficher les mêmes frais. Sans fichier, fichier périmé ou visant un autre
 * réseau, la page annonce un tarif indisponible plutôt qu'un montant inventé : la
 * publication reste possible, le devis réel étant de toute façon signé par l'enclave au
 * moment de l'emprunt.
 */
export function publishedTariff(): PublishedTariff | null {
  try {
    const minimum = MIN_PRICE_USDC_ATOMIC.toString();
    if (!billingEnabled()) return legacyTariff(USDC_DECIMALS, minimum);
    return tariffFromPolicy(billingPolicy(), {
      chainId: resolveServerNetwork().chain.id,
      usdc: usdcAddress().toLowerCase(),
      decimals: USDC_DECIMALS,
      minimumProviderAtomic: minimum,
    });
  } catch (error) {
    // Seule la classe est journalisée : le message pourrait citer un chemin de fichier.
    console.error(`[upload] tarif indisponible (${error instanceof Error ? error.name : typeof error})`);
    return null;
  }
}
