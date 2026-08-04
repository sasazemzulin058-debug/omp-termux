/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Internal interface.
 */
export class MultiMetricStorage {
    _backingStorages;
    constructor(backingStorages) {
        this._backingStorages = backingStorages;
    }
    record(value, attributes, context, recordTime) {
        const storages = this._backingStorages;
        for (let i = 0; i < storages.length; i++) {
            storages[i].record(value, attributes, context, recordTime);
        }
    }
}
//# sourceMappingURL=MultiWritableMetricStorage.js.map