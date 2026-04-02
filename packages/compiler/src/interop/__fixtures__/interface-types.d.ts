// Simple interface with properties only
export interface Named {
  readonly name: string;
}

// Interface with methods
export interface Serializable {
  serialize(): string;
  deserialize(data: string): void;
}

// Interface with mixed properties and methods
export interface Collection<T> {
  readonly size: number;
  isEmpty(): boolean;
  contains(item: T): boolean;
}

// Interface extending another
export interface NamedEntity extends Named {
  readonly id: number;
}

// Mutable property (non-readonly)
export interface MutableConfig {
  name: string;
  readonly version: number;
}

// Interface with optional property
export interface Options {
  readonly host: string;
  readonly port?: number;
}

// Class with constructor (for class value type + instance type)
export declare class Command {
  readonly name: string;
  run(): void;
  constructor(name: string);
}

// Generic class
export declare class Container<T> {
  readonly value: T;
  constructor(value: T);
  get(): T;
}

// Class with static members
export declare class Factory {
  static create(): Factory;
  readonly id: number;
  constructor(id: number);
}

// Empty interface
export interface Marker {}

// Callable interface
export interface Logger {
  (message: string): void;
  level: string;
}

// Interface with this return type (fluent builder pattern)
export interface Builder {
  name(n: string): Builder;
  build(): string;
}

// Interface with overloaded methods
export interface Emitter {
  on(event: 'data', handler: (data: string) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
}

// Class with private constructor
export declare class Singleton {
  static getInstance(): Singleton;
  private constructor();
  readonly value: string;
}
