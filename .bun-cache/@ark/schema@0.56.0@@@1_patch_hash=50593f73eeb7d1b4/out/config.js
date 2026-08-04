import { isNodeKind } from "./shared/implement.js";
import { $ark } from "./shared/registry.js";
import { ToJsonSchema } from "./shared/toJsonSchema.js";
// $ark.config could already be set if it were imported previously from the
// dedicated config entrypoint, in which case we don't want to reinitialize it
$ark.config ??= {};
export const configureSchema = (config) => {
    const result = Object.assign($ark.config, mergeConfigs($ark.config, config));
    if ($ark.resolvedConfig)
        $ark.resolvedConfig = mergeConfigs($ark.resolvedConfig, result);
    return result;
};
export const mergeConfigs = (base, merged) => {
    if (!merged)
        return base;
    const result = { ...base };
    let k;
    for (k in merged) {
        const keywords = { ...base.keywords };
        if (k === "keywords") {
            for (const flatAlias in merged[k]) {
                const v = merged.keywords[flatAlias];
                if (v === undefined)
                    continue;
                keywords[flatAlias] = typeof v === "string" ? { description: v } : v;
            }
            result.keywords = keywords;
        }
        else if (k === "toJsonSchema") {
            result[k] = mergeToJsonSchemaConfigs(base.toJsonSchema, merged.toJsonSchema);
        }
        else if (isNodeKind(k)) {
            result[k] =
                // not casting this makes TS compute a very inefficient
                // type that is not needed
                {
                    ...base[k],
                    ...merged[k]
                };
        }
        else
            result[k] = merged[k];
    }
    return result;
};
const jsonSchemaTargetToDialect = {
    "draft-2020-12": "https://json-schema.org/draft/2020-12/schema",
    "draft-07": "http://json-schema.org/draft-07/schema#"
};
export const mergeToJsonSchemaConfigs = ((baseConfig, mergedConfig) => {
    if (!baseConfig)
        return resolveTargetToDialect(mergedConfig ?? {}, undefined);
    if (!mergedConfig)
        return baseConfig;
    const result = { ...baseConfig };
    let k;
    for (k in mergedConfig) {
        if (k === "fallback") {
            result.fallback = mergeFallbacks(baseConfig.fallback, mergedConfig.fallback);
        }
        else
            result[k] = mergedConfig[k];
    }
    return resolveTargetToDialect(result, mergedConfig);
});
const resolveTargetToDialect = (opts, userOpts) => {
    // If user explicitly provided a dialect, use it
    // Otherwise, if user provided a target, resolve it to dialect
    // If neither, use the default dialect from opts
    if (userOpts?.dialect !== undefined)
        return opts; // dialect was already merged
    if (userOpts?.target !== undefined) {
        return {
            ...opts,
            dialect: jsonSchemaTargetToDialect[userOpts.target]
        };
    }
    return opts;
};
const mergeFallbacks = (base, merged) => {
    base = normalizeFallback(base);
    merged = normalizeFallback(merged);
    const result = {};
    let code;
    for (code in ToJsonSchema.defaultConfig.fallback) {
        result[code] =
            merged[code] ??
                merged.default ??
                base[code] ??
                base.default ??
                ToJsonSchema.defaultConfig.fallback[code];
    }
    return result;
};
const normalizeFallback = (fallback) => typeof fallback === "function" ? { default: fallback } : (fallback ?? {});
