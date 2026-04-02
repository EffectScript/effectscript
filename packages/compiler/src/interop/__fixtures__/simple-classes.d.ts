export declare class Point {
  readonly x: number;
  readonly y: number;
  constructor(x: number, y: number);
  distanceTo(other: Point): number;
}

export declare class Singleton {
  static getInstance(): Singleton;
  private constructor();
  readonly value: string;
}
