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
  {
    name: "staging.chattic.us",
    nameServers: [
      "ns-1504.awsdns-60.org",
      "ns-1770.awsdns-29.co.uk",
      "ns-851.awsdns-42.net",
      "ns-478.awsdns-59.com",
    ],
  },
  {
    name: "auth-staging.chattic.us",
    nameServers: [
      "ns-1926.awsdns-48.co.uk",
      "ns-475.awsdns-59.com",
      "ns-1227.awsdns-25.org",
      "ns-777.awsdns-33.net",
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
