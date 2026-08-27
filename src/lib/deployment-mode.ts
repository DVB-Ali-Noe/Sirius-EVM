/**
 * Mode de déploiement de l'instance.
 *
 * Une instance « démonstration » est construite comme la production mais servie sur
 * un réseau de test, sans enclave attestée. Elle existe parce que `NODE_ENV` ne dit
 * qu'une chose — le code est compilé pour être servi — là où plusieurs contrôles en
 * supposaient une autre : que l'instance EST le produit final, sur mainnet, derrière
 * un TEE dont les mesures sont épinglées.
 *
 * Le drapeau est une chaîne exacte plutôt qu'un booléen. Une variable laissée à « 1 »,
 * « true » ou « yes » par mégarde n'active donc rien, et le mode ne peut pas
 * s'enclencher par accident au détour d'une copie de configuration.
 *
 * Deux garde-fous vivent ailleurs et comptent autant que ce fichier :
 * `instrumentation-node.ts` refuse de démarrer si ce mode est actif sur mainnet, et
 * exige le testnet quand il l'est.
 */
export function isDemoDeployment(): boolean {
  return process.env.SIRIUS_DEPLOYMENT_MODE === "demo";
}
