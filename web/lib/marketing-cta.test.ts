import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { MARKETING_NAV_LINKS } from "./marketing-nav";

const marketingCtaComponents = [
  "components/Header.tsx",
  "components/Hero.tsx",
  "components/Footer.tsx",
  "components/FinalCta.tsx",
];

describe("marketing CTA links", () => {
  for (const relativePath of marketingCtaComponents) {
    it(`${relativePath} links to same-origin /chat`, () => {
      const source = fs.readFileSync(
        path.join(process.cwd(), relativePath),
        "utf8",
      );
      assert.doesNotMatch(source, /hey\.chattic\.us/);
      assert.match(source, /["']\/chat["']/);
    });
  }

  it("Header, Hero, and Footer label the /chat entry path Sign in", () => {
    for (const relativePath of [
      "components/Header.tsx",
      "components/Hero.tsx",
      "components/Footer.tsx",
    ]) {
      const source = fs.readFileSync(
        path.join(process.cwd(), relativePath),
        "utf8",
      );
      assert.match(source, /Sign in/);
      assert.doesNotMatch(source, /Hey, Chatticus/);
      assert.doesNotMatch(source, /Explore the workspace/);
    }
  });
});

describe("marketing navigation", () => {
  it("includes Pricing on the homepage", () => {
    const pricingLink = MARKETING_NAV_LINKS.find(
      (link) => link.label === "Pricing",
    );
    assert.ok(pricingLink);
    assert.equal(pricingLink.href, "/#pricing");
  });

  it("Header renders Pricing and delegates mobile links to MobileNav", () => {
    const header = fs.readFileSync(
      path.join(process.cwd(), "components/Header.tsx"),
      "utf8",
    );
    assert.match(header, /MARKETING_NAV_LINKS/);
    assert.match(header, /<MobileNav/);
  });

  it("DelegatedResponsibility anchors pricing on the homepage", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "components/DelegatedResponsibility.tsx"),
      "utf8",
    );
    assert.match(source, /id="pricing"/);
  });

  it("Footer shows beta status and legal links", () => {
    const footer = fs.readFileSync(
      path.join(process.cwd(), "components/Footer.tsx"),
      "utf8",
    );
    assert.match(footer, /Chatticus · Beta/);
    assert.doesNotMatch(footer, /Live in production/i);
    assert.match(footer, /href="\/privacy"/);
    assert.match(footer, /href="\/terms"/);
    assert.match(footer, /Support/);
  });

  it("MobileNav exposes an accessible menu toggle", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "components/MobileNav.tsx"),
      "utf8",
    );
    assert.match(source, /aria-expanded=\{open\}/);
    assert.match(source, /aria-controls=\{panelId\}/);
    assert.match(source, /MARKETING_NAV_LINKS/);
  });
});

describe("legal pages", () => {
  it("privacy and terms routes exist with beta copy", () => {
    for (const route of ["privacy", "terms"]) {
      const pageContent = fs.readFileSync(
        path.join(process.cwd(), "app", route, "page-content.ts"),
        "utf8",
      );
      assert.match(pageContent, /public beta/i);
      const page = fs.readFileSync(
        path.join(process.cwd(), "app", route, "page.tsx"),
        "utf8",
      );
      assert.match(page, /<Header \/>/);
      assert.match(page, /<Footer \/>/);
    }
  });
});
