export declare function identity<T>(value: T): T;
export declare function pair<A, B>(a: A, b: B): [A, B];
export declare function mapArray<T, U>(arr: T[], f: (item: T) => U): U[];

export declare class Container<T> {
  readonly value: T;
  constructor(value: T);
  map<U>(f: (value: T) => U): Container<U>;
}
