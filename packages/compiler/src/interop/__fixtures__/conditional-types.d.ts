// Fixture for conditional type evaluation tests

// Concrete conditionals (TS resolves these at declaration time)
export type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any;
export type ExtractedReturn = ReturnType<(x: number) => string>;

export type NonNullable<T> = T extends null | undefined ? never : T;
export type SafeString = NonNullable<string | null>;
export type SafeNumber = NonNullable<number | undefined>;
export type SafeUnion = NonNullable<string | null | number | undefined>;

// Distributive conditionals
export type Extract<T, U> = T extends U ? T : never;
export type ExtractStrings = Extract<string | number | boolean, string | number>;

export type Exclude<T, U> = T extends U ? never : T;
export type ExcludeStrings = Exclude<string | number | boolean, string>;

// Conditional with 'any' check type
export type AnyConditional = (any extends string ? "yes" : "no");

// Abstract conditional types (T not yet known)
export type IsString<T> = T extends string ? "yes" : "no";
export type UnpackPromise<T> = T extends Promise<infer U> ? U : T;

// Conditional in function return position
export declare function getStringOrNumber<T>(value: T): T extends string ? number : boolean;

// Nested conditional
export type Nested<T> = T extends string ? "string" : T extends number ? "number" : "other";

// Conditional with object check type
export type HasName<T> = T extends { name: string } ? true : false;

// Concrete instantiation of abstract conditional via type alias
export type ConcreteResult = IsString<string>;  // should be "yes"
export type ConcreteResult2 = IsString<number>;  // should be "no"

// Conditional producing complex types (not just primitives)
export type UnwrapArray<T> = T extends Array<infer U> ? U : T;
export type UnwrappedStrings = UnwrapArray<string[]>;  // string
export type UnwrappedNumber = UnwrapArray<number>;  // number (identity)

// Conditional with never result
export type OnlyStrings<T> = T extends string ? T : never;
export type FilteredUnion = OnlyStrings<string | number | boolean>;  // string

// Conditional that evaluates to never entirely
export type NeverResult = Extract<boolean, string>;  // never (boolean is not assignable to string)

// Awaited (common real-world conditional with infer and recursion -- single-level unwrap)
// Note: this is intentionally non-recursive (unlike TS's built-in Awaited<T>)
export type MySingleUnwrap<T> =
  T extends null | undefined ? T :
  T extends object & { then(onfulfilled: infer F, ...args: infer _): any } ?
    F extends ((value: infer V, ...args: infer _) => any) ? V : never :
  T;
export type ResolvedPromise = MySingleUnwrap<Promise<string>>;  // string
export type ResolvedNested = MySingleUnwrap<Promise<Promise<number>>>;  // Promise<number> (single unwrap, not recursive)

// Conditional in intersection position (test 19)
export type WithConditional<T> = { name: string } & (T extends string ? { tag: "str" } : { tag: "other" });

// Function using conditional return type for checker integration tests
export declare function parseToString(input: string): string;
export declare function identity<T>(value: T): T;
