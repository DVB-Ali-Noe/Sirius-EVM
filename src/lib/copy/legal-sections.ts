/** Ancre d'une section des pages légales, tirée de son titre (« Who is responsible » → « who-is-responsible »). */
export function legalSectionId(title: string): string {
  return title.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
