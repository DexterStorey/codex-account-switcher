import { AccountService } from "./account-service";

export { AccountService } from "./account-service";
export {
  AccountNotFoundError,
  AuthFileMissingError,
  CodexAuthError,
  InvalidAccountNameError,
  LoginIncompleteError,
  NoAccountsSavedError,
  PromptCancelledError,
} from "./errors";

export const accountService = new AccountService();
