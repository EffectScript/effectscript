export interface Named {
  name: string;
}

export interface Aged {
  age: number;
}

export type Person = Named & Aged;

export declare const enum NumericColor {
  Red,
  Green,
  Blue,
}

export declare enum StringDirection {
  Up = "UP",
  Down = "DOWN",
  Left = "LEFT",
  Right = "RIGHT",
}

export declare enum MixedEnum {
  A = 0,
  B = "b",
}

export type ConditionalType<T> = T extends string ? number : boolean;
export type MappedType = { [K in "a" | "b"]: number };
