// Class with static methods
export declare class Container<T> {
    value: T;
    constructor(value: T);
    getValue(): T;
    static create<U>(value: U): Container<U>;
    static empty(): Container<never>;
}

// Class without static members
export declare class Point {
    x: number;
    y: number;
    constructor(x: number, y: number);
}
