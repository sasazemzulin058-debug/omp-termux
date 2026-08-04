import { NumericValue } from "@smithy/core/serde";
export function jsonReviver(key, value, context) {
    if (context?.source) {
        const numericString = context.source;
        if (typeof value === "number") {
            const inSafeRange = value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER;
            if (!inSafeRange || numericString !== String(value)) {
                if (inSafeRange && /[eE]/.test(numericString) && String(Number(numericString)) === String(value)) {
                    return value;
                }
                if (isFractionalNumeric(numericString)) {
                    return new NumericValue(numericString, "bigDecimal");
                }
                else {
                    if (/[eE]/.test(numericString)) {
                        return BigInt(Number(numericString));
                    }
                    return BigInt(numericString);
                }
            }
        }
    }
    return value;
}
function isFractionalNumeric(s) {
    const dotIndex = s.indexOf(".");
    if (dotIndex === -1) {
        return false;
    }
    const eIndex = s.search(/[eE]/);
    if (eIndex === -1) {
        return true;
    }
    const fracDigits = eIndex - dotIndex - 1;
    const exp = parseInt(s.slice(eIndex + 1), 10);
    return exp < fracDigits;
}
