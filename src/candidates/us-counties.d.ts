declare module "@nickgraffis/us-counties" {
  export function getCountyByState(state: string): Array<{ FIPS: string; name: string; state: string }>;
}
