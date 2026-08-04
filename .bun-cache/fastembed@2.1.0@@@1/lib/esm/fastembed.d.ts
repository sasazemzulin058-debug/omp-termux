/// <reference types="node" />
import fs from "fs";
export declare enum ExecutionProvider {
    CPU = "cpu",
    CUDA = "cuda",
    WebGL = "webgl",
    WASM = "wasm",
    XNNPACK = "xnnpack"
}
export declare enum EmbeddingModel {
    AllMiniLML6V2 = "fast-all-MiniLM-L6-v2",
    BGEBaseEN = "fast-bge-base-en",
    BGEBaseENV15 = "fast-bge-base-en-v1.5",
    BGESmallEN = "fast-bge-small-en",
    BGESmallENV15 = "fast-bge-small-en-v1.5",
    BGESmallZH = "fast-bge-small-zh-v1.5",
    MLE5Large = "fast-multilingual-e5-large",
    CUSTOM = "custom"
}
export declare enum SparseEmbeddingModel {
    SpladePPEnV1 = "prithivida/Splade_PP_en_v1",
    CUSTOM = "custom"
}
export type SparseVector = {
    values: number[];
    indices: number[];
};
export interface InitOptionsBase {
    executionProviders?: ExecutionProvider[];
    maxLength?: number;
    cacheDir?: string;
    showDownloadProgress?: boolean;
}
interface ModelInfo {
    model: EmbeddingModel;
    dim: number;
    description: string;
}
interface SparseModelInfo {
    model: SparseEmbeddingModel;
    vocabSize: number;
    description: string;
}
export interface InitStandardOptions extends InitOptionsBase {
    model: Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>;
    modelAbsoluteDirPath?: undefined;
    modelName?: string;
}
export interface InitCustomOptions extends InitOptionsBase {
    model: EmbeddingModel.CUSTOM;
    modelAbsoluteDirPath: fs.PathLike;
    modelName: string;
}
export type InitOptions = InitStandardOptions | InitCustomOptions;
export interface InitSparseStandardOptions extends InitOptionsBase {
    model: Exclude<SparseEmbeddingModel, SparseEmbeddingModel.CUSTOM>;
    modelAbsoluteDirPath?: undefined;
    modelName?: string;
}
export interface InitSparseCustomOptions extends InitOptionsBase {
    model: SparseEmbeddingModel.CUSTOM;
    modelAbsoluteDirPath: fs.PathLike;
    modelName: string;
}
export type InitSparseOptions = InitSparseStandardOptions | InitSparseCustomOptions;
declare abstract class Embedding {
    abstract listSupportedModels(): ModelInfo[];
    abstract embed(texts: string[], batchSize?: number): AsyncGenerator<number[][], void, unknown>;
    abstract passageEmbed(texts: string[], batchSize: number): AsyncGenerator<number[][], void, unknown>;
    abstract queryEmbed(query: string): Promise<number[]>;
}
declare abstract class SparseEmbedding {
    abstract listSupportedModels(): SparseModelInfo[];
    abstract embed(texts: string[], batchSize?: number): AsyncGenerator<SparseVector[], void, unknown>;
    abstract passageEmbed(texts: string[], batchSize: number): AsyncGenerator<SparseVector[], void, unknown>;
    abstract queryEmbed(query: string): Promise<SparseVector>;
}
export declare class FlagEmbedding extends Embedding {
    private tokenizer;
    private session;
    private model;
    private constructor();
    static init(options: InitStandardOptions): Promise<FlagEmbedding>;
    static init(options: InitCustomOptions): Promise<FlagEmbedding>;
    private static loadTokenizer;
    private static downloadFileFromGCS;
    private static decompressToCache;
    private static retrieveModel;
    embed(textStrings: string[], batchSize?: number): AsyncGenerator<number[][], void, unknown>;
    passageEmbed(texts: string[], batchSize?: number): AsyncGenerator<number[][], void, unknown>;
    queryEmbed(query: string): Promise<number[]>;
    listSupportedModels(): ModelInfo[];
}
export declare class SparseTextEmbedding extends SparseEmbedding {
    private tokenizer;
    private session;
    private model;
    private vocabSize;
    private constructor();
    static init(options: InitSparseStandardOptions): Promise<SparseTextEmbedding>;
    static init(options: InitSparseCustomOptions): Promise<SparseTextEmbedding>;
    private static loadTokenizer;
    private static retrieveModel;
    embed(textStrings: string[], batchSize?: number): AsyncGenerator<SparseVector[], void, unknown>;
    passageEmbed(texts: string[], batchSize?: number): AsyncGenerator<SparseVector[], void, unknown>;
    queryEmbed(query: string): Promise<SparseVector>;
    listSupportedModels(): SparseModelInfo[];
}
export {};
//# sourceMappingURL=fastembed.d.ts.map