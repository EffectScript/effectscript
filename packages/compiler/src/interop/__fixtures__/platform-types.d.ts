// Fixture for platform type mapper tests

// Conditional type — should map to platform(Any, 'conditional')
export type ConditionalResult<T> = T extends string ? number : boolean;
export declare function getConditional(): ConditionalResult<unknown>;

// Substitution type — should map to platform(baseType, 'unmappable')
export type WithConstraint<T extends string> = T;

// Large interface for budget cap testing (>30 properties)
export interface LargeInterface {
  prop001: string;
  prop002: string;
  prop003: string;
  prop004: string;
  prop005: string;
  prop006: string;
  prop007: string;
  prop008: string;
  prop009: string;
  prop010: string;
  prop011: string;
  prop012: string;
  prop013: string;
  prop014: string;
  prop015: string;
  prop016: string;
  prop017: string;
  prop018: string;
  prop019: string;
  prop020: string;
  prop021: string;
  prop022: string;
  prop023: string;
  prop024: string;
  prop025: string;
  prop026: string;
  prop027: string;
  prop028: string;
  prop029: string;
  prop030: string;
  prop031: string;
  prop032: number;
  prop033: boolean;
  prop034: string;
  prop035: string;
}

export declare const large: LargeInterface;

// Recursive type similar to React's ReactNode
export type RecursiveNode = string | number | RecursiveNode[];

export declare function getNode(): RecursiveNode;

// Cross-cutting test: large interface with recursive + conditional properties
export interface CrossCuttingLarge {
  prop001: string;
  prop002: string;
  prop003: string;
  prop004: string;
  prop005: string;
  prop006: string;
  prop007: string;
  prop008: string;
  prop009: string;
  prop010: string;
  prop011: string;
  prop012: string;
  prop013: string;
  prop014: string;
  prop015: string;
  prop016: string;
  prop017: string;
  prop018: string;
  prop019: string;
  prop020: string;
  prop021: string;
  prop022: string;
  prop023: string;
  prop024: string;
  prop025: string;
  prop026: string;
  prop027: string;
  prop028: string;
  prop029: string;
  prop030: string;
  prop031: string;
  recursive: RecursiveNode;
  conditional: ConditionalResult<unknown>;
}

export declare const crossCutting: CrossCuttingLarge;
