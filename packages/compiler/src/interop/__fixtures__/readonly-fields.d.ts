// Fixture for testing TypeScript readonly property mapping to EffectScript field mutability.

/** All readonly — maps to all-immutable EffectScript record. */
export interface AllReadonly {
  readonly x: number;
  readonly y: number;
}

/** No readonly — maps to all-mutable EffectScript record. */
export interface AllMutable {
  x: number;
  y: number;
}

/** Mixed readonly and mutable properties. */
export interface MixedReadonly {
  readonly id: string;
  name: string;
  readonly createdAt: number;
  updatedAt: number;
}

/** Readonly<T> passthrough — TypeScript evaluates to all-readonly. */
export interface MutableBase {
  host: string;
  port: number;
}

export type FrozenBase = Readonly<MutableBase>;

/** Export instances for type mapping. */
export declare const allReadonlyVal: AllReadonly;
export declare const allMutableVal: AllMutable;
export declare const mixedVal: MixedReadonly;
export declare const frozenVal: FrozenBase;
