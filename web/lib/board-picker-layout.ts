/** Where the list of boards sits: beside the board, or in a bottom sheet that the Boards button opens. */
export type BoardPickerLayout = "side" | "sheet";

/** The narrowest Board panel, in points, that has the list beside the board: the list is 256 points wide and the board keeps at least 464. */
export const BOARD_PICKER_SIDE_MINIMUM_PANEL_WIDTH = 720;

/**
 * The layout for a Board panel of a given width. The list sits beside the board where the panel is wide enough for both (a
 * panel that fills an iPad held sideways or a desktop window). In a narrower panel, such as the one docked beside the
 * conversation on an iPad or the whole screen of a phone, the list is a bottom sheet. The width is the panel's own, not
 * the screen's, because a docked panel on a wide screen is still narrow.
 *
 * @param panelWidth The width of the Board panel in points.
 * @returns The layout to use.
 */
export function boardPickerLayoutFor(panelWidth: number): BoardPickerLayout {
  return panelWidth >= BOARD_PICKER_SIDE_MINIMUM_PANEL_WIDTH ? "side" : "sheet";
}
