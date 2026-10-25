/** Where the list of boards sits: beside the board, or in a bottom sheet that the Boards button opens. */
export type BoardPickerLayout = "side" | "sheet";

/** The narrowest screen, in points, that has the list beside the board (an iPad held sideways is 1024 points wide or more). */
export const BOARD_PICKER_SIDE_MINIMUM_WIDTH = 1024;

/**
 * The layout for a screen. The list sits beside the board on a screen that is wide enough and wider than it is tall (an iPad
 * held sideways, a laptop, a desktop). An iPad held upright and anything narrower, down to a phone, use the bottom sheet.
 *
 * @param width The width of the screen in points.
 * @param height The height of the screen in points.
 * @returns The layout to use.
 */
export function boardPickerLayoutFor(width: number, height: number): BoardPickerLayout {
  return width >= BOARD_PICKER_SIDE_MINIMUM_WIDTH && width > height ? "side" : "sheet";
}
