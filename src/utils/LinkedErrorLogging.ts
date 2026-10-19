import {sharedState} from './sharedState.js';

export interface IErrorLogger {
  log?(error: any): Promise<void>;
}

/** The logger, shared so one set through any copy of core (e.g. by `@_linked/sentry`) logs for all. */
const loggingState = sharedState('@_linked/core', 'LinkedErrorLogging', () => ({
  logger: undefined as IErrorLogger | undefined,
}));

/**
 * Utility class to log errors.
 * Install any error client package like lincd-sentry in your app to log errors.
 */
export class LinkedErrorLogging {
  private static get logger(): IErrorLogger | undefined {
    return loggingState.logger;
  }
  private static set logger(logger: IErrorLogger | undefined) {
    loggingState.logger = logger;
  }

  static setDefaultLogger(logger: IErrorLogger) {
    this.logger = logger;
  }

  static hasDefaultLogger() {
    return this.logger && true;
  }

  static log(error: Error) {
    if (this.logger) {
      return this.logger.log(error);
    }
  }
}
