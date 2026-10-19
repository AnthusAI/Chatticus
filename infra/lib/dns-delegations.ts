export interface Delegation {
  name: string;
  nameServers: readonly string[];
}

/**
 * Names the management chattic.us zone hands to a zone in another account. Each
 * entry is the four name servers of a zone created by that environment's
 * zones stack (ChatticusEnvironmentZones for production, ChatticusEnvironmentZonesStaging for
 * staging and ChatticusEnvironmentZonesDevelopment for development, all in the
 * production account; their SiteNameServers and AuthNameServers outputs). The zones are retained, so these stay valid for the zone's life.
 */
export const DELEGATIONS: readonly Delegation[] = [
  {
    name: "develop.chattic.us",
    nameServers: [
      "ns-1039.awsdns-01.org",
      "ns-78.awsdns-09.com",
      "ns-1580.awsdns-05.co.uk",
      "ns-1018.awsdns-63.net",
    ],
  },
  {
    name: "auth-develop.chattic.us",
    nameServers: [
      "ns-1690.awsdns-19.co.uk",
      "ns-1520.awsdns-62.org",
      "ns-270.awsdns-33.com",
      "ns-963.awsdns-56.net",
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
