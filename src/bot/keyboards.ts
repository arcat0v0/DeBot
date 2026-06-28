import { chunk } from "../shared/util.ts";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./types.ts";

export function button(text: string, data: string): InlineKeyboardButton {
  return { text, callback_data: data };
}

export function keyboard(rows: InlineKeyboardButton[][]): InlineKeyboardMarkup {
  return { inline_keyboard: rows };
}

export function gridFromButtons(
  buttons: InlineKeyboardButton[],
  perRow = 2,
): InlineKeyboardButton[][] {
  return chunk(buttons, perRow);
}
