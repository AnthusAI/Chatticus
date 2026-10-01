export interface Delegation {
  name: string;
  nameServers: readonly string[];
}

/**
 * Names the management chattic.us zone hands to a zone in another account. Each
 * entry is the four name servers of a zone created by that account's
 * ChatticusEnvironmentZones stack (its SiteNameServers and AuthNameServers
 * outputs). The zones are retained, so these stay valid for the zone's life.
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
];
