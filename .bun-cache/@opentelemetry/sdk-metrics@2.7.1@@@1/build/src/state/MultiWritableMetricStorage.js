"use strict";
/*
 * Copyright The OpenTelemetry Authors
 * SPDX-License-Identifier: Apache-2.0
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiMetricStorage = void 0;
/**
 * Internal interface.
 */
class MultiMetricStorage {
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
exports.MultiMetricStorage = MultiMetricStorage;
//# sourceMappingURL=MultiWritableMetricStorage.js.map