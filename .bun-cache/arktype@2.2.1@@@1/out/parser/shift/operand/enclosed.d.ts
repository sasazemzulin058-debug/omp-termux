import { type ErrorMessage, type Scanner } from "@ark/util";
import type { Regex, regex } from "arkregex";
import type { Out } from "../../../attributes.ts";
import type { InferredAst } from "../../ast/infer.ts";
import type { RuntimeState } from "../../reduce/dynamic.ts";
import type { StaticState, s } from "../../reduce/static.ts";
export type StringLiteral<contents extends string = string> = DoubleQuotedStringLiteral<contents> | SingleQuotedStringLiteral<contents>;
export type DoubleQuotedStringLiteral<contents extends string = string> = `"${contents}"`;
export type SingleQuotedStringLiteral<contents extends string = string> = `'${contents}'`;
export declare const parseEnclosed: (s: RuntimeState, enclosing: EnclosingStartToken) => void;
export type parseEnclosed<s extends StaticState, enclosingStart extends EnclosingStartToken, unscanned extends string> = Scanner.shiftUntilEscapable<unscanned, EnclosingTokens[enclosingStart], ""> extends Scanner.shiftResult<infer scanned, infer nextUnscanned> ? _parseEnclosed<s, enclosingStart, scanned, nextUnscanned> : never;
type _parseEnclosed<s extends StaticState, enclosingStart extends EnclosingStartToken, scanned extends string, nextUnscanned extends string, def extends string = `${enclosingStart}${scanned}${EnclosingTokens[enclosingStart]}`> = nextUnscanned extends "" ? s.error<writeUnterminatedEnclosedMessage<scanned, enclosingStart>> : enclosingStart extends EnclosingQuote ? s.setRoot<s, InferredAst<scanned, def>, nextUnscanned extends Scanner.shift<string, infer unscanned> ? unscanned : ""> : enclosingStart extends EnclosingRegexToken ? regex.parse<scanned> extends infer r ? r extends Regex ? s.setRoot<s, InferredAst<enclosingStart extends "/" ? r["infer"] : (In: r["infer"]) => Out<r["inferExecArray"]>, def>, nextUnscanned extends Scanner.shift<string, infer unscanned> ? unscanned : ""> : r extends ErrorMessage<infer e> ? s.error<e> : never : never : s.setRoot<s, InferredAst<Date, def>, nextUnscanned extends Scanner.shift<string, infer unscanned> ? unscanned : "">;
export declare const enclosingQuote: {
    readonly "'": 1;
    readonly '"': 1;
};
export type EnclosingQuote = keyof typeof enclosingQuote;
export declare const enclosingChar: {
    readonly "/": 1;
    readonly "'": 1;
    readonly '"': 1;
};
export declare const enclosingLiteralTokens: {
    readonly "d'": "'";
    readonly 'd"': "\"";
    readonly "'": "'";
    readonly '"': "\"";
};
export type EnclosingLiteralTokens = typeof enclosingLiteralTokens;
export type EnclosingLiteralStartToken = keyof EnclosingLiteralTokens;
export declare const enclosingRegexTokens: {
    readonly "/": "/";
    readonly "x/": "/";
};
export type EnclosingRegexTokens = typeof enclosingRegexTokens;
export type EnclosingRegexToken = keyof EnclosingRegexTokens;
export declare const enclosingTokens: {
    readonly "/": "/";
    readonly "x/": "/";
    readonly "d'": "'";
    readonly 'd"': "\"";
    readonly "'": "'";
    readonly '"': "\"";
};
export type EnclosingTokens = typeof enclosingTokens;
export type EnclosingStartToken = keyof EnclosingTokens;
export type EnclosingEndToken = EnclosingTokens[keyof EnclosingTokens];
export declare const untilLookaheadIsClosing: Record<EnclosingEndToken, Scanner.UntilCondition>;
declare const enclosingCharDescriptions: {
    readonly '"': "double-quote";
    readonly "'": "single-quote";
    readonly "/": "forward slash";
};
type enclosingCharDescriptions = typeof enclosingCharDescriptions;
export declare const writeUnterminatedEnclosedMessage: <fragment extends string, enclosingStart extends EnclosingStartToken>(fragment: fragment, enclosingStart: enclosingStart) => writeUnterminatedEnclosedMessage<fragment, enclosingStart>;
export type writeUnterminatedEnclosedMessage<fragment extends string, enclosingStart extends EnclosingStartToken> = `${enclosingStart}${fragment} requires a closing ${enclosingCharDescriptions[EnclosingTokens[enclosingStart]]}`;
export {};
