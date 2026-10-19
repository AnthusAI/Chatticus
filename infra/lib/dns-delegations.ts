export interface Delegation {
  name: string;
  nameServers: readonly string[];
}

/**
 * Names the management chattic.us zone hands to a zone in another account. Each
 * entry is the four name servers of a zone created by that environment's
 * zones stack (the SiteNameServers and AuthNameServers outputs of
 * ChatticusEnvironmentZonesDevelopment, ChatticusEnvironmentZonesStaging and
 * ChatticusEnvironmentZones, all in the production account). The zones are
 * retained, so these stay valid for the zone's life.
 *
 * The develop.chattic.us and auth-develop.chattic.us entries still hold the name
 * servers of the retired development account. They must be replaced with the
 * outputs of ChatticusEnvironmentZonesDevelopment once that stack exists, in a
 * separate change that is deployed through ChatticusManagementDns before the
 * development stacks can validate their certificates.
 */
export const DELEGATIONS: readonly Delegation[] = [
  {
    name: "develop.chattic.us",
    nameServers: [
      "ns-751.awsdns-29.net",
      "ns-1930.awsdns-49.co.uk",
      "ns-217.awsdns-27.com",
      "ns-1515.awsdns-61.org",
    ],
  },
  {
    name: "auth-develop.chattic.us",
    nameServers: [
      "ns-187.awsdns-23.com",
      "ns-625.awsdns-14.net",
      "ns-1142.awsdns-14.org",
      "ns-1909.awsdns-46.co.uk",
    ],
  },
  {
    name: "staging.chattic.us",
    nameServers: [
      "ns-140.awsdns-17.com",
      "ns-1188.awsdns-20.org",
      "ns-667.awsdns-19.net",
      "ns-1950.awsdns-51.co.uk",
    ],
  },
  {
    name: "auth-staging.chattic.us",
    nameServers: [
      "ns-1711.awsdns-21.co.uk",
      "ns-686.awsdns-21.net",
      "ns-1516.awsdns-61.org",
      "ns-64.awsdns-08.com",
    ],
  },
  {
    name: "hey.chattic.us",
    nameServers: [
      "ns-801.awsdns-36.net",
      "ns-103.awsdns-12.com",
      "ns-1753.awsdns-27.co.uk",
      "ns-1404.awsdns-47.org",
    ],
  },
  {
    name: "auth.chattic.us",
    nameServers: [
      "ns-1969.awsdns-54.co.uk",
      "ns-254.awsdns-31.com",
      "ns-693.awsdns-22.net",
      "ns-1067.awsdns-05.org",
    ],
  },
];
