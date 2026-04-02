export declare function getName<T extends { name: string }>(item: T): string;
export declare function stringify<T extends { toString(): string }>(value: T): string;
export declare function pick<T extends Record<string, unknown>, K extends keyof T>(obj: T, key: K): T[K];
export declare function unconstrained<T>(value: T): T;
export declare function mixedConstraints<T, U extends Array<T>>(item: T, container: U): U;
