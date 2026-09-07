import { getCountyByState } from "@nickgraffis/us-counties";
import { getStateBySlug } from "./states";
import { countySlug, countyDisplayName } from "./county-geography";

type Geography = { stateSlug: string; countySlug?: string; countyName?: string };
const countiesByState = new Map<string, Map<string, string>>();

export function geographyIssue(value: Geography): string | undefined {
  const state = getStateBySlug(value.stateSlug);
  if (!state || state.slug !== value.stateSlug) return "Choose a valid state using its full state slug.";
  if (!value.countySlug) return value.countyName ? "A county name requires a county selection." : undefined;
  let counties = countiesByState.get(state.slug);
  if (!counties) {
    counties = new Map(getCountyByState(state.name).map((county) => [countySlug(county.name, county.FIPS), countyDisplayName(county.name, state.slug, county.FIPS)]));
    countiesByState.set(state.slug, counties);
  }
  const name = counties.get(value.countySlug);
  if (!name) return "The selected county does not belong to this state.";
  if (value.countyName && value.countyName !== name) return "The county name does not match the selected county.";
}
