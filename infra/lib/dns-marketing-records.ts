import type { ExportedRecordSet } from "./management-dns-stack";

function cname(name: string, value: string): ExportedRecordSet {
  return { Name: `${name}.`, Type: "CNAME", TTL: 300, ResourceRecords: [{ Value: value }] };
}

/**
 * Records the marketing site's own account (ChatticusMarketing, in the
 * production account) needs inside the management chattic.us zone: the three
 * SES Easy DKIM CNAMEs of its chattic.us sending identity (stack outputs
 * SesDkimRecord1Name through SesDkimRecord3Value), a DMARC policy, and the two
 * ACM DNS validation CNAMEs of the certificate for chattic.us and
 * www.chattic.us. None of these route traffic. They are merged with the local
 * zone export when ChatticusManagementDns is deployed.
 */
export const MARKETING_SES_AND_CERTIFICATE_RECORDS: readonly ExportedRecordSet[] = [
  cname(
    "u7nsyzktmdpqnkfq32q5jdzdk3m3zygt._domainkey.chattic.us",
    "u7nsyzktmdpqnkfq32q5jdzdk3m3zygt.dkim.amazonses.com",
  ),
  cname(
    "474nu46pmgspoqgicut35i536g5mtlib._domainkey.chattic.us",
    "474nu46pmgspoqgicut35i536g5mtlib.dkim.amazonses.com",
  ),
  cname(
    "66zhdvo6v6mzfz73a2oax6ah53b5cckk._domainkey.chattic.us",
    "66zhdvo6v6mzfz73a2oax6ah53b5cckk.dkim.amazonses.com",
  ),
  {
    Name: "_dmarc.chattic.us.",
    Type: "TXT",
    TTL: 300,
    ResourceRecords: [{ Value: '"v=DMARC1; p=none; rua=mailto:dmarc@chattic.us"' }],
  },
  cname(
    "_28652e71c2fe9bff2134ff3fff181a9b.chattic.us",
    "_08c1caecddd6fbb7f5948be064be87d2.wzccmgtwzk.acm-validations.aws.",
  ),
  cname(
    "_08c4e1db2ee16b41ae42ab5afed886a1.www.chattic.us",
    "_471554f27fa4a1d8ce7acaa712a4dd4b.wzccmgtwzk.acm-validations.aws.",
  ),
];
