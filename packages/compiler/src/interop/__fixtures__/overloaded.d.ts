export declare function format(value: string): string;
export declare function format(value: number): string;
export declare function format(value: boolean): string;

export declare function create(): void;
export declare function create(name: string): void;

// Generic overloads: last generic overload should be preferred
export declare function parse<T>(input: string, type: "json"): T;
export declare function parse(input: string): string;
