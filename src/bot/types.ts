export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface SendMessageParams {
  chat_id: number;
  text: string;
  parse_mode?: "HTML" | "MarkdownV2";
  reply_markup?: InlineKeyboardMarkup;
  disable_web_page_preview?: boolean;
}

export interface EditMessageParams {
  chat_id: number;
  message_id: number;
  text: string;
  parse_mode?: "HTML" | "MarkdownV2";
  reply_markup?: InlineKeyboardMarkup;
  disable_web_page_preview?: boolean;
}

export interface AnswerCallbackParams {
  callback_query_id: string;
  text?: string;
  show_alert?: boolean;
}

export interface BotApi {
  sendMessage(params: SendMessageParams): Promise<TgMessage>;
  editMessageText(params: EditMessageParams): Promise<TgMessage | boolean>;
  answerCallbackQuery(params: AnswerCallbackParams): Promise<boolean>;
}
