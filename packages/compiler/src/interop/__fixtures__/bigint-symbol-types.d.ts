// Fixture for testing bigint and symbol type mapping

export declare const bigValue: bigint;
export declare const symValue: symbol;
export declare const uniqueSym: unique symbol;
export declare const bigLiteral: 100n;
export declare const nullableBig: bigint | null;
export declare const nullableSym: symbol | undefined;
export declare function convertBigint(x: bigint): symbol;
