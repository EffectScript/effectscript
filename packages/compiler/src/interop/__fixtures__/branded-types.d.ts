// Branded intersection types
export type UserId = string & { __brand: "UserId" };
export type Timestamp = number & { __timestamp: true };
export declare const userId: UserId;
export declare const timestamp: Timestamp;

// Non-branded intersection (real fields, not brand-like)
export type Extended = { name: string } & { age: number };
export declare const person: Extended;
