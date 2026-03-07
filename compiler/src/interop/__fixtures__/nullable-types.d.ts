export declare function findItem(id: number): string | null;
export declare function maybeNumber(): number | undefined;
export declare function bothNullish(): string | null | undefined;
export declare function multiUnionNull(): number | string | null;

export interface Config {
  host: string;
  port?: number;
  timeout?: number;
}

export declare function createConfig(options: Config): Config;
