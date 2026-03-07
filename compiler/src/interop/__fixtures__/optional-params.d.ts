// Optional parameter (TS optional → undefined)
export declare function greet(name: string, greeting?: string): string;

// Explicit null parameter
export declare function setLabel(label: string | null): void;

// Explicit undefined parameter
export declare function clearValue(value: string | undefined): void;

// Both null and undefined
export declare function flexible(value: string | null | undefined): void;

// No nullability
export declare function required(value: string): void;

// Multiple params with mixed null-kinds
export declare function mixed(a: string, b?: number, c: string | null): void;
