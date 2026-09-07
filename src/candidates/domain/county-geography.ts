// These independent cities share their base name with a county in the same
// state. Preserve county URLs and give each city its own FIPS-backed route.
const overlappingCityFips = new Set(["24510", "29510", "51600", "51620", "51760", "51770"]);

export function countySlug(name: string, fips: string) {
  const base = name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return overlappingCityFips.has(fips) ? `${base}-city` : base;
}

export function countyDisplayName(name: string, stateSlug: string, fips: string) {
  if (stateSlug === "louisiana") return `${name} Parish`;
  if (overlappingCityFips.has(fips) || (stateSlug === "virginia" && Number(fips.slice(2)) >= 500)) return `${name} City`;
  return `${name} County`;
}
