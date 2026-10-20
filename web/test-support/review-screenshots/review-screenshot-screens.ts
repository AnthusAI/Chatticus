import type { Page } from "playwright";

/**
 * What a review gallery shows: each screen of the workspace, taken at every review viewport in light and dark.
 * A screen that has no meaning at a viewport (a sheet that only exists below the docked width) is skipped there
 * rather than shot in a misleading state.
 */

export type ReviewViewport = {
  id: string;
  label: string;
  width: number;
  height: number;
  isMobile: boolean;
};

export type ReviewColorScheme = "light" | "dark";

export type ReviewScreen = {
  id: string;
  label: string;
  signedIn: boolean;
  /** Puts the page in the state to shoot. Returns false when the screen does not exist at this viewport. */
  arrange: (page: Page) => Promise<boolean>;
};

export const REVIEW_VIEWPORTS: ReadonlyArray<ReviewViewport> = [
  { id: "desktop", label: "Desktop 1440", width: 1440, height: 900, isMobile: false },
  { id: "ipad-landscape", label: "iPad landscape", width: 1180, height: 820, isMobile: true },
  { id: "ipad-portrait", label: "iPad portrait", width: 820, height: 1180, isMobile: true },
  { id: "phone", label: "Phone", width: 390, height: 844, isMobile: true },
];

export const REVIEW_COLOR_SCHEMES: ReadonlyArray<ReviewColorScheme> = ["light", "dark"];

async function clickFirstVisible(page: Page, locator: ReturnType<Page["getByRole"]>): Promise<boolean> {
  const visible = locator.filter({ visible: true }).first();
  if ((await visible.count()) === 0) return false;
  await visible.click();
  return true;
}

async function openPlanningChannel(page: Page): Promise<void> {
  const planning = page.getByRole("button", { name: /Planning/ }).filter({ visible: true }).first();
  const openRoster = page.getByRole("button", { name: "Open bots and channels" }).filter({ visible: true }).first();
  await planning.or(openRoster).first().waitFor({ state: "visible" });
  if (!(await planning.isVisible())) await openRoster.click();
  await planning.waitFor({ state: "visible" });
  await planning.click();
  await page.getByText("All 128 tests pass", { exact: false }).filter({ visible: true }).first().waitFor({ state: "visible" });
}

async function openPanelPlugin(page: Page, pluginLabel: string): Promise<void> {
  await openPlanningChannel(page);
  const tab = page.getByRole("tab", { name: pluginLabel }).filter({ visible: true }).first();
  if ((await tab.count()) === 0) {
    await clickFirstVisible(page, page.getByRole("button", { name: "Open conversation inspector" }));
  }
  await tab.waitFor({ state: "visible" });
  await tab.click();
}

export const REVIEW_SCREENS: ReadonlyArray<ReviewScreen> = [
  {
    id: "sign-in",
    label: "Sign in",
    signedIn: false,
    arrange: async (page) => {
      await page.getByRole("button").filter({ visible: true }).first().waitFor({ state: "visible" });
      return true;
    },
  },
  {
    id: "conversation",
    label: "Conversation",
    signedIn: true,
    arrange: async (page) => {
      await openPlanningChannel(page);
      return true;
    },
  },
  {
    id: "roster-sheet",
    label: "Bots and channels sheet",
    signedIn: true,
    arrange: async (page) => {
      await openPlanningChannel(page);
      return clickFirstVisible(page, page.getByRole("button", { name: "Open bots and channels" }));
    },
  },
  {
    id: "panel-files",
    label: "Files panel",
    signedIn: true,
    arrange: async (page) => {
      await openPanelPlugin(page, "Files");
      await page.getByText("README.md").filter({ visible: true }).first().waitFor({ state: "visible" });
      return true;
    },
  },
  {
    id: "panel-board",
    label: "Board panel",
    signedIn: true,
    arrange: async (page) => {
      await openPanelPlugin(page, "Board");
      await page.getByTestId("kanbus-board").filter({ visible: true }).first().waitFor({ state: "visible" });
      return true;
    },
  },
  {
    id: "panel-board-full",
    label: "Board panel, full screen",
    signedIn: true,
    arrange: async (page) => {
      await openPanelPlugin(page, "Board");
      const fillsWorkspace = await clickFirstVisible(page, page.getByRole("button", { name: "Full", exact: true }));
      if (!fillsWorkspace) return false;
      await page.getByTestId("kanbus-board").filter({ visible: true }).first().waitFor({ state: "visible" });
      return true;
    },
  },
  {
    id: "panel-costs",
    label: "Costs panel",
    signedIn: true,
    arrange: async (page) => {
      await openPanelPlugin(page, "Costs");
      await page.getByTestId("cost-summary").filter({ visible: true }).first().waitFor({ state: "visible" });
      return true;
    },
  },
  {
    id: "panel-costs-full",
    label: "Costs panel, full screen",
    signedIn: true,
    arrange: async (page) => {
      await openPanelPlugin(page, "Costs");
      const fillsWorkspace = await clickFirstVisible(page, page.getByRole("button", { name: "Full", exact: true }));
      if (!fillsWorkspace) return false;
      await page.getByTestId("cost-summary").filter({ visible: true }).first().waitFor({ state: "visible" });
      return true;
    },
  },
];

/** The file name a shot is stored under, the same on the base and the head side. */
export function reviewShotFileName(screenId: string, viewportId: string, colorScheme: ReviewColorScheme): string {
  return `${screenId}--${viewportId}--${colorScheme}.png`;
}
