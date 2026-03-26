// Fixture: Large interface for lazy record resolution testing (P0-2)
// Simulates a large type surface like LoDashStatic or Express.Application

export interface LargeInterface {
  // 50+ properties to trigger lazy resolution threshold
  prop0: string;
  prop1: number;
  prop2: boolean;
  prop3: string;
  prop4: number;
  prop5: boolean;
  prop6: string;
  prop7: number;
  prop8: boolean;
  prop9: string;
  prop10: number;
  prop11: boolean;
  prop12: string;
  prop13: number;
  prop14: boolean;
  prop15: string;
  prop16: number;
  prop17: boolean;
  prop18: string;
  prop19: number;
  prop20: boolean;
  prop21: string;
  prop22: number;
  prop23: boolean;
  prop24: string;
  prop25: number;
  prop26: boolean;
  prop27: string;
  prop28: number;
  prop29: boolean;
  prop30: string;
  prop31: number;
  prop32: boolean;
  prop33: string;
  prop34: number;
  prop35: boolean;
  prop36: string;
  prop37: number;
  prop38: boolean;
  prop39: string;
  prop40: number;
  prop41: boolean;
  prop42: string;
  prop43: number;
  prop44: boolean;
  prop45: string;
  prop46: number;
  prop47: boolean;
  prop48: string;
  prop49: number;
  // Methods
  method0(x: string): number;
  method1(x: number, y: string): boolean;
  method2(): void;
  method3<T>(value: T): T;
  optionalProp?: string;
}

export declare const largeObj: LargeInterface;

// Small interface that should NOT use lazy resolution
export interface SmallInterface {
  name: string;
  age: number;
}

export declare const smallObj: SmallInterface;

// Interface with complex nested types (for testing lazy resolution depth)
export interface NestedLargeInterface {
  prop0: string;
  prop1: number;
  prop2: boolean;
  prop3: string;
  prop4: number;
  prop5: boolean;
  prop6: string;
  prop7: number;
  prop8: boolean;
  prop9: string;
  prop10: number;
  prop11: boolean;
  prop12: string;
  prop13: number;
  prop14: boolean;
  prop15: string;
  prop16: number;
  prop17: boolean;
  prop18: string;
  prop19: number;
  prop20: boolean;
  prop21: string;
  prop22: number;
  prop23: boolean;
  prop24: string;
  prop25: number;
  prop26: boolean;
  prop27: string;
  prop28: number;
  prop29: boolean;
  prop30: string;
  prop31: number;
  prop32: boolean;
  prop33: string;
  prop34: number;
  prop35: boolean;
  prop36: string;
  prop37: number;
  prop38: boolean;
  prop39: string;
  prop40: number;
  prop41: boolean;
  prop42: string;
  prop43: number;
  prop44: boolean;
  prop45: string;
  prop46: number;
  prop47: boolean;
  prop48: string;
  prop49: number;
  nested: SmallInterface;
  arrayProp: string[];
}

export declare const nestedLargeObj: NestedLargeInterface;

// Function that returns a large interface (for testing lazy resolution of return types)
export declare function createLargeObj(): LargeInterface;
