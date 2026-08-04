import type { Logger as ILogger, LogRecord } from '@opentelemetry/api-logs';
import { SeverityNumber } from '@opentelemetry/api-logs';
import type { InstrumentationScope } from '@opentelemetry/core';
import type { Context } from '@opentelemetry/api';
import type { LoggerProviderSharedState } from './internal/LoggerProviderSharedState';
export declare class Logger implements ILogger {
    readonly instrumentationScope: InstrumentationScope;
    private _sharedState;
    private readonly _loggerConfig;
    constructor(instrumentationScope: InstrumentationScope, sharedState: LoggerProviderSharedState);
    emit(logRecord: LogRecord): void;
    enabled(options?: {
        context?: Context;
        severityNumber?: SeverityNumber;
        eventName?: string;
    }): boolean;
}
//# sourceMappingURL=Logger.d.ts.map