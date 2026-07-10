import { Command } from "@oclif/core";

export abstract class BaseCommand extends Command {
  protected async runSafe(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (error instanceof Error) {
        this.error(error.message);
      }
      throw error;
    }
  }
}
